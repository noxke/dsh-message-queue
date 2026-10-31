/**
 * Queue state and mutation semantics over a structural Agent stand-in:
 * queue-wide and per-item pause, restore order, move clamping, and held edits.
 * @module dsh-message-queue/tests/queue
 */

import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import {
  ItemNotFoundError,
  SteerUnavailableError,
  createQueueGateState,
  editHeldItem,
  isIdleState,
  moveQueueRow,
  noteClaimedItem,
  openQueueGate,
  parkIncomingItem,
  pauseAllItems,
  pauseOneItem,
  readQueueState,
  releaseQueueGate,
  removeHeldItem,
  resumeAllItems,
  resumeOneItem,
  revokeSteering,
  steerHeldItem,
  wakeQueue,
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
  /** Messages steered into the current turn. */
  readonly steered: UserMessage[]
  /** Held maintenance tasks, exposed so tests can release or abort them. */
  readonly maintenance: { count: number; releaseAll: () => void }
  /** Session append calls recorded for revocation tests. */
  readonly appended: Array<{ type: string; data: unknown; intent: unknown }>
}

/**
 * Build a fake Agent whose inbox records every mutation.
 * @param initial - messages queued for their own turns.
 */
function fakeAgent(initial: UserMessage[] = []): FakeAgent {
  const inbox = { nextTurn: [...initial], nextStep: [] as UserMessage[] }
  const releases: Array<() => void> = []
  const fake = {
    status: 'idle' as 'idle' | 'running',
    inbox,
    steered: [] as UserMessage[],
    maintenance: {
      count: 0,
      releaseAll: () => {
        for (const release of releases.splice(0)) release()
      },
    },
    appended: [] as Array<{ type: string; data: unknown; intent: unknown }>,
    agent: undefined as unknown as Agent,
  }
  fake.agent = {
    id: 'session-1' as unknown as SessionId,
    session: {
      id: 'session-1' as unknown as SessionId,
      append(type: string, data: unknown, intent: unknown) {
        fake.appended.push({ type, data, intent })
        return { type, data }
      },
    },
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
    send(item: UserMessage, target: 'next-turn' | 'next-step', _wakeup: boolean) {
      const list = target === 'next-turn' ? inbox.nextTurn : inbox.nextStep
      list.push(item)
    },
    steer(item: UserMessage) {
      fake.steered.push(item)
    },
    runMaintenance(task: (signal: AbortSignal) => Promise<unknown>) {
      fake.maintenance.count += 1
      const controller = new AbortController()
      const settled = new Promise<void>((resolve, reject) => {
        releases.push(resolve)
        controller.signal.addEventListener('abort', () => { reject(controller.signal.reason) }, { once: true })
      })
      void task(controller.signal)
      void settled.catch(() => {})
      return settled
    },
  } as unknown as Agent
  return fake
}

describe('moveQueueRow', () => {
  it('moves a middle queued item to the front', () => {
    const fake = fakeAgent([message('a'), message('b'), message('c')])
    expect(moveQueueRow(fake.agent, undefined, 'c', 0)).toEqual({ order: ['c', 'a', 'b'] })
    expect(fake.inbox.nextTurn.map(item => String(item.id))).toEqual(['c', 'a', 'b'])
  })

  it('moves a held item inside the held group only', () => {
    const fake = fakeAgent([message('queued')])
    const state = createQueueGateState()
    state.held.push({ message: message('held-a'), reason: 'manual', anchor: null })
    expect(moveQueueRow(fake.agent, state, 'held-a', 0)).toEqual({ order: ['held-a', 'queued'] })
    expect(state.held.map(item => String(item.message.id))).toEqual(['held-a'])
    expect(fake.inbox.nextTurn.map(item => String(item.id))).toEqual(['queued'])
  })

  it('rejects an identity that is neither held nor queued', () => {
    const fake = fakeAgent([message('a')])
    expect(() => moveQueueRow(fake.agent, undefined, 'missing', 0)).toThrow(ItemNotFoundError)
  })
})

describe('queue-wide pause', () => {
  it('holds every queued item and reports the reason', () => {
    const fake = fakeAgent([message('a'), message('b')])
    const state = createQueueGateState()
    pauseAllItems(fake.agent, state)
    expect(fake.inbox.nextTurn).toEqual([])
    expect(state.globalPaused).toBe(true)
    expect(state.held.map(item => `${String(item.message.id)}:${item.reason}`)).toEqual(['a:global', 'b:global'])
    expect(readQueueState(fake.agent, state)).toMatchObject({
      paused: true,
      order: ['a', 'b'],
      parked: [{ id: 'a', reason: 'global' }, { id: 'b', reason: 'global' }],
    })
  })

  it('holds idle Agents at their boundary', () => {
    const fake = fakeAgent()
    const state = createQueueGateState()
    state.globalPaused = true
    openQueueGate(fake.agent, state)
    expect(fake.maintenance.count).toBe(1)
    expect(state.gateOpen).toBe(true)
  })

  it('resumes only the items the queue-wide pause held', () => {
    const fake = fakeAgent([message('a')])
    const state = createQueueGateState()
    pauseAllItems(fake.agent, state)
    state.held.push({ message: message('manual'), reason: 'manual', anchor: null })
    openQueueGate(fake.agent, state)
    resumeAllItems(fake.agent, state)
    expect(fake.inbox.nextTurn.map(item => String(item.id))).toEqual(['a'])
    expect(state.held.map(item => `${String(item.message.id)}:${item.reason}`)).toEqual(['manual:manual'])
    expect(state.globalPaused).toBe(false)
    fake.maintenance.releaseAll()
  })

  it('parks a message submitted while the queue is paused', () => {
    const fake = fakeAgent()
    const state = createQueueGateState()
    state.globalPaused = true
    fake.inbox.nextTurn.push(message('late'))
    expect(parkIncomingItem(fake.agent, state, 'late' as unknown as MessageId)).toBe(true)
    expect(fake.inbox.nextTurn).toEqual([])
    expect(state.held.map(item => `${String(item.message.id)}:${item.reason}`)).toEqual(['late:global'])
  })
})

describe('per-item pause', () => {
  it('holds one queued item and restores it to its queue position', () => {
    const fake = fakeAgent([message('a'), message('b'), message('c')])
    const state = createQueueGateState()
    pauseOneItem(fake.agent, state, 'b')
    expect(fake.inbox.nextTurn.map(item => String(item.id))).toEqual(['a', 'c'])
    expect(state.held[0]?.anchor).toBe('c')
    resumeOneItem(fake.agent, state, 'b')
    expect(fake.inbox.nextTurn.map(item => String(item.id))).toEqual(['a', 'b', 'c'])
    expect(isIdleState(state)).toBe(true)
  })

  it('marks the explicitly resumed item for the next claim', () => {
    const fake = fakeAgent([message('a'), message('b')])
    const state = createQueueGateState()
    pauseAllItems(fake.agent, state)
    openQueueGate(fake.agent, state)
    resumeOneItem(fake.agent, state, 'b')
    expect(state.bypass).toBe('b')
    expect(fake.inbox.nextTurn.map(item => String(item.id))).toEqual(['b'])
    noteClaimedItem(state, 'b' as unknown as MessageId)
    expect(state.bypass).toBeNull()
  })

  it('sends one item immediately when the queue is paused', () => {
    const fake = fakeAgent([message('a'), message('b')])
    const state = createQueueGateState()
    pauseAllItems(fake.agent, state)
    openQueueGate(fake.agent, state)
    resumeOneItem(fake.agent, state, 'b')
    expect(fake.inbox.nextTurn.map(item => String(item.id))).toEqual(['b'])
    expect(state.held.map(item => String(item.message.id))).toEqual(['a'])
    expect(state.globalPaused).toBe(true)
    expect(state.gateOpen).toBe(false)
  })

  it('wakes an idle Agent after a per-item restore', () => {
    const fake = fakeAgent([message('a'), message('b')])
    const state = createQueueGateState()
    pauseOneItem(fake.agent, state, 'b')
    resumeOneItem(fake.agent, state, 'b')
    expect(fake.maintenance.count).toBe(1)
    fake.maintenance.releaseAll()
  })

  it('rejects pausing a row that is not queued', () => {
    const fake = fakeAgent()
    expect(() => pauseOneItem(fake.agent, createQueueGateState(), 'missing')).toThrow(ItemNotFoundError)
  })
})

describe('held row operations', () => {
  /** Two held messages on a running fake Agent. */
  function heldState(): { fake: FakeAgent; state: ReturnType<typeof createQueueGateState> } {
    const fake = fakeAgent()
    const state = createQueueGateState()
    fake.status = 'running'
    state.held.push(
      { message: message('a', 'first'), reason: 'manual', anchor: null },
      { message: message('b', 'second'), reason: 'manual', anchor: null },
    )
    return { fake, state }
  }

  it('edits one held row in place and preserves its identity', () => {
    const { state } = heldState()
    editHeldItem(state, 'b', 'rewritten')
    expect(state.held.map(item => String(item.message.id))).toEqual(['a', 'b'])
    expect(state.held[1]?.message.content).toEqual([{ type: 'text', text: 'rewritten' }])
  })

  it('removes one held row', () => {
    const { state } = heldState()
    removeHeldItem(state, 'a')
    expect(state.held.map(item => String(item.message.id))).toEqual(['b'])
  })

  it('steers one held row into a running turn', () => {
    const { fake, state } = heldState()
    steerHeldItem(fake.agent, state, 'a')
    expect(fake.steered.map(item => String(item.id))).toEqual(['a'])
    expect(state.held.map(item => String(item.message.id))).toEqual(['b'])
  })

  it('refuses steering without a running turn', () => {
    const { fake, state } = heldState()
    fake.status = 'idle'
    expect(() => steerHeldItem(fake.agent, state, 'a')).toThrow(SteerUnavailableError)
  })

  it('refuses held operations on missing rows', () => {
    expect(() => editHeldItem(undefined, 'x', 'y')).toThrow(ItemNotFoundError)
    expect(() => removeHeldItem(undefined, 'x')).toThrow(ItemNotFoundError)
    expect(() => steerHeldItem(fakeAgent().agent, undefined, 'x')).toThrow(ItemNotFoundError)
  })
})

describe('steering withdrawal', () => {
  it('removes a pending steering message and returns it to the queue', () => {
    const fake = fakeAgent([message('queued')])
    fake.inbox.nextStep.push(message('steer', 'inserted task'))
    const state = createQueueGateState()
    revokeSteering(fake.agent, state, 'steer')
    expect(fake.inbox.nextStep).toEqual([])
    expect(fake.inbox.nextTurn.map(item => String(item.id))).toEqual(['steer', 'queued'])
    expect(fake.appended).toHaveLength(0)
    expect(state.held).toHaveLength(0)
  })

  it('holds the withdrawn steering message while the queue is paused', () => {
    const fake = fakeAgent()
    fake.inbox.nextStep.push(message('steer'))
    const state = createQueueGateState()
    state.globalPaused = true
    revokeSteering(fake.agent, state, 'steer')
    expect(fake.inbox.nextTurn).toEqual([])
    expect(state.held[0]?.reason).toBe('global')
    expect(String(state.held[0]?.message.id)).toBe('steer')
  })

  it('rejects a message the model already received', () => {
    const fake = fakeAgent([message('claimed')])
    expect(() => revokeSteering(fake.agent, createQueueGateState(), 'claimed')).toThrow(ItemNotFoundError)
  })

  it('reports only user-composed steering rows in the projection', () => {
    const fake = fakeAgent()
    fake.inbox.nextStep.push(message('mine'), {
      id: 'notice' as unknown as MessageId,
      role: 'user',
      content: [{ type: 'text', text: 'plugin notice' }],
      source: { kind: 'runtime-context' } as unknown as UserMessage['source'],
    })
    expect(readQueueState(fake.agent, undefined).steering.map(item => item.id)).toEqual(['mine'])
  })
})

describe('gate release', () => {
  it('releases the maintenance task and keeps restored work queued', () => {
    const fake = fakeAgent([message('a')])
    const state = createQueueGateState()
    state.globalPaused = true
    fake.inbox.nextTurn.length = 0
    openQueueGate(fake.agent, state)
    fake.inbox.nextTurn.push(message('a'))
    releaseQueueGate(fake.agent, state)
    expect(state.gateOpen).toBe(false)
    expect(fake.inbox.nextTurn.map(item => String(item.id))).toEqual(['a'])
    fake.maintenance.releaseAll()
  })

  it('wakes an idle Agent without a gate', () => {
    const fake = fakeAgent([message('a')])
    wakeQueue(fake.agent)
    expect(fake.maintenance.count).toBe(1)
    fake.maintenance.releaseAll()
  })
})
