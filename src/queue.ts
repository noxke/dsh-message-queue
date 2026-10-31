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
 * Read the queue state of one Agent, optionally including a live pause gate.
 * @param agent - Agent whose inbox is the queue.
 * @param state - per-Session pause state, absent when the queue is not paused.
 * @returns the wire projection of the queue.
 */
export function readQueueState(agent: Agent, state: QueueGateState | undefined): QueueState {
  const parked = state?.parked ?? []
  const queued = agent.inbox.nextTurn
  return {
    available: true,
    paused: state?.paused === true,
    parked: parked.map(parkedItemOf),
    order: [...parked.map(message => String(message.id)), ...queued.map(message => String(message.id))],
  }
}

/**
 * Move one pending turn item to a new index.
 * @param agent - Agent owning the queue.
 * @param itemId - identity of the message to move.
 * @param toIndex - requested destination; clamped into `[0, length - 1]`.
 * @returns the new `next-turn` identity order.
 * @throws when the message is no longer pending.
 */
export function moveQueueItem(agent: Agent, itemId: string, toIndex: number): QueueOrder {
  const current = [...agent.inbox.nextTurn]
  const from = current.findIndex(message => String(message.id) === itemId)
  if (from < 0) throw new ItemNotFoundError()
  const target = Math.min(Math.max(Math.trunc(toIndex), 0), current.length - 1)
  const moved = current[from] as UserMessage
  const order = current.toSpliced(from, 1).toSpliced(target, 0, moved)
  agent.inbox.splice('next-turn', 0, current.length, order)
  return { order: order.map(message => String(message.id)) }
}

/** Raised when a queue mutation names an item the inbox no longer holds. */
export class ItemNotFoundError extends Error {
  constructor() {
    super('queue item is no longer pending')
    this.name = 'ItemNotFoundError'
  }
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
