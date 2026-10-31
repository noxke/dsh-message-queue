/**
 * Host Remote service: queue state reads plus reorder and pause/resume
 * mutations for one live Agent. The service owns the per-Session pause gates
 * and listens for the inbox and status transitions that maintain them.
 * @module dsh-message-queue/service
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import {
  ItemNotFoundError,
  closeQueueGate,
  createQueueGateState,
  moveQueueItem,
  openQueueGate,
  parkInsertedMessage,
  parkQueuedTurns,
  readQueueState,
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
          parkInsertedMessage(agent, state, message.id)
        } catch (error: unknown) {
          ctx.logger.warn(`message-queue: parking a paused submission failed: ${String(error)}`)
        }
      })
      const offStatus = ctx.on('agent/status', ({ agent, status }) => {
        if (status !== 'idle') return
        const state = this.gates.get(agent.id)
        if (state === undefined || !state.paused || state.gateOpen) return
        try {
          openQueueGate(agent, state)
        } catch (error: unknown) {
          ctx.logger.warn(`message-queue: opening the pause gate failed: ${String(error)}`)
        }
      })
      const offDisposed = ctx.on('agent/disposed', ({ agent }) => {
        this.forget(agent)
      })
      return () => {
        offInserted()
        offStatus()
        offDisposed()
        this.restoreAll()
      }
    }, 'message-queue: queue gate listeners')
  }

  /**
   * Read one Session's queue state without mutating it.
   * @param sessionId - Session identity.
   * @returns the queue projection; `available` is false without a live Agent.
   */
  state(sessionId: string): QueueState {
    const agent = this.agents.get(sessionId as unknown as SessionId)
    if (agent === undefined) return UNAVAILABLE
    return readQueueState(agent, this.gates.get(agent.id))
  }

  /**
   * Move one pending turn message.
   * @param sessionId - Session identity.
   * @param itemId - identity of the message to move.
   * @param toIndex - requested destination index, clamped to the queue bounds.
   * @returns the new `next-turn` identity order.
   * @throws RemoteError `message-queue/item-not-found` when the item is not pending.
   */
  move(sessionId: string, itemId: string, toIndex: number): QueueOrder {
    const agent = this.requireAgent(sessionId)
    try {
      return moveQueueItem(agent, itemId, toIndex)
    } catch (error: unknown) {
      if (error instanceof ItemNotFoundError) {
        throw new RemoteError(
          'message-queue/item-not-found',
          `queue item "${itemId}" is no longer pending`,
          { sessionId, itemId },
        )
      }
      throw error
    }
  }

  /**
   * Pause one Session's queue: the running turn finishes, later queued turns
   * stay queued until {@link resume}.
   * @param sessionId - Session identity.
   * @returns the paused queue state.
   * @throws RemoteError `message-queue/agent-not-attached` without a live Agent.
   */
  pause(sessionId: string): QueueState {
    const agent = this.requireAgent(sessionId)
    const existing = this.gates.get(agent.id)
    if (existing?.paused === true) return readQueueState(agent, existing)
    const state = existing ?? createQueueGateState()
    this.gates.set(agent.id, state)
    state.paused = true
    parkQueuedTurns(agent, state)
    if (agent.status === 'idle') {
      try {
        openQueueGate(agent, state)
      } catch (error: unknown) {
        this.ctx.logger.warn(`message-queue: deferring the pause gate: ${String(error)}`)
      }
    }
    return readQueueState(agent, state)
  }

  /**
   * Resume one Session's queue and restore parked items at its front.
   * @param sessionId - Session identity.
   * @returns the resumed queue state.
   * @throws RemoteError `message-queue/agent-not-attached` without a live Agent.
   */
  resume(sessionId: string): QueueState {
    const agent = this.requireAgent(sessionId)
    const state = this.gates.get(agent.id)
    if (state === undefined || !state.paused) return readQueueState(agent, state)
    closeQueueGate(agent, state)
    this.gates.delete(agent.id)
    return readQueueState(agent, undefined)
  }

  /** The live Agent registry, read through the service context. */
  private get agents(): Context['agents'] {
    return this.ctx.agents
  }

  /** Resolve one live Agent or raise the wire error the Client renders. */
  private requireAgent(sessionId: string): Agent {
    const agent = this.agents.get(sessionId as unknown as SessionId)
    if (agent === undefined) {
      throw new RemoteError(
        'message-queue/agent-not-attached',
        `session "${sessionId}" has no live agent`,
        { sessionId },
      )
    }
    return agent
  }

  /** Drop one disposed Agent's gate, returning parked items to its inbox when possible. */
  private forget(agent: Agent): void {
    const state = this.gates.get(agent.id)
    if (state === undefined) return
    this.gates.delete(agent.id)
    try {
      closeQueueGate(agent, state)
    } catch (error: unknown) {
      this.ctx.logger.warn(`message-queue: restoring parked items on disposal failed: ${String(error)}`)
    }
  }

  /** Return every parked item to its live inbox before this plugin unloads. */
  private restoreAll(): void {
    for (const [sessionId, state] of this.gates) {
      const agent = this.agents.get(sessionId as unknown as SessionId)
      if (agent === undefined) continue
      try {
        closeQueueGate(agent, state)
      } catch (error: unknown) {
        this.ctx.logger.warn(`message-queue: restoring parked items on unload failed: ${String(error)}`)
      }
    }
    this.gates.clear()
  }
}
