/**
 * Pause state and reorder operations over the live Agent inbox. The panel shows
 * one linear order: paused rows are held by the plugin with the identity of the
 * row that follows them, and every mutation goes through `Inbox.splice`, so the
 * Session log, projections, and other clients observe the same durable order.
 * @module dsh-message-queue/queue
 */

import { randomUUID } from 'node:crypto'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { ParkedItem, QueueOrder, QueueState, SteeringItem } from './wire.ts'

/** Why an item is held: an explicit per-item pause or the queue-wide pause. */
type PauseReason = 'manual' | 'global'

/** One message removed from the inbox and held by the plugin. */
interface HeldItem {
  readonly message: UserMessage
  readonly reason: PauseReason
  /** Identity of the row that follows this one in the linear queue order. */
  anchor: string | null
}

/** Per-Session pause state owned by the plugin while a queue or item is paused. */
export interface QueueGateState {
  /** Whether the queue-wide pause keeps submissions out of the inbox. */
  globalPaused: boolean
  /** Messages held by a queue-wide or per-item pause, in linear order. */
  held: HeldItem[]
  /** Reentrancy guard around splices this module performs itself. */
  mutating: boolean
}

/** Create the empty pause state for one Session. */
export function createQueueGateState(): QueueGateState {
  return { globalPaused: false, held: [], mutating: false }
}

/** Whether the state no longer holds a pause or any parked row. */
export function isIdleState(state: QueueGateState): boolean {
  return !state.globalPaused && state.held.length === 0
}

/**
 * Drop the queue-wide pause once no pending message remains.
 * @param agent - Agent owning the queue.
 * @param state - per-Session queue state.
 * @returns whether the pause was cleared.
 */
export function clearPauseWhenEmpty(agent: Agent, state: QueueGateState): boolean {
  if (!state.globalPaused) return false
  if (state.held.length > 0 || agent.inbox.nextTurn.length > 0) return false
  state.globalPaused = false
  return true
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
 * Visible queue identity order: the inbox rows with held rows re-inserted
 * before the row each one recorded as its successor.
 * @param agent - Agent whose inbox is read.
 * @param state - per-Session pause state, absent when nothing is paused.
 * @returns the identity sequence the panel renders.
 */
export function visibleOrder(agent: Agent, state: QueueGateState | undefined): string[] {
  const order = agent.inbox.nextTurn.map(message => String(message.id))
  const waiting = [...(state?.held ?? [])]
  let progress = true
  while (waiting.length > 0 && progress) {
    progress = false
    for (let index = 0; index < waiting.length; index += 1) {
      const item = waiting[index] as HeldItem
      const id = String(item.message.id)
      if (item.anchor === null) {
        order.push(id)
      } else {
        const at = order.indexOf(item.anchor)
        if (at < 0) continue
        order.splice(at, 0, id)
      }
      waiting.splice(index, 1)
      index -= 1
      progress = true
    }
  }
  for (const item of waiting) order.push(String(item.message.id))
  return order
}

/**
 * Write one linear order back to the inbox and the held rows.
 * @param agent - Agent owning the inbox.
 * @param state - per-Session pause state, absent when nothing is held.
 * @param order - complete visible identity order.
 * @throws {@link ItemNotFoundError} when the order omits a pending message.
 */
function applyLinearOrder(agent: Agent, state: QueueGateState | undefined, order: readonly string[]): void {
  const held = state?.held ?? []
  const heldIds = new Set(held.map(item => String(item.message.id)))
  const inbox = [...agent.inbox.nextTurn]
  const byId = new Map(inbox.map(message => [String(message.id), message]))
  const nextInbox: UserMessage[] = []
  for (const id of order) {
    if (heldIds.has(id)) continue
    const message = byId.get(id)
    if (message === undefined) throw new ItemNotFoundError()
    nextInbox.push(message)
  }
  if (nextInbox.length !== byId.size) throw new ItemNotFoundError()
  const currentIds = inbox.map(message => String(message.id))
  if (currentIds.some((id, index) => id !== nextInbox[index]?.id)) {
    agent.inbox.splice('next-turn', 0, inbox.length, nextInbox)
  }
  for (const item of held) {
    const id = String(item.message.id)
    const at = order.indexOf(id)
    item.anchor = at >= 0 ? (order[at + 1] ?? null) : null
  }
  held.sort((left, right) => order.indexOf(String(left.message.id)) - order.indexOf(String(right.message.id)))
}

/** Count inbox rows that precede one held row in the linear order. */
function countInboxBefore(agent: Agent, order: readonly string[], itemId: string): number {
  const inboxIds = new Set(agent.inbox.nextTurn.map(message => String(message.id)))
  let count = 0
  for (const id of order) {
    if (id === itemId) break
    if (inboxIds.has(id)) count += 1
  }
  return count
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

/** Put one message back at the front of the queue (or the parked set while paused). */
function requeueMessage(agent: Agent, state: QueueGateState, message: UserMessage): void {
  if (state.globalPaused) {
    state.held.push({ message, reason: 'global', anchor: visibleOrder(agent, state)[0] ?? null })
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
 * Move one visible queue row to another visible index.
 * @param agent - Agent owning the queue.
 * @param state - per-Session pause state, absent when nothing is paused.
 * @param itemId - identity of the row to move.
 * @param toIndex - destination index in the linear order; clamped.
 * @returns the complete visible identity order after the move.
 * @throws {@link ItemNotFoundError} when the identity is neither held nor queued.
 */
export function moveQueueRow(
  agent: Agent,
  state: QueueGateState | undefined,
  itemId: string,
  toIndex: number,
): QueueOrder {
  const order = visibleOrder(agent, state)
  const from = order.indexOf(itemId)
  if (from < 0) throw new ItemNotFoundError()
  const target = Math.min(Math.max(Math.trunc(toIndex), 0), order.length - 1)
  const next = order.toSpliced(from, 1).toSpliced(target, 0, itemId)
  applyLinearOrder(agent, state, next)
  return { order: next }
}

/** Raised when a queue mutation names an item neither held nor pending. */
export class ItemNotFoundError extends Error {
  constructor() {
    super('queue item is no longer pending')
    this.name = 'ItemNotFoundError'
  }
}

/** Remove one inbox message and return it. */
function takeFromInbox(agent: Agent, index: number): UserMessage {
  const removed = agent.inbox.splice('next-turn', index, 1, [])
  const message = removed[0]
  if (message === undefined) throw new ItemNotFoundError()
  return message
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
 * Wake an idle driver after the plugin restored queued work.
 * @param agent - Agent whose queue received work.
 * @param state - pause state whose insert listener must ignore the probe.
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
 * Remove every queued turn from the inbox into the queue-wide pause.
 * @param agent - Agent owning the queue.
 * @param state - pause state receiving the held items.
 */
export function pauseAllItems(agent: Agent, state: QueueGateState): void {
  if (state.globalPaused) return
  state.globalPaused = true
  const inbox = [...agent.inbox.nextTurn]
  if (inbox.length === 0) return
  const order = visibleOrder(agent, state)
  const anchors = new Map<string, string | null>()
  for (let index = 0; index < order.length; index += 1) {
    anchors.set(order[index] as string, order[index + 1] ?? null)
  }
  state.mutating = true
  try {
    const removed = agent.inbox.splice('next-turn', 0, inbox.length, [])
    for (const message of removed) {
      const id = String(message.id)
      state.held.push({ message, reason: 'global', anchor: anchors.get(id) ?? null })
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
  const order = visibleOrder(agent, state)
  const inbox = [...agent.inbox.nextTurn]
  const inboxById = new Map(inbox.map(message => [String(message.id), message]))
  const globals = new Map<string, HeldItem>()
  for (const item of state.held) {
    if (item.reason === 'global') globals.set(String(item.message.id), item)
  }
  state.globalPaused = false
  state.held = state.held.filter(item => item.reason === 'manual')
  if (globals.size > 0) {
    const next: UserMessage[] = []
    for (const id of order) {
      const queued = inboxById.get(id)
      if (queued !== undefined) {
        next.push(queued)
      } else {
        const held = globals.get(id)
        if (held !== undefined) next.push(held.message)
      }
    }
    state.mutating = true
    try {
      agent.inbox.splice('next-turn', 0, inbox.length, next)
    } finally {
      state.mutating = false
    }
    applyLinearOrder(agent, state, order)
  }
  wakeQueue(agent, state)
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
  const order = visibleOrder(agent, state)
  const anchor = order[order.indexOf(itemId) + 1] ?? null
  state.mutating = true
  try {
    const message = takeFromInbox(agent, index)
    state.held.push({ message, reason: 'manual', anchor })
  } finally {
    state.mutating = false
  }
  wakeQueue(agent, state)
}

/**
 * Restore one held item to its own position in the queue.
 * @param agent - Agent owning the queue.
 * @param state - pause state holding the item.
 * @param itemId - identity of the held message.
 * @throws {@link ItemNotFoundError} when the message is not held.
 */
export function resumeOneItem(agent: Agent, state: QueueGateState, itemId: string): void {
  const index = state.held.findIndex(item => String(item.message.id) === itemId)
  if (index < 0) throw new ItemNotFoundError()
  const item = state.held[index] as HeldItem
  const order = visibleOrder(agent, state)
  const position = countInboxBefore(agent, order, itemId)
  const inbox = [...agent.inbox.nextTurn]
  state.mutating = true
  try {
    state.held.splice(index, 1)
    agent.inbox.splice('next-turn', Math.min(position, inbox.length), 0, [item.message])
  } finally {
    state.mutating = false
  }
  applyLinearOrder(agent, state, order)
  wakeQueue(agent, state)
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
 * Send one row immediately, out of queue order.
 * A running turn receives it as steering; an idle Agent gets it as the next
 * message, which means it moves to the head of the inbox and is claimed first.
 * @param agent - Agent owning the queue.
 * @param state - per-Session pause state, absent when nothing is paused.
 * @param itemId - identity of the row to send, held or queued.
 * @throws {@link ItemNotFoundError} when the identity is neither held nor queued.
 */
export function sendNowItem(agent: Agent, state: QueueGateState | undefined, itemId: string): void {
  const heldIndex = state?.held.findIndex(item => String(item.message.id) === itemId) ?? -1
  let message: UserMessage
  if (heldIndex >= 0) {
    message = (state as QueueGateState).held.splice(heldIndex, 1)[0]?.message as UserMessage
  } else {
    const index = agent.inbox.nextTurn.findIndex(item => String(item.id) === itemId)
    if (index < 0) throw new ItemNotFoundError()
    message = takeFromInbox(agent, index)
  }
  if (agent.status === 'running') {
    agent.steer(message)
    return
  }
  const order = visibleOrder(agent, state)
  if (state !== undefined) state.mutating = true
  try {
    agent.inbox.splice('next-turn', 0, 0, [message])
  } finally {
    if (state !== undefined) state.mutating = false
  }
  applyLinearOrder(agent, state, [String(message.id), ...order])
  wakeQueue(agent, state)
}
