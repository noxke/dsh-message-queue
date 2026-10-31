/**
 * Pause state and reorder operations over the live Agent inbox. Queued items
 * stay in the inbox; paused items are held by the plugin. Every mutation goes
 * through `Inbox.splice`, so the Session log, projections, and other clients
 * observe the same durable order.
 * @module dsh-message-queue/queue
 */

import { randomUUID } from 'node:crypto'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionSeq } from '@deepseek-ai/dsh-session'
import { REVOKE_WINDOW_MS } from './wire.ts'
import type { ParkedItem, QueueOrder, QueueState, SentItem, SteeringItem } from './wire.ts'

/** Why an item is held: an explicit per-item pause or the queue-wide pause. */
export type PauseReason = 'manual' | 'global'

/** One message removed from the inbox and held by the plugin. */
export interface HeldItem {
  readonly message: UserMessage
  readonly reason: PauseReason
  /** Identity of the inbox item that followed this one when it was held. */
  readonly anchor: string | null
}

/** Recent sent messages kept for withdrawal, newest last. */
const MAX_SENT_ITEMS = 5
/** How long an undelivered withdrawal waits for a late delivery to appear. */
const TOMBSTONE_TTL_MS = 60_000
/** Withdrawals waiting for a message that may still be delivered. */
const MAX_TOMBSTONES = 8

/** One recently sent message plus the surface seq it landed at, when known. */
export interface SentRecord {
  readonly message: UserMessage
  readonly turn: number
  /** Log seq of the message's model-visible `user/message` event, or null. */
  seq: number | null
  /** Wall-clock time the message left the queue. */
  readonly claimedAt: number
}

/** Model-facing text that replaces a withdrawn message in future requests. */
export const REVOKED_NOTICE = 'The user withdrew their previous message. Disregard its content and do not act on it.'

/** Per-Session pause state owned by the plugin while a queue or item is paused. */
/** One withdrawal of a claimed message that had not reached the model yet. */
export interface RevokeTombstone {
  /** Identity the model may still receive. */
  readonly originalId: string
  /** Identity of the queue copy that replaced the withdrawn send. */
  readonly requeuedId: string
  /** Wall-clock time the withdrawal happened. */
  readonly createdAt: number
}

export interface QueueGateState {
  /** Whether the queue-wide pause holds automatic sending. */
  globalPaused: boolean
  /** Messages held by a queue-wide or per-item pause, in visible order. */
  held: HeldItem[]
  /** Resolves the maintenance task holding the Agent at its idle boundary. */
  release: (() => void) | undefined
  gateOpen: boolean
  /** Held item whose explicit resume must claim the next turn despite the pause. */
  bypass: string | null
  /** Recently sent messages the panel can still withdraw. */
  sent: SentRecord[]
  /** Undelivered withdrawals still waiting for a possible late delivery. */
  tombstones: RevokeTombstone[]
  /** Reentrancy guard around splices this module performs itself. */
  mutating: boolean
}

/** Create the empty pause state for one Session. */
export function createQueueGateState(): QueueGateState {
  return {
    globalPaused: false,
    held: [],
    release: undefined,
    gateOpen: false,
    bypass: null,
    sent: [],
    tombstones: [],
    mutating: false,
  }
}

/** Whether the state holds nothing and holds no gate. */
export function isIdleState(state: QueueGateState): boolean {
  return !state.globalPaused
    && state.held.length === 0
    && !state.gateOpen
    && state.bypass === null
    && state.sent.length === 0
    && state.tombstones.length === 0
}

/** Project one live message to its wire queue item. */
function parkedItemOf(item: HeldItem): ParkedItem {
  return {
    id: String(item.message.id),
    content: item.message.content as unknown as unknown[],
    reason: item.reason,
  }
}

/**
 * Visible queue identity order: held items first, then the inbox's pending turns.
 * @param agent - Agent whose inbox is read.
 * @param state - per-Session pause state, absent when nothing is paused.
 * @returns the identity sequence the panel renders.
 */
export function visibleOrder(agent: Agent, state: QueueGateState | undefined): string[] {
  return [
    ...(state?.held ?? []).map(item => String(item.message.id)),
    ...agent.inbox.nextTurn.map(message => String(message.id)),
  ]
}

/**
 * Read the queue state of one Agent, optionally including held items.
 * @param agent - Agent whose inbox is the queue.
 * @param state - per-Session pause state, absent when nothing is paused.
 * @returns the wire projection of the queue.
 */
export function readQueueState(
  agent: Agent,
  state: QueueGateState | undefined,
  now: number = Date.now(),
): QueueState {
  return {
    available: true,
    paused: state?.globalPaused === true,
    parked: (state?.held ?? []).map(parkedItemOf),
    order: visibleOrder(agent, state),
    sent: (state?.sent ?? [])
      .map(record => sentItemOf(record, now))
      .filter((item): item is SentItem => item !== undefined),
    steering: agent.inbox.nextStep.filter(isUserComposed).map(steeringItemOf),
  }
}

/** Whether a message was composed by the user rather than injected by a plugin. */
function isUserComposed(message: UserMessage): boolean {
  return message.source.kind === 'user'
}

/** Project one pending steering message to its wire item. */
function steeringItemOf(message: UserMessage): SteeringItem {
  return {
    id: String(message.id),
    content: message.content as unknown as unknown[],
  }
}

/**
 * Withdraw one message before a turn claims it.
 * A still-pending steering message leaves `next-step` and rejoins the queue;
 * nothing reaches the model, so no withdrawal notice is written.
 * @param agent - Agent owning the inbox.
 * @param state - per-Session queue state.
 * @param itemId - identity of the pending steering message.
 * @returns whether the withdrawal came from the pending steering set.
 * @throws {@link ItemNotFoundError} when the message is not pending in `next-step`.
 */
export function revokePendingSteering(agent: Agent, state: QueueGateState, itemId: string): boolean {
  const index = agent.inbox.nextStep.findIndex(message => String(message.id) === itemId)
  if (index < 0) return false
  const removed = agent.inbox.splice('next-step', index, 1, [])
  const message = removed[0]
  if (message !== undefined) requeueMessage(agent, state, message)
  return true
}

/** Project one sent record to its wire item while its window is open. */
function sentItemOf(record: SentRecord, now: number): SentItem | undefined {
  const remainingMs = REVOKE_WINDOW_MS - (now - record.claimedAt)
  if (remainingMs <= 0) return undefined
  return {
    id: String(record.message.id),
    content: record.message.content as unknown as unknown[],
    turn: record.turn,
    delivered: record.seq !== null,
    remainingMs,
  }
}

/**
 * Drop sent records whose withdrawal window has closed.
 * @param state - per-Session queue state.
 * @param now - wall-clock time to measure against.
 */
export function dropExpiredSent(state: QueueGateState, now: number = Date.now()): void {
  state.sent = state.sent.filter(record => now - record.claimedAt < REVOKE_WINDOW_MS)
}

/**
 * Drop withdrawals that waited too long for a delivery that never came.
 * @param state - per-Session queue state.
 * @param now - wall-clock time to measure against.
 */
export function dropExpiredTombstones(state: QueueGateState, now: number = Date.now()): void {
  state.tombstones = state.tombstones.filter(item => now - item.createdAt < TOMBSTONE_TTL_MS)
}

/**
 * Remember one message a turn just claimed.
 * @param state - per-Session queue state.
 * @param message - claimed message.
 * @param turn - turn that claimed it.
 */
export function recordClaimedItem(
  state: QueueGateState,
  message: UserMessage,
  turn: number,
  claimedAt: number = Date.now(),
): void {
  state.sent.push({ message, turn, seq: null, claimedAt })
  while (state.sent.length > MAX_SENT_ITEMS) state.sent.shift()
}

/**
 * Mark a sent message as model-visible once its `user/message` event lands.
 * @param state - per-Session queue state.
 * @param messageId - identity of the delivered message.
 * @param seq - log seq of the model-visible message event.
 */
export function recordDeliveredItem(state: QueueGateState, messageId: MessageId, seq: number): void {
  const record = state.sent.findLast(item => item.seq === null && item.message.id === messageId)
  if (record !== undefined) record.seq = seq
}

/** Put one message back at the front of the queue (or the held set while paused). */
function requeueMessage(agent: Agent, state: QueueGateState, message: UserMessage): void {
  if (state.globalPaused) {
    state.held.push({ message, reason: 'global', anchor: null })
    return
  }
  state.mutating = true
  try {
    agent.inbox.splice('next-turn', 0, 0, [message])
  } finally {
    state.mutating = false
  }
  wakeQueue(agent, state)
}

/**
 * Withdraw one recently sent message.
 * Undelivered messages return to the queue unchanged. Delivered messages gain a
 * model-visible replacement that tells the model the text was withdrawn, then
 * their content returns to the queue as a fresh message.
 * @param agent - Agent owning the queue.
 * @param state - per-Session queue state holding the sent record.
 * @param itemId - identity of the sent message.
 * @param notice - model-facing withdrawal text.
 * @returns how the message was withdrawn.
 * @throws {@link ItemNotFoundError} when the message is not in the recent list.
 */
export function revokeSentItem(
  agent: Agent,
  state: QueueGateState,
  itemId: string,
  notice: string,
  now: number = Date.now(),
): 'requeued' | 'replaced' {
  const index = state.sent.findIndex(item => String(item.message.id) === itemId)
  if (index < 0) throw new ItemNotFoundError()
  const record = state.sent[index] as SentRecord
  if (now - record.claimedAt >= REVOKE_WINDOW_MS) throw new RevokeExpiredError()
  state.sent.splice(index, 1)
  const requeued = cloneForRequeue(record.message)
  dropExpiredTombstones(state, now)
  if (record.seq === null) {
    // The claim may still deliver this message to the model. Keep the original
    // identity on watch so a late delivery gains a withdrawal notice and the
    // queue copy is dropped instead of running twice.
    requeueMessage(agent, state, requeued)
    state.tombstones.push({
      originalId: String(record.message.id),
      requeuedId: String(requeued.id),
      createdAt: now,
    })
    while (state.tombstones.length > MAX_TOMBSTONES) state.tombstones.shift()
    return 'requeued'
  }
  appendWithdrawal(agent, record.seq, notice)
  notifyWithdrawal(agent, notice)
  requeueMessage(agent, state, requeued)
  return 'replaced'
}

/** Build the plugin-owned notice message used for withdrawals and wake probes. */
function noticeMessage(text: string): UserMessage {
  return {
    id: randomUUID() as unknown as MessageId,
    role: 'user',
    content: [{ type: 'text', text }],
    // A plugin-owned producer kind keeps this row out of the user's own sends.
    source: { kind: 'runtime-context' } as unknown as UserMessage['source'],
  }
}

/**
 * Deliver a withdrawal notice to a turn that is already running.
 * The surface replacement rewrites history for later requests; a steering
 * message makes the running turn see the notice at its next step boundary,
 * because a steering insert re-opens the stopping turn instead of closing it.
 * @param agent - Agent whose turn should learn about the withdrawal.
 * @param notice - model-facing withdrawal text.
 * @returns whether the notice was steered into the running turn.
 */
function notifyWithdrawal(agent: Agent, notice: string): boolean {
  if (agent.status !== 'running') return false
  agent.steer(noticeMessage(notice))
  return true
}

/** Copy one message for re-sending under a fresh identity. */
function cloneForRequeue(message: UserMessage): UserMessage {
  return {
    ...message,
    id: randomUUID() as unknown as MessageId,
    source: { kind: 'user' } as UserMessage['source'],
  }
}

/** Append the model-visible replacement that withdraws one delivered message. */
function appendWithdrawal(agent: Agent, seq: number, notice: string): void {
  const target = seq as unknown as SessionSeq
  const replacement: UserMessage = {
    id: randomUUID() as unknown as MessageId,
    role: 'user',
    content: [{ type: 'text', text: notice }],
    source: { kind: 'runtime-context' } as unknown as UserMessage['source'],
  }
  agent.session.append('user/message', replacement, {
    surfaceOp: { op: 'replace', startSeq: target, endSeq: target },
    sourceEventSeqs: [target],
  })
}

/** Remove one pending queue copy wherever it currently waits. */
function dropPendingCopy(agent: Agent, state: QueueGateState, id: string): boolean {
  const nextTurn = agent.inbox.nextTurn.findIndex(message => String(message.id) === id)
  if (nextTurn >= 0) {
    agent.inbox.splice('next-turn', nextTurn, 1, [])
    return true
  }
  const nextStep = agent.inbox.nextStep.findIndex(message => String(message.id) === id)
  if (nextStep >= 0) {
    agent.inbox.splice('next-step', nextStep, 1, [])
    return true
  }
  const held = state.held.findIndex(item => String(item.message.id) === id)
  if (held >= 0) {
    state.held.splice(held, 1)
    return true
  }
  return false
}

/**
 * Apply a withdrawal whose original message reached the model after the user
 * already withdrew it. The late delivery gains the replacement notice and the
 * queue copy that stood in for it is removed.
 * @param agent - Agent owning the Session.
 * @param state - per-Session queue state.
 * @param messageId - identity of the message that just entered the surface.
 * @param seq - log seq of its model-visible event.
 * @param notice - model-facing withdrawal text.
 * @returns whether a pending withdrawal handled this delivery.
 */
export function applyLateDelivery(
  agent: Agent,
  state: QueueGateState,
  messageId: MessageId,
  seq: number,
  notice: string,
): boolean {
  const index = state.tombstones.findIndex(item => item.originalId === String(messageId))
  if (index < 0) return false
  const tombstone = state.tombstones.splice(index, 1)[0] as RevokeTombstone
  appendWithdrawal(agent, seq, notice)
  notifyWithdrawal(agent, notice)
  dropPendingCopy(agent, state, tombstone.requeuedId)
  return true
}

/**
 * Withdraw one sent or pending-steering message.
 * Pending steering rows are removed without a model notice and without a time
 * limit; claimed messages keep the delivery-aware behavior and 15s window.
 * @param agent - Agent owning the queue.
 * @param state - per-Session queue state.
 * @param itemId - identity of the message to withdraw.
 * @param notice - model-facing withdrawal text for delivered messages.
 * @param now - wall-clock time for the claimed-message window.
 * @returns how the message was withdrawn.
 * @throws {@link ItemNotFoundError} when the message is neither pending nor recent.
 */
export function revokeItem(
  agent: Agent,
  state: QueueGateState,
  itemId: string,
  notice: string,
  now: number = Date.now(),
): 'steering' | 'requeued' | 'replaced' {
  if (revokePendingSteering(agent, state, itemId)) return 'steering'
  return revokeSentItem(agent, state, itemId, notice, now)
}

/**
 * Move one visible queue row inside its own group.
 * @param agent - Agent owning the queue.
 * @param state - per-Session pause state, absent when nothing is paused.
 * @param itemId - identity of the row to move.
 * @param toIndex - destination index inside the row's own group; clamped.
 * @returns the complete visible identity order after the move.
 * @throws {@link ItemNotFoundError} when the identity is neither held nor queued.
 */
export function moveQueueRow(
  agent: Agent,
  state: QueueGateState | undefined,
  itemId: string,
  toIndex: number,
): QueueOrder {
  const held = state?.held ?? []
  const heldIndex = held.findIndex(item => String(item.message.id) === itemId)
  if (heldIndex >= 0) {
    const target = Math.min(Math.max(Math.trunc(toIndex), 0), held.length - 1)
    const moved = held[heldIndex] as HeldItem
    held.splice(heldIndex, 1)
    held.splice(target, 0, moved)
    return { order: visibleOrder(agent, state) }
  }
  const current = [...agent.inbox.nextTurn]
  const from = current.findIndex(message => String(message.id) === itemId)
  if (from < 0) throw new ItemNotFoundError()
  const target = Math.min(Math.max(Math.trunc(toIndex), 0), current.length - 1)
  const moved = current[from] as UserMessage
  const order = current.toSpliced(from, 1).toSpliced(target, 0, moved)
  agent.inbox.splice('next-turn', 0, current.length, order)
  return { order: visibleOrder(agent, state) }
}

/** Raised when a queue mutation names an item neither held nor pending. */
export class ItemNotFoundError extends Error {
  constructor() {
    super('queue item is no longer pending')
    this.name = 'ItemNotFoundError'
  }
}

/** Raised when a withdrawal arrives after its window closed. */
export class RevokeExpiredError extends Error {
  constructor() {
    super('withdrawal window has closed')
    this.name = 'RevokeExpiredError'
  }
}

/** Raised when steering a held item has no running turn to accept it. */
export class SteerUnavailableError extends Error {
  constructor() {
    super('no running turn accepts steering')
    this.name = 'SteerUnavailableError'
  }
}

/** Anchor for an item about to leave `inbox` at `index`. */
function anchorAfter(inbox: readonly UserMessage[], index: number): string | null {
  const next = inbox[index + 1]
  return next === undefined ? null : String(next.id)
}

/** Remove one inbox message and return it with its anchor. */
function takeFromInbox(agent: Agent, index: number): UserMessage {
  const removed = agent.inbox.splice('next-turn', index, 1, [])
  const message = removed[0]
  if (message === undefined) throw new ItemNotFoundError()
  return message
}

/**
 * Put one held item back into the inbox.
 * @param agent - Agent owning the inbox.
 * @param item - held item carrying its anchor.
 * @param front - insert at the head instead of the stored position.
 * @returns whether the item was inserted ahead of the queue.
 */
function restoreIntoInbox(agent: Agent, item: HeldItem, front: boolean): boolean {
  const inbox = agent.inbox.nextTurn
  let index = inbox.length
  if (front) {
    index = 0
  } else if (item.anchor !== null) {
    const anchorIndex = inbox.findIndex(message => String(message.id) === item.anchor)
    if (anchorIndex >= 0) index = anchorIndex
  }
  agent.inbox.splice('next-turn', index, 0, [item.message])
  return index === 0
}

/**
 * Send one probe message that sets the driver's wake latch, then remove it.
 * @param agent - Agent to wake.
 * @param state - pause state whose insert listener must ignore the probe.
 */
function latchWake(agent: Agent, state?: QueueGateState): void {
  if (agent.inbox.nextTurn.length === 0) return
  const probe: UserMessage = {
    id: randomUUID() as unknown as MessageId,
    role: 'user',
    content: [{ type: 'text', text: '' }],
    // An unknown producer kind keeps the probe out of user-message presentation
    // paths; it is removed before the projection is ever read.
    source: { kind: 'runtime-context' } as unknown as UserMessage['source'],
  }
  if (state !== undefined) state.mutating = true
  try {
    agent.send(probe, 'next-turn', true)
    agent.inbox.remove(probe.id)
  } finally {
    if (state !== undefined) state.mutating = false
  }
}

/**
 * Wake an idle driver after the plugin restored queued work. The probe message
 * sets the maintenance wake latch; settling the task replays it.
 * @param agent - Agent whose queue received work.
 */
export function wakeQueue(agent: Agent, state?: QueueGateState): void {
  if (agent.status !== 'idle') return
  if (agent.inbox.nextTurn.length === 0) return
  try {
    void agent.runMaintenance(async () => { latchWake(agent, state) }).catch(() => {
      // The Agent was cancelled or disposed while the task was parked.
    })
  } catch {
    // Another activity owns the Agent; it will claim the queue itself.
  }
}

/**
 * Hold the Agent at its idle boundary so waking input never opens a turn.
 * @param agent - Agent to hold; must currently be idle.
 * @param state - pause state owning the release handle.
 */
export function openQueueGate(agent: Agent, state: QueueGateState): void {
  if (state.gateOpen) return
  state.gateOpen = true
  try {
    void agent.runMaintenance(signal => new Promise<void>((resolve, reject) => {
      state.release = resolve
      signal.addEventListener('abort', () => { reject(signal.reason) }, { once: true })
    })).catch(() => {
      // Rejection is the abort path: the Agent is being cancelled or disposed.
    })
  } catch (error: unknown) {
    state.gateOpen = false
    throw error
  }
}

/**
 * Release the maintenance gate and replay its wake latch.
 * @param agent - Agent owning the gate.
 * @param state - pause state holding the release handle.
 */
export function releaseQueueGate(agent: Agent, state: QueueGateState): void {
  if (!state.gateOpen) {
    wakeQueue(agent, state)
    return
  }
  latchWake(agent, state)
  const release = state.release
  state.release = undefined
  state.gateOpen = false
  release?.()
}

/**
 * Remove every queued turn from the inbox into the queue-wide pause.
 * @param agent - Agent owning the queue.
 * @param state - pause state receiving the held items.
 */
export function pauseAllItems(agent: Agent, state: QueueGateState): void {
  if (state.globalPaused) return
  state.globalPaused = true
  state.bypass = null
  const inbox = [...agent.inbox.nextTurn]
  if (inbox.length === 0) return
  state.mutating = true
  try {
    const removed = agent.inbox.splice('next-turn', 0, inbox.length, [])
    for (let index = 0; index < removed.length; index += 1) {
      state.held.push({
        message: removed[index] as UserMessage,
        reason: 'global',
        anchor: anchorAfter(removed, index),
      })
    }
  } finally {
    state.mutating = false
  }
}

/**
 * Clear the queue-wide pause and restore only the items it held.
 * @param agent - Agent owning the queue.
 * @param state - pause state being reduced to per-item pauses.
 */
export function resumeAllItems(agent: Agent, state: QueueGateState): void {
  if (!state.globalPaused) return
  state.globalPaused = false
  state.bypass = null
  const globals = state.held.filter(item => item.reason === 'global')
  state.held = state.held.filter(item => item.reason === 'manual')
  if (globals.length > 0) {
    state.mutating = true
    try {
      agent.inbox.splice('next-turn', 0, 0, globals.map(item => item.message))
    } finally {
      state.mutating = false
    }
  }
  releaseQueueGate(agent, state)
}

/**
 * Hold one queued item without pausing the whole queue.
 * @param agent - Agent owning the queue.
 * @param state - pause state receiving the held item.
 * @param itemId - identity of the queued message.
 * @throws {@link ItemNotFoundError} when the message is not queued.
 */
export function pauseOneItem(agent: Agent, state: QueueGateState, itemId: string): void {
  const inbox = [...agent.inbox.nextTurn]
  const index = inbox.findIndex(message => String(message.id) === itemId)
  if (index < 0) throw new ItemNotFoundError()
  state.mutating = true
  try {
    const message = takeFromInbox(agent, index)
    state.held.push({ message, reason: 'manual', anchor: anchorAfter(inbox, index) })
  } finally {
    state.mutating = false
  }
}

/**
 * Restore one held item to the queue. Under a queue-wide pause this sends the
 * item immediately; otherwise it returns to its stored queue position.
 * @param agent - Agent owning the queue.
 * @param state - pause state holding the item.
 * @param itemId - identity of the held message.
 * @throws {@link ItemNotFoundError} when the message is not held.
 */
export function resumeOneItem(agent: Agent, state: QueueGateState, itemId: string): void {
  const index = state.held.findIndex(item => String(item.message.id) === itemId)
  if (index < 0) throw new ItemNotFoundError()
  const item = state.held.splice(index, 1)[0] as HeldItem
  const sendNow = state.globalPaused
  state.mutating = true
  try {
    restoreIntoInbox(agent, item, sendNow)
  } finally {
    state.mutating = false
  }
  if (!sendNow) {
    wakeQueue(agent, state)
    return
  }
  state.bypass = String(item.message.id)
  if (state.gateOpen) {
    releaseQueueGate(agent, state)
    return
  }
  wakeQueue(agent, state)
}

/**
 * Clear the bypass marker when its item has been claimed.
 * @param state - pause state owning the marker.
 * @param messageId - identity of the message a turn claimed.
 */
export function noteClaimedItem(state: QueueGateState | undefined, messageId: MessageId): void {
  if (state?.bypass !== undefined && state.bypass === String(messageId)) state.bypass = null
}

/**
 * Park a message submitted while the queue-wide pause is active.
 * @param agent - Agent owning the inbox.
 * @param state - pause state receiving the item.
 * @param messageId - identity of the inserted message.
 * @returns whether the message was moved out of the inbox.
 */
export function parkIncomingItem(agent: Agent, state: QueueGateState, messageId: MessageId): boolean {
  if (!state.globalPaused || state.mutating) return false
  const index = agent.inbox.nextTurn.findIndex(message => message.id === messageId)
  if (index < 0) return false
  state.mutating = true
  try {
    const message = takeFromInbox(agent, index)
    state.held.push({ message, reason: 'global', anchor: null })
  } finally {
    state.mutating = false
  }
  return true
}

/** Locate one held item. */
function requireHeld(state: QueueGateState | undefined, itemId: string): { held: HeldItem[]; index: number } {
  if (state === undefined) throw new ItemNotFoundError()
  const index = state.held.findIndex(item => String(item.message.id) === itemId)
  if (index < 0) throw new ItemNotFoundError()
  return { held: state.held, index }
}

/**
 * Replace one held item's text in place, preserving its identity and source.
 * @param state - per-Session pause state.
 * @param itemId - identity of the held row.
 * @param text - non-empty replacement text.
 * @throws {@link ItemNotFoundError} when the row is not held.
 */
export function editHeldItem(state: QueueGateState | undefined, itemId: string, text: string): void {
  const { held, index } = requireHeld(state, itemId)
  const current = held[index] as HeldItem
  held[index] = { ...current, message: { ...current.message, content: [{ type: 'text', text }] } }
}

/**
 * Drop one held item.
 * @param state - per-Session pause state.
 * @param itemId - identity of the held row.
 * @throws {@link ItemNotFoundError} when the row is not held.
 */
export function removeHeldItem(state: QueueGateState | undefined, itemId: string): void {
  const { held, index } = requireHeld(state, itemId)
  held.splice(index, 1)
}

/**
 * Send one held item into the running turn ahead of the queue.
 * @param agent - Agent owning the queue.
 * @param state - per-Session pause state.
 * @param itemId - identity of the held row.
 * @throws {@link ItemNotFoundError} when the row is not held.
 * @throws {@link SteerUnavailableError} when no turn is running.
 */
export function steerHeldItem(agent: Agent, state: QueueGateState | undefined, itemId: string): void {
  const { held, index } = requireHeld(state, itemId)
  if (agent.status !== 'running') throw new SteerUnavailableError()
  const [item] = held.splice(index, 1)
  if (item !== undefined) agent.steer(item.message)
}
