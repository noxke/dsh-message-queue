/**
 * Pause gate and reorder operations over the live Agent inbox. Every mutation
 * goes through `Inbox.splice`, so the Session log, projections, and other
 * clients observe the same durable order.
 * @module dsh-message-queue/queue
 */

import { randomUUID } from 'node:crypto'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { ParkedItem, QueueOrder, QueueState } from './wire.ts'

/** Per-Session pause state owned by the plugin while a queue is paused. */
export interface QueueGateState {
  paused: boolean
  /** Queue items removed from the inbox while paused, in queue order. */
  parked: UserMessage[]
  /** Resolves the maintenance task holding the Agent at its idle boundary. */
  release: (() => void) | undefined
  gateOpen: boolean
  /** Reentrancy guard around splices this module performs itself. */
  mutating: boolean
}

/** Create the empty pause state for one Session. */
export function createQueueGateState(): QueueGateState {
  return { paused: false, parked: [], release: undefined, gateOpen: false, mutating: false }
}

/** Project one live message to its wire queue item. */
function parkedItemOf(message: UserMessage): ParkedItem {
  return {
    id: String(message.id),
    content: message.content as unknown as unknown[],
  }
}

/**
 * Visible queue identity order: items held by the pause gate first, then the
 * inbox's pending turns.
 * @param agent - Agent whose inbox is read.
 * @param state - per-Session pause state, absent when the queue is not paused.
 * @returns the identity sequence the panel renders.
 */
export function visibleOrder(agent: Agent, state: QueueGateState | undefined): string[] {
  const parked = state?.parked ?? []
  return [
    ...parked.map(message => String(message.id)),
    ...agent.inbox.nextTurn.map(message => String(message.id)),
  ]
}

/**
 * Read the queue state of one Agent, optionally including a live pause gate.
 * @param agent - Agent whose inbox is the queue.
 * @param state - per-Session pause state, absent when the queue is not paused.
 * @returns the wire projection of the queue.
 */
export function readQueueState(agent: Agent, state: QueueGateState | undefined): QueueState {
  const parked = state?.parked ?? []
  return {
    available: true,
    paused: state?.paused === true,
    parked: parked.map(parkedItemOf),
    order: visibleOrder(agent, state),
  }
}

/**
 * Move one visible queue row. A held (parked) item moves inside the held list;
 * a pending turn moves inside `next-turn`. Cross-group moves are rejected by
 * the panel, which keeps each index inside its own group.
 * @param agent - Agent owning the queue.
 * @param state - per-Session pause state, absent when the queue is not paused.
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
  const held = state?.paused === true ? state.parked : []
  const heldIndex = held.findIndex(message => String(message.id) === itemId)
  if (heldIndex >= 0) {
    const target = Math.min(Math.max(Math.trunc(toIndex), 0), held.length - 1)
    const moved = held[heldIndex] as UserMessage
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

/** Locate one held item and require the pause state to exist. */
function requireHeld(state: QueueGateState | undefined, itemId: string): { held: UserMessage[]; index: number } {
  if (state === undefined) throw new ItemNotFoundError()
  const held = state.parked
  const index = held.findIndex(message => String(message.id) === itemId)
  if (index < 0) throw new ItemNotFoundError()
  return { held, index }
}

/**
 * Replace one held item's text in place, preserving its identity and source.
 * @param state - per-Session pause state.
 * @param itemId - identity of the held row.
 * @param text - non-empty replacement text.
 * @throws {@link ItemNotFoundError} when the row is not held.
 */
export function editParkedItem(state: QueueGateState | undefined, itemId: string, text: string): void {
  const { held, index } = requireHeld(state, itemId)
  const current = held[index] as UserMessage
  held[index] = { ...current, content: [{ type: 'text', text }] }
}

/**
 * Drop one held item.
 * @param state - per-Session pause state.
 * @param itemId - identity of the held row.
 * @throws {@link ItemNotFoundError} when the row is not held.
 */
export function removeParkedItem(state: QueueGateState | undefined, itemId: string): void {
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
export function steerParkedItem(agent: Agent, state: QueueGateState | undefined, itemId: string): void {
  const { held, index } = requireHeld(state, itemId)
  if (agent.status !== 'running') throw new SteerUnavailableError()
  const [message] = held.splice(index, 1)
  if (message !== undefined) agent.steer(message)
}

/**
 * Remove every currently queued turn from the inbox into the pause state.
 * @param agent - Agent owning the queue.
 * @param state - pause state receiving the parked items.
 */
export function parkQueuedTurns(agent: Agent, state: QueueGateState): void {
  const queued = agent.inbox.nextTurn
  if (queued.length === 0) return
  state.mutating = true
  try {
    const removed = agent.inbox.splice('next-turn', 0, queued.length, [])
    state.parked.push(...removed)
  } finally {
    state.mutating = false
  }
}

/**
 * Park one message inserted while a running turn has not yet reached its
 * boundary. Without this, the boundary sees pending work and opens the next
 * turn before the pause gate can hold the Agent.
 * @param agent - Agent owning the inbox.
 * @param state - pause state for that Agent.
 * @param messageId - identity of the message just inserted.
 */
export function parkInsertedMessage(agent: Agent, state: QueueGateState, messageId: MessageId): void {
  if (!state.paused || state.gateOpen || state.mutating) return
  if (agent.status !== 'running') return
  const index = agent.inbox.nextTurn.findIndex(message => message.id === messageId)
  if (index < 0) return
  state.mutating = true
  try {
    const removed = agent.inbox.splice('next-turn', index, 1, [])
    state.parked.push(...removed)
  } finally {
    state.mutating = false
  }
}

/**
 * Hold the Agent at its idle boundary so waking input stays queued instead of
 * opening a turn. The maintenance task settles only when resume releases it or
 * the Agent aborts (cancel or disposal).
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
 * Restore parked items at the front of the queue and release the gate.
 * @param agent - Agent owning the queue.
 * @param state - pause state being closed.
 */
export function closeQueueGate(agent: Agent, state: QueueGateState): void {
  state.paused = false
  const parked = state.parked
  state.parked = []
  if (parked.length > 0) agent.inbox.splice('next-turn', 0, 0, parked)
  if (!state.gateOpen) return
  wakeQueue(agent)
  const release = state.release
  state.release = undefined
  state.gateOpen = false
  release?.()
}

/**
 * Wake the driver while the gate is still open. `runMaintenance` replays only a
 * latched wake after the task settles, so a probe message is inserted and
 * removed synchronously: it sets the latch and is never claimable.
 * @param agent - Agent whose gate is about to be released.
 */
function wakeQueue(agent: Agent): void {
  if (agent.inbox.nextTurn.length === 0) return
  const probe: UserMessage = {
    id: randomUUID() as unknown as MessageId,
    role: 'user',
    content: [{ type: 'text', text: '' }],
    // An unknown producer kind keeps the probe out of user-message presentation
    // paths; it is removed before the projection is ever read.
    source: { kind: 'runtime-context' } as unknown as UserMessage['source'],
  }
  agent.send(probe, 'next-turn', true)
  agent.inbox.remove(probe.id)
}
