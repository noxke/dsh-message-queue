/**
 * Host Remote service: queue state reads plus reorder, per-item pause,
 * queue-wide pause/resume, send-now, and steering withdrawal for one live
 * Agent. The service owns the per-Session pause state and listens for inbox
 * transitions that maintain it.
 * @module dsh-message-queue/service
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import {
  ItemNotFoundError,
  clearPauseWhenEmpty,
  createQueueGateState,
  visibleOrder,
  editHeldItem,
  isIdleState,
  moveQueueRow,
  parkIncomingItem,
  pauseAllItems,
  pauseOneItem,
  readQueueState,
  removeHeldItem,
  resumeAllItems,
  resumeOneItem,
  revokeSteering,
  sendNowItem,
} from './queue.ts'
import type { QueueGateState } from './queue.ts'
import { MESSAGE_QUEUE_NAMESPACE } from './wire.ts'
import type { QueueOrder, QueueState } from './wire.ts'

/** Queue state reported for a Session with no live Agent. */
const UNAVAILABLE: QueueState = Object.freeze({
  available: false,
  paused: false,
  parked: Object.freeze([]),
  order: Object.freeze([]),
  steering: Object.freeze([]),
})

/** Pending message queue control exposed over the `messageQueue` Typert namespace. */
export class MessageQueueService extends TypertRemoteService {
  /** The live Agent registry is the only service this controller reads. */
  static inject = ['agents']

  private readonly gates = new Map<string, QueueGateState>()

  constructor(ctx: Context) {
    super(ctx, MESSAGE_QUEUE_NAMESPACE)
    ctx.effect(() => {
      const offInserted = ctx.on('agent/inbox/inserted', ({ agent, message }) => {
        const state = this.gates.get(agent.id)
        if (state === undefined) return
        try {
          if (parkIncomingItem(agent, state, message.id)) this.prune(agent)
        } catch (error: unknown) {
          ctx.logger.warn(`message-queue: parking a paused submission failed: ${String(error)}`)
        }
      })
      const offClaimed = ctx.on('agent/inbox/claimed', ({ agent }) => {
        const state = this.gates.get(agent.id)
        if (state === undefined) return
        clearPauseWhenEmpty(agent, state)
        this.prune(agent)
      })
      const offDisposed = ctx.on('agent/disposed', ({ agent }) => {
        this.gates.delete(agent.id)
      })
      return () => {
        offInserted()
        offClaimed()
        offDisposed()
        this.restoreAll()
      }
    }, 'message-queue: pause and inbox listeners')
  }

  /**
   * Read one Session's queue state without mutating it.
   * @param sessionId - Session identity.
   * @returns the queue projection; `available` is false without a live Agent.
   */
  state(sessionId: string): QueueState {
    const agent = this.agentOf(sessionId)
    if (agent === undefined) return UNAVAILABLE
    return readQueueState(agent, this.gates.get(agent.id))
  }

  /**
   * Move one visible queue row to another index in the linear order.
   * @param sessionId - Session identity.
   * @param itemId - identity of the row to move.
   * @param toIndex - destination index inside the row's own group; clamped.
   * @returns the new visible identity order.
   * @throws RemoteError `message-queue/item-not-found` when the row is gone.
   */
  move(sessionId: string, itemId: string, toIndex: number): QueueOrder {
    const agent = this.requireAgent(sessionId)
    try {
      return moveQueueRow(agent, this.gates.get(agent.id), itemId, toIndex)
    } catch (error: unknown) {
      throw this.wireError(error, sessionId, itemId)
    }
  }

  /**
   * Replace one held item's text.
   * @param sessionId - Session identity.
   * @param itemId - identity of the held row.
   * @param text - non-empty replacement text.
   * @returns the queue state after the edit.
   */
  edit(sessionId: string, itemId: string, text: string): QueueState {
    const agent = this.requireAgent(sessionId)
    if (text.trim() === '') {
      throw new RemoteError('message-queue/invalid-content', 'queued edit text must not be blank', { sessionId, itemId })
    }
    const state = this.gates.get(agent.id)
    try {
      editHeldItem(state, itemId, text)
    } catch (error: unknown) {
      throw this.wireError(error, sessionId, itemId)
    }
    return readQueueState(agent, state)
  }

  /**
   * Discard one held item.
   * @param sessionId - Session identity.
   * @param itemId - identity of the held row.
   * @returns the queue state after the removal.
   */
  discard(sessionId: string, itemId: string): QueueState {
    const agent = this.requireAgent(sessionId)
    const state = this.gates.get(agent.id)
    try {
      removeHeldItem(state, itemId)
    } catch (error: unknown) {
      throw this.wireError(error, sessionId, itemId)
    }
    if (state !== undefined) clearPauseWhenEmpty(agent, state)
    this.prune(agent)
    return readQueueState(agent, this.gates.get(agent.id))
  }

  /**
   * Send one row immediately, out of queue order.
   * @param sessionId - Session identity.
   * @param itemId - identity of the row to send, held or queued.
   * @returns the queue state after the row left the queue.
   */
  steer(sessionId: string, itemId: string): QueueState {
    const agent = this.requireAgent(sessionId)
    const state = this.gates.get(agent.id)
    try {
      sendNowItem(agent, state, itemId)
    } catch (error: unknown) {
      throw this.wireError(error, sessionId, itemId)
    }
    this.prune(agent)
    return readQueueState(agent, this.gates.get(agent.id))
  }

  /**
   * Hold one queued item without pausing the queue.
   * @param sessionId - Session identity.
   * @param itemId - identity of the queued row.
   * @returns the queue state after the item was held.
   */
  pauseItem(sessionId: string, itemId: string): QueueState {
    const agent = this.requireAgent(sessionId)
    const state = this.gateState(agent.id)
    try {
      pauseOneItem(agent, state, itemId)
    } catch (error: unknown) {
      throw this.wireError(error, sessionId, itemId)
    }
    return readQueueState(agent, state)
  }

  /**
   * Restore one held item to its own position in the queue.
   * @param sessionId - Session identity.
   * @param itemId - identity of the held row.
   * @returns the queue state after the item rejoined the queue.
   */
  resumeItem(sessionId: string, itemId: string): QueueState {
    const agent = this.requireAgent(sessionId)
    const state = this.gates.get(agent.id)
    if (state === undefined) throw this.wireError(new ItemNotFoundError(), sessionId, itemId)
    try {
      resumeOneItem(agent, state, itemId)
    } catch (error: unknown) {
      throw this.wireError(error, sessionId, itemId)
    }
    this.prune(agent)
    return readQueueState(agent, this.gates.get(agent.id))
  }

  /**
   * Withdraw a steering message the model has not received yet.
   * @param sessionId - Session identity.
   * @param itemId - identity of the pending steering message.
   * @returns the queue state after the message returned to the queue.
   */
  revoke(sessionId: string, itemId: string): QueueState {
    const agent = this.requireAgent(sessionId)
    const state = this.gateState(agent.id)
    try {
      revokeSteering(agent, state, itemId)
    } catch (error: unknown) {
      throw this.wireError(error, sessionId, itemId)
    }
    this.prune(agent)
    return readQueueState(agent, this.gates.get(agent.id))
  }

  /**
   * Pause the whole queue: every queued item is held and no new turn opens.
   * @param sessionId - Session identity.
   * @returns the paused queue state.
   * @throws RemoteError `message-queue/agent-not-attached` without a live Agent.
   */
  pause(sessionId: string): QueueState {
    const agent = this.requireAgent(sessionId)
    const state = this.gateState(agent.id)
    pauseAllItems(agent, state)
    clearPauseWhenEmpty(agent, state)
    return readQueueState(agent, state)
  }

  /**
   * Clear the queue-wide pause and restore only the items it held.
   * @param sessionId - Session identity.
   * @returns the resumed queue state.
   * @throws RemoteError `message-queue/agent-not-attached` without a live Agent.
   */
  resume(sessionId: string): QueueState {
    const agent = this.requireAgent(sessionId)
    const state = this.gates.get(agent.id)
    if (state === undefined) return readQueueState(agent, undefined)
    resumeAllItems(agent, state)
    this.prune(agent)
    return readQueueState(agent, this.gates.get(agent.id))
  }

  /** The live Agent registry, read through the service context. */
  private get agents(): Context['agents'] {
    return this.ctx.agents
  }

  /** Optional live Agent lookup for read-only projections. */
  private agentOf(sessionId: string): Agent | undefined {
    return this.agents.get(sessionId as unknown as SessionId)
  }

  /** Resolve one live Agent or raise the wire error the Client renders. */
  private requireAgent(sessionId: string): Agent {
    const agent = this.agentOf(sessionId)
    if (agent === undefined) {
      throw new RemoteError(
        'message-queue/agent-not-attached',
        `session "${sessionId}" has no live agent`,
        { sessionId },
      )
    }
    return agent
  }

  /** State for one Agent, created on first use. */
  private gateState(sessionId: string): QueueGateState {
    const existing = this.gates.get(sessionId)
    if (existing !== undefined) return existing
    const state = createQueueGateState()
    this.gates.set(sessionId, state)
    return state
  }

  /** Drop a state that no longer holds items or a gate. */
  private prune(agent: Agent): void {
    const state = this.gates.get(agent.id)
    if (state !== undefined && isIdleState(state)) this.gates.delete(agent.id)
  }

  /** Map a queue mutation failure to its wire error. */
  private wireError(error: unknown, sessionId: string, itemId: string): unknown {
    if (error instanceof ItemNotFoundError) {
      return new RemoteError(
        'message-queue/item-not-found',
        `queue item "${itemId}" is no longer pending`,
        { sessionId, itemId },
      )
    }
    return error
  }

  /** Return every held item to its live inbox before this plugin unloads. */
  private restoreAll(): void {
    for (const [sessionId, state] of this.gates) {
      const agent = this.agentOf(sessionId)
      if (agent === undefined) continue
      try {
        if (state.held.length > 0) {
          const order = visibleOrder(agent, state)
          const inbox = [...agent.inbox.nextTurn]
          const heldById = new Map(state.held.map(item => [String(item.message.id), item]))
          const next = order.map(id => heldById.get(id)?.message ?? agent.inbox.nextTurn.find(m => String(m.id) === id))
          state.mutating = true
          try {
            agent.inbox.splice('next-turn', 0, inbox.length, next.filter((m): m is typeof inbox[number] => m !== undefined))
          } finally {
            state.held = []
            state.mutating = false
          }
        }
        state.globalPaused = false
      } catch (error: unknown) {
        this.ctx.logger.warn(`message-queue: restoring held items on unload failed: ${String(error)}`)
      }
    }
    this.gates.clear()
  }
}
