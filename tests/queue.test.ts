/**
 * Queue gate and reorder semantics over a structural Agent stand-in: parking,
 * the maintenance gate, restore order, and move clamping.
 * @module dsh-message-queue/tests/queue
 */

import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import {
  ItemNotFoundError,
  closeQueueGate,
  createQueueGateState,
  moveQueueItem,
  openQueueGate,
  parkInsertedMessage,
  parkQueuedTurns,
  readQueueState,
} from '../src/queue.ts'

/** Build one user message with a stable identity. */
function message(id: string, text: string = id): UserMessage {
  return {
    id: id as unknown as MessageId,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' } as UserMessage['source'],
  }
}

/** Structural stand-in for the live Agent the queue module mutates. */
interface FakeAgent {
  agent: Agent
  readonly inbox: { nextTurn: UserMessage[]; nextStep: UserMessage[] }
  status: 'idle' | 'running'
  /** Held maintenance tasks, exposed so tests can release or abort them. */
  readonly maintenance: { count: number; signal?: AbortSignal; abort: (reason: Error) => void }
}

/**
 * Build a fake Agent whose inbox records every mutation.
 * @param initial - messages queued for their own turns.
 */
function fakeAgent(initial: UserMessage[] = []): FakeAgent {
  const inbox = { nextTurn: [...initial], nextStep: [] as UserMessage[] }
  const controller = { current: undefined as AbortController | undefined }
  const fake = {
    status: 'idle' as 'idle' | 'running',
    inbox,
    maintenance: {
      count: 0,
      get signal() { return controller.current?.signal },
      abort: (reason: Error) => { controller.current?.abort(reason) },
    },
    agent: undefined as unknown as Agent,
  }
  const agent = {
    id: 'session-1' as unknown as SessionId,
    get status() { return fake.status },
    inbox: {
      get nextTurn() { return inbox.nextTurn },
      get nextStep() { return inbox.nextStep },
      splice(target: 'next-turn' | 'next-step', start: number, deleteCount: number, inserted: UserMessage[]) {
        const list = target === 'next-turn' ? inbox.nextTurn : inbox.nextStep
        const offset = Number.isFinite(start) ? Math.max(0, Math.min(Math.trunc(start), list.length)) : list.length
        return list.splice(offset, deleteCount, ...inserted)
      },
      remove(id: MessageId) {
        const index = inbox.nextTurn.findIndex(item => item.id === id)
        if (index < 0) return false
        inbox.nextTurn.splice(index, 1)
        return true
      },
    },
    send(message: UserMessage, target: 'next-turn' | 'next-step', _wakeup: boolean) {
      const list = target === 'next-turn' ? inbox.nextTurn : inbox.nextStep
      list.push(message)
    },
    runMaintenance(task: (signal: AbortSignal) => Promise<unknown>) {
      fake.maintenance.count += 1
      const held = new AbortController()
      controller.current = held
      const settled = task(held.signal)
      void settled.catch(() => {})
      return settled
    },
  }
  fake.agent = agent as unknown as Agent
  return fake
}

describe('moveQueueItem', () => {
  it('moves a middle item to the front and records one splice', () => {
    const fake = fakeAgent([message('a'), message('b'), message('c')])
    expect(moveQueueItem(fake.agent, 'c', 0)).toEqual({ order: ['c', 'a', 'b'] })
    expect(fake.inbox.nextTurn.map(item => String(item.id))).toEqual(['c', 'a', 'b'])
  })

  it('clamps out-of-range destinations instead of failing', () => {
    const fake = fakeAgent([message('a'), message('b'), message('c')])
    expect(moveQueueItem(fake.agent, 'a', 99)).toEqual({ order: ['b', 'c', 'a'] })
    expect(moveQueueItem(fake.agent, 'c', -4)).toEqual({ order: ['c', 'b', 'a'] })
  })

  it('rejects an item that is no longer pending', () => {
    const fake = fakeAgent([message('a')])
    expect(() => moveQueueItem(fake.agent, 'missing', 0)).toThrow(ItemNotFoundError)
  })
})

describe('pause gate', () => {
  it('parks every queued turn and reports the parked projection', () => {
    const fake = fakeAgent([message('a', 'first'), message('b', 'second')])
    const state = createQueueGateState()
    state.paused = true
    parkQueuedTurns(fake.agent, state)
    expect(fake.inbox.nextTurn).toEqual([])
    expect(state.parked.map(item => String(item.id))).toEqual(['a', 'b'])
    const projection = readQueueState(fake.agent, state)
    expect(projection.paused).toBe(true)
    expect(projection.order).toEqual(['a', 'b'])
    expect(projection.parked).toHaveLength(2)
    expect(projection.parked[0]).toMatchObject({ id: 'a' })
  })

  it('holds the idle Agent in a maintenance task', () => {
    const fake = fakeAgent()
    const state = createQueueGateState()
    state.paused = true
    openQueueGate(fake.agent, state)
    expect(fake.maintenance.count).toBe(1)
    expect(fake.maintenance.signal).toBeDefined()
    expect(state.gateOpen).toBe(true)
  })

  it('parks a message inserted before a running turn reaches its boundary', () => {
    const fake = fakeAgent([message('a')])
    const state = createQueueGateState()
    state.paused = true
    fake.status = 'running'
    parkQueuedTurns(fake.agent, state)
    fake.inbox.nextTurn.push(message('late', 'late'))
    parkInsertedMessage(fake.agent, state, 'late' as unknown as MessageId)
    expect(fake.inbox.nextTurn).toEqual([])
    expect(state.parked.map(item => String(item.id))).toEqual(['a', 'late'])
  })

  it('leaves inserts alone once the gate is open', () => {
    const fake = fakeAgent()
    const state = createQueueGateState()
    state.paused = true
    openQueueGate(fake.agent, state)
    fake.inbox.nextTurn.push(message('during-gate'))
    parkInsertedMessage(fake.agent, state, 'during-gate' as unknown as MessageId)
    expect(fake.inbox.nextTurn.map(item => String(item.id))).toEqual(['during-gate'])
  })

  it('restores parked items at the front and releases the gate', () => {
    const fake = fakeAgent([message('a'), message('b')])
    const state = createQueueGateState()
    state.paused = true
    parkQueuedTurns(fake.agent, state)
    openQueueGate(fake.agent, state)
    fake.inbox.nextTurn.push(message('during-gate'))
    closeQueueGate(fake.agent, state)
    expect(fake.inbox.nextTurn.map(item => String(item.id))).toEqual(['a', 'b', 'during-gate'])
    expect(state.paused).toBe(false)
    expect(state.gateOpen).toBe(false)
  })
})
