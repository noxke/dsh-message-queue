/**
 * Host Remote service: queue state reads plus reorder, per-item pause, and
 * queue-wide pause/resume mutations for one live Agent. The service owns the
 * per-Session pause state and listens for inbox and status transitions that
 * maintain it.
 * @module dsh-message-queue/service
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import {
  ItemNotFoundError,
  SteerUnavailableError,
  applyLateDelivery,
  createQueueGateState,
  dropExpiredSent,
  dropExpiredTombstones,
  editHeldItem,
  isIdleState,
  moveQueueRow,
  openQueueGate,
  parkIncomingItem,
  noteClaimedItem,
  pauseAllItems,
  recordClaimedItem,
  recordDeliveredItem,
  REVOKED_NOTICE,
  RevokeExpiredError,
  revokeItem,
  pauseOneItem,
  readQueueState,
  releaseQueueGate,
  removeHeldItem,
  resumeAllItems,
  resumeOneItem,
  steerHeldItem,
  wakeQueue,
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
  sent: Object.freeze([]),
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
      const offClaimed = ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
        const state = this.gateState(agent.id)
        dropExpiredSent(state)
        dropExpiredTombstones(state)
        noteClaimedItem(state, message.id)
        // Plugin-injected notices are not user sends and stay out of the Sends list.
        if (message.source.kind === 'user') recordClaimedItem(state, message, turn)
      })
      const offSessionEvent = ctx.on('session/event', (session, event) => {
        if (event.type !== 'user/message') return
        const agent = this.agentOf(session.id)
        if (agent === undefined) return
        const state = this.gates.get(agent.id)
        if (state === undefined) return
        if (applyLateDelivery(agent, state, event.data.id, event.seq, REVOKED_NOTICE)) {
          this.prune(agent)
          return
        }
        recordDeliveredItem(state, event.data.id, event.seq)
      })
      const offStatus = ctx.on('agent/status', ({ agent, status }) => {
        if (status !== 'idle') return
        const state = this.gates.get(agent.id)
        if (state === undefined || !state.globalPaused || state.gateOpen) return
        try {
          // An explicit per-item resume keeps the next turn open for its item;
          // only otherwise does the queue-wide pause re-arm the boundary gate.
          if (state.bypass !== null) wakeQueue(agent, state)
          else openQueueGate(agent, state)
        } catch (error: unknown) {
          ctx.logger.warn(`message-queue: resuming the paused queue failed: ${String(error)}`)
        }
      })
      const offDisposed = ctx.on('agent/disposed', ({ agent }) => {
        this.gates.delete(agent.id)
      })
      return () => {
        offInserted()
        offClaimed()
        offSessionEvent()
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
    const agent = this.agentOf(sessionId)
    if (agent === undefined) return UNAVAILABLE
    const state = this.gates.get(agent.id)
    if (state !== undefined) {
      dropExpiredSent(state)
      dropExpiredTombstones(state)
      this.prune(agent)
    }
    return readQueueState(agent, this.gates.get(agent.id))
  }

  /**
   * Move one visible queue row inside its own group.
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
    this.prune(agent)
    return readQueueState(agent, this.gates.get(agent.id))
  }

  /**
   * Send one held item into the running turn.
   * @param sessionId - Session identity.
   * @param itemId - identity of the held row.
   * @returns the queue state after the item left the held list.
   */
  steer(sessionId: string, itemId: string): QueueState {
    const agent = this.requireAgent(sessionId)
    const state = this.gates.get(agent.id)
    try {
      steerHeldItem(agent, state, itemId)
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
   * Restore one held item, sending it immediately under a queue-wide pause.
   * @param sessionId - Session identity.
   * @param itemId - identity of the held row.
   * @returns the queue state after the item rejoined the queue.
   */
  resumeItem(sessionId: string, itemId: string): QueueState {
    const agent = this.requireAgent(sessionId)
    const state = this.gates.get(agent.id) ?? createQueueGateState()
    try {
      resumeOneItem(agent, state, itemId)
    } catch (error: unknown) {
      throw this.wireError(error, sessionId, itemId)
    }
    this.prune(agent)
    return readQueueState(agent, this.gates.get(agent.id))
  }

  /**
   * Withdraw one recently sent message.
   * @param sessionId - Session identity.
   * @param itemId - identity of the sent message.
   * @returns the queue state after the message returned as a queue row.
   */
  revoke(sessionId: string, itemId: string): QueueState {
    const agent = this.requireAgent(sessionId)
    const state = this.gateState(agent.id)
    try {
      revokeItem(agent, state, itemId, REVOKED_NOTICE)
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
    if (error instanceof SteerUnavailableError) {
      return new RemoteError(
        'message-queue/steer-unavailable',
        'no running turn accepts steering',
        { sessionId, itemId },
      )
    }
    if (error instanceof RevokeExpiredError) {
      return new RemoteError(
        'message-queue/revoke-expired',
        'the withdrawal window for this message has closed',
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
          state.mutating = true
          agent.inbox.splice('next-turn', 0, 0, state.held.map(item => item.message))
          state.held = []
          state.mutating = false
        }
        if (state.globalPaused) {
          state.globalPaused = false
          releaseQueueGate(agent, state)
        }
      } catch (error: unknown) {
        this.ctx.logger.warn(`message-queue: restoring held items on unload failed: ${String(error)}`)
      }
    }
    this.gates.clear()
  }
}
