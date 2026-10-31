/**
 * Queue state and mutation semantics over a structural Agent stand-in:
 * linear ordering, queue-wide and per-item pause, restore position, send-now,
 * and steering withdrawal.
 * @module dsh-message-queue/tests/queue
 */

import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import {
  ItemNotFoundError,
  clearPauseWhenEmpty,
  createQueueGateState,
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
  visibleOrder,
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
  /** Held maintenance tasks, exposed so tests can settle them. */
  readonly maintenance: { count: number; releaseAll: () => void }
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
    agent: undefined as unknown as Agent,
  }
  fake.agent = {
    id: 'session-1' as unknown as SessionId,
    session: {
      id: 'session-1' as unknown as SessionId,
      append() {
        return { type: 'user/message', data: {} }
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

/** Identities of one list of messages. */
function ids(messages: readonly UserMessage[]): string[] {
  return messages.map(item => String(item.id))
}

describe('moveQueueRow', () => {
  it('moves one row anywhere in the linear order', () => {
    const fake = fakeAgent([message('a'), message('b'), message('c')])
    expect(moveQueueRow(fake.agent, undefined, 'c', 0)).toEqual({ order: ['c', 'a', 'b'] })
    expect(ids(fake.inbox.nextTurn)).toEqual(['c', 'a', 'b'])
    expect(moveQueueRow(fake.agent, undefined, 'a', 9)).toEqual({ order: ['c', 'b', 'a'] })
  })

  it('moves a paused row across unpaused rows', () => {
    const fake = fakeAgent([message('a'), message('b'), message('c')])
    const state = createQueueGateState()
    pauseOneItem(fake.agent, state, 'b')
    expect(moveQueueRow(fake.agent, state, 'b', 0)).toEqual({ order: ['b', 'a', 'c'] })
    expect(ids(fake.inbox.nextTurn)).toEqual(['a', 'c'])
    expect(visibleOrder(fake.agent, state)).toEqual(['b', 'a', 'c'])
  })

  it('rejects an identity that is neither held nor queued', () => {
    expect(() => moveQueueRow(fakeAgent().agent, undefined, 'missing', 0)).toThrow(ItemNotFoundError)
  })
})

describe('queue-wide pause', () => {
  it('holds every queued item in order and reports the reason', () => {
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

  it('restores the held items to their own positions', () => {
    const fake = fakeAgent([message('a'), message('b'), message('c')])
    const state = createQueueGateState()
    pauseAllItems(fake.agent, state)
    state.held[1] = { message: message('b'), reason: 'manual', anchor: 'c' }
    resumeAllItems(fake.agent, state)
    expect(ids(fake.inbox.nextTurn)).toEqual(['a', 'c'])
    expect(state.globalPaused).toBe(false)
    expect(state.held.map(item => String(item.message.id))).toEqual(['b'])
    expect(visibleOrder(fake.agent, state)).toEqual(['a', 'b', 'c'])
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
  it('holds one queued item and restores it to its own position', () => {
    const fake = fakeAgent([message('a'), message('b'), message('c')])
    const state = createQueueGateState()
    pauseOneItem(fake.agent, state, 'b')
    expect(ids(fake.inbox.nextTurn)).toEqual(['a', 'c'])
    expect(visibleOrder(fake.agent, state)).toEqual(['a', 'b', 'c'])
    resumeOneItem(fake.agent, state, 'b')
    expect(ids(fake.inbox.nextTurn)).toEqual(['a', 'b', 'c'])
    expect(isIdleState(state)).toBe(true)
  })

  it('wakes the idle Agent when a pause leaves another row sendable', () => {
    const fake = fakeAgent([message('a'), message('b')])
    const state = createQueueGateState()
    pauseOneItem(fake.agent, state, 'a')
    expect(fake.maintenance.count).toBe(1)
    expect(ids(fake.inbox.nextTurn)).toEqual(['b'])
    fake.maintenance.releaseAll()
  })

  it('keeps the pause and the position when one row is resumed under a queue-wide pause', () => {
    const fake = fakeAgent([message('a'), message('b')])
    const state = createQueueGateState()
    pauseAllItems(fake.agent, state)
    resumeOneItem(fake.agent, state, 'b')
    expect(ids(fake.inbox.nextTurn)).toEqual(['b'])
    expect(state.held.map(item => String(item.message.id))).toEqual(['a'])
    expect(state.globalPaused).toBe(true)
    expect(visibleOrder(fake.agent, state)).toEqual(['a', 'b'])
  })

  it('wakes an idle Agent after a per-item restore', () => {
    const fake = fakeAgent([message('a'), message('b')])
    const state = createQueueGateState()
    pauseOneItem(fake.agent, state, 'b')
    expect(fake.maintenance.count).toBe(1)
    resumeOneItem(fake.agent, state, 'b')
    expect(fake.maintenance.count).toBe(2)
    fake.maintenance.releaseAll()
  })

  it('rejects pausing a row that is not queued', () => {
    const fake = fakeAgent()
    expect(() => pauseOneItem(fake.agent, createQueueGateState(), 'missing')).toThrow(ItemNotFoundError)
  })
})

describe('held row operations', () => {
  /** Two held messages on an idle fake Agent. */
  function heldState(): { fake: FakeAgent; state: ReturnType<typeof createQueueGateState> } {
    const fake = fakeAgent()
    const state = createQueueGateState()
    state.held.push({ message: message('a'), reason: 'manual', anchor: 'b' })
    state.held.push({ message: message('b'), reason: 'manual', anchor: null })
    return { fake, state }
  }

  it('edits one held row in place and preserves its identity', () => {
    const { state } = heldState()
    editHeldItem(state, 'b', 'rewritten')
    expect(String(state.held[1]?.message.id)).toBe('b')
    expect((state.held[1]?.message.content[0] as { text: string } | undefined)?.text).toBe('rewritten')
  })

  it('removes one held row', () => {
    const { state } = heldState()
    removeHeldItem(state, 'a')
    expect(state.held.map(item => String(item.message.id))).toEqual(['b'])
  })

  it('rejects held operations on missing rows', () => {
    expect(() => editHeldItem(undefined, 'x', 'y')).toThrow(ItemNotFoundError)
    expect(() => removeHeldItem(undefined, 'x')).toThrow(ItemNotFoundError)
    expect(() => sendNowItem(fakeAgent().agent, undefined, 'x')).toThrow(ItemNotFoundError)
  })
})

describe('send now', () => {
  it('steers a held row into a running turn', () => {
    const fake = fakeAgent()
    fake.status = 'running'
    const state = createQueueGateState()
    state.held.push({ message: message('a'), reason: 'manual', anchor: null })
    sendNowItem(fake.agent, state, 'a')
    expect(fake.steered.map(item => String(item.id))).toEqual(['a'])
    expect(state.held).toEqual([])
  })

  it('sends a queued row into a running turn out of order', () => {
    const fake = fakeAgent([message('a'), message('b')])
    fake.status = 'running'
    sendNowItem(fake.agent, undefined, 'b')
    expect(fake.steered.map(item => String(item.id))).toEqual(['b'])
    expect(ids(fake.inbox.nextTurn)).toEqual(['a'])
  })

  it('moves a held row to the head of the inbox while the Agent is idle', () => {
    const fake = fakeAgent([message('q')])
    const state = createQueueGateState()
    state.held.push({ message: message('p'), reason: 'manual', anchor: null })
    sendNowItem(fake.agent, state, 'p')
    expect(ids(fake.inbox.nextTurn)).toEqual(['p', 'q'])
    expect(fake.maintenance.count).toBe(1)
    fake.maintenance.releaseAll()
  })

  it('sends a queued row ahead of the queue while the Agent is idle', () => {
    const fake = fakeAgent([message('a'), message('b')])
    sendNowItem(fake.agent, undefined, 'b')
    expect(ids(fake.inbox.nextTurn)).toEqual(['b', 'a'])
  })
})

describe('linear queue order', () => {
  it('keeps a paused row in its position and leaves the next unpaused row queued', () => {
    const fake = fakeAgent([message('a'), message('b'), message('c')])
    const state = createQueueGateState()
    pauseOneItem(fake.agent, state, 'b')
    expect(ids(fake.inbox.nextTurn)).toEqual(['a', 'c'])
    expect(visibleOrder(fake.agent, state)).toEqual(['a', 'b', 'c'])

    pauseOneItem(fake.agent, state, 'a')
    expect(ids(fake.inbox.nextTurn)).toEqual(['c'])
    expect(visibleOrder(fake.agent, state)).toEqual(['a', 'b', 'c'])
  })

  it('keeps the order across a pause and resume round trip', () => {
    const fake = fakeAgent([message('a'), message('b'), message('c'), message('d')])
    const state = createQueueGateState()
    for (const id of ['c', 'b']) pauseOneItem(fake.agent, state, id)
    for (const id of ['c', 'b']) resumeOneItem(fake.agent, state, id)
    expect(ids(fake.inbox.nextTurn)).toEqual(['a', 'b', 'c', 'd'])
    expect(visibleOrder(fake.agent, state)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('keeps the whole order when the queue is paused', () => {
    const fake = fakeAgent([message('a'), message('b'), message('c')])
    const state = createQueueGateState()
    pauseAllItems(fake.agent, state)
    expect(fake.inbox.nextTurn).toEqual([])
    expect(visibleOrder(fake.agent, state)).toEqual(['a', 'b', 'c'])
    expect(moveQueueRow(fake.agent, state, 'c', 0)).toEqual({ order: ['c', 'a', 'b'] })
    expect(visibleOrder(fake.agent, state)).toEqual(['c', 'a', 'b'])
  })
})

describe('clearing the pause on an empty queue', () => {
  it('drops the pause when nothing is pending', () => {
    const fake = fakeAgent()
    const state = createQueueGateState()
    pauseAllItems(fake.agent, state)
    expect(state.globalPaused).toBe(true)
    expect(clearPauseWhenEmpty(fake.agent, state)).toBe(true)
    expect(state.globalPaused).toBe(false)
  })

  it('keeps the pause while any row is still held or queued', () => {
    const fake = fakeAgent([message('a')])
    const state = createQueueGateState()
    pauseAllItems(fake.agent, state)
    expect(clearPauseWhenEmpty(fake.agent, state)).toBe(false)
    expect(state.globalPaused).toBe(true)
  })

  it('drops the pause once the last held row is removed', () => {
    const fake = fakeAgent([message('a')])
    const state = createQueueGateState()
    pauseAllItems(fake.agent, state)
    removeHeldItem(state, 'a')
    expect(clearPauseWhenEmpty(fake.agent, state)).toBe(true)
    expect(state.globalPaused).toBe(false)
  })

  it('leaves an unpaused queue untouched', () => {
    const fake = fakeAgent()
    expect(clearPauseWhenEmpty(fake.agent, createQueueGateState())).toBe(false)
  })
})

describe('steering withdrawal', () => {
  it('removes a pending steering message and returns it to the front of the queue', () => {
    const fake = fakeAgent([message('queued')])
    fake.inbox.nextStep.push(message('steer', 'inserted task'))
    const state = createQueueGateState()
    revokeSteering(fake.agent, state, 'steer')
    expect(fake.inbox.nextStep).toEqual([])
    expect(ids(fake.inbox.nextTurn)).toEqual(['steer', 'queued'])
    expect(state.held).toHaveLength(0)
  })

  it('returns the withdrawn steering message to the front while the queue is paused', () => {
    const fake = fakeAgent([message('queued')])
    const state = createQueueGateState()
    pauseAllItems(fake.agent, state)
    fake.inbox.nextStep.push(message('steer'))
    revokeSteering(fake.agent, state, 'steer')
    expect(visibleOrder(fake.agent, state)).toEqual(['steer', 'queued'])
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

describe('wake helpers', () => {
  it('wakes an idle Agent once queued work is restored', () => {
    const fake = fakeAgent([message('a')])
    wakeQueue(fake.agent)
    expect(fake.maintenance.count).toBe(1)
    fake.maintenance.releaseAll()
  })

  it('does nothing without queued work or while the Agent runs', () => {
    const fake = fakeAgent()
    wakeQueue(fake.agent)
    expect(fake.maintenance.count).toBe(0)
  })
})
