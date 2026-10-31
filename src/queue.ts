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
import type { ParkedItem, QueueOrder, QueueState, SteeringItem } from './wire.ts'

/** Why an item is held: an explicit per-item pause or the queue-wide pause. */
export type PauseReason = 'manual' | 'global'

/** One message removed from the inbox and held by the plugin. */
export interface HeldItem {
  readonly message: UserMessage
  readonly reason: PauseReason
  /** Identity of the inbox item that followed this one when it was held. */
  readonly anchor: string | null
}

/** Per-Session pause state owned by the plugin while a queue or item is paused. */
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
    mutating: false,
  }
}

/** Whether the state holds nothing and holds no gate. */
export function isIdleState(state: QueueGateState): boolean {
  return !state.globalPaused
    && state.held.length === 0
    && !state.gateOpen
    && state.bypass === null
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
export function readQueueState(agent: Agent, state: QueueGateState | undefined): QueueState {
  return {
    available: true,
    paused: state?.globalPaused === true,
    parked: (state?.held ?? []).map(parkedItemOf),
    order: visibleOrder(agent, state),
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
 * Withdraw one steering message the model has not received yet.
 * A withdrawal is only possible before the running turn claims the message: it
 * then leaves `next-step` and rejoins the queue, so nothing ever reaches the
 * model and no notice is needed. A claimed message stays in the conversation.
 * @param agent - Agent owning the inbox.
 * @param state - per-Session queue state.
 * @param itemId - identity of the pending steering message.
 * @throws {@link ItemNotFoundError} when the message is not pending in `next-step`.
 */
export function revokeSteering(agent: Agent, state: QueueGateState, itemId: string): void {
  const index = agent.inbox.nextStep.findIndex(message => String(message.id) === itemId)
  if (index < 0) throw new ItemNotFoundError()
  const removed = agent.inbox.splice('next-step', index, 1, [])
  const message = removed[0]
  if (message !== undefined) requeueMessage(agent, state, message)
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
