/**
 * Mount contract: the plugin entry registers the `messageQueue` Remote service
 * and keeps the pause state wired to Agent inbox and status events.
 * @module dsh-message-queue/tests/plugin
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import * as plugin from '../src/index.ts'
import type { MessageQueueService } from '../src/service.ts'

/** Build one user message with a stable identity. */
function message(id: string): UserMessage {
  return {
    id: id as unknown as MessageId,
    role: 'user',
    content: [{ type: 'text', text: id }],
    source: { kind: 'user' } as UserMessage['source'],
  }
}

/** Structural Agent stand-in shared by the mounting tests. */
interface FakeAgent {
  agent: Agent
  readonly inbox: { nextTurn: UserMessage[]; nextStep: UserMessage[] }
  status: 'idle' | 'running'
  maintenance: number
  releaseMaintenance: () => void
  /** Session append calls recorded for revocation tests. */
  readonly appended: Array<{ type: string; data: unknown; intent: unknown }>
}

/** Build a fake Agent rooted at one Session identity. */
function fakeAgent(id: string, initial: UserMessage[] = []): FakeAgent {
  const inbox = { nextTurn: [...initial], nextStep: [] as UserMessage[] }
  const releases: Array<() => void> = []
  const fake = {
    status: 'idle' as 'idle' | 'running',
    inbox,
    maintenance: 0,
    releaseMaintenance: () => { for (const release of releases.splice(0)) release() },
    appended: [] as Array<{ type: string; data: unknown; intent: unknown }>,
    agent: undefined as unknown as Agent,
  }
  fake.agent = {
    id: id as unknown as SessionId,
    session: {
      id: id as unknown as SessionId,
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
    steer() { /* steering is covered by the queue unit tests */ },
    runMaintenance(task: (signal: AbortSignal) => Promise<unknown>) {
      fake.maintenance += 1
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

/** Boot a root Context with a fake Agent registry and mount the plugin. */
async function mount(): Promise<{ ctx: Context; service: MessageQueueService; agents: Map<string, FakeAgent> }> {
  const ctx = new Context()
  const agents = new Map<string, FakeAgent>()
  ctx.provide('agents', { get: (id: string) => agents.get(id)?.agent })
  await ctx.plugin(plugin, { enabled: true })
  const service = ctx.get('messageQueue') as MessageQueueService
  expect(service).toBeDefined()
  return { ctx, service, agents }
}

describe('plugin mounting', () => {
  it('registers every Remote method under the messageQueue key', async () => {
    const { ctx, service } = await mount()
    for (const method of ['state', 'move', 'edit', 'discard', 'steer', 'pauseItem', 'resumeItem', 'pause', 'resume']) {
      expect(typeof (service as unknown as Record<string, unknown>)[method]).toBe('function')
    }
    await ctx.fiber.dispose()
  })

  it('reports unavailable for a Session without a live Agent', async () => {
    const { ctx, service } = await mount()
    expect(service.state('missing')).toEqual({
      available: false, paused: false, parked: [], order: [], steering: [],
    })
    expect(() => service.move('missing', 'a', 0)).toThrowError(/has no live agent/)
    await ctx.fiber.dispose()
  })

  it('holds the queued items when the queue is paused', async () => {
    const { ctx, service, agents } = await mount()
    const fake = fakeAgent('session-1', [message('a'), message('b')])
    agents.set('session-1', fake)

    const paused = service.pause('session-1')
    expect(paused.paused).toBe(true)
    expect(paused.parked.map(item => `${item.id}:${item.reason}`)).toEqual(['a:global', 'b:global'])
    expect(fake.inbox.nextTurn).toEqual([])
    expect(fake.maintenance).toBe(0)
    await ctx.fiber.dispose()
  })

  it('parks a submission inserted while the queue is paused', async () => {
    const { ctx, service, agents } = await mount()
    const fake = fakeAgent('session-1', [message('held')])
    agents.set('session-1', fake)
    service.pause('session-1')

    fake.inbox.nextTurn.push(message('late'))
    ctx.emit('agent/inbox/inserted', { agent: fake.agent, message: message('late') })
    expect(fake.inbox.nextTurn).toEqual([])
    expect(service.state('session-1').parked.map(item => `${item.id}:${item.reason}`))
      .toEqual(['held:global', 'late:global'])
    await ctx.fiber.dispose()
  })

  it('restores only queue-wide held items on resume', async () => {
    const { ctx, service, agents } = await mount()
    const fake = fakeAgent('session-1', [message('a')])
    agents.set('session-1', fake)
    service.pause('session-1')

    const resumed = service.resume('session-1')
    expect(resumed.paused).toBe(false)
    expect(fake.inbox.nextTurn.map(item => String(item.id))).toEqual(['a'])
    fake.releaseMaintenance()
    await ctx.fiber.dispose()
  })

  it('keeps a per-item pause across a queue-wide resume', async () => {
    const { ctx, service, agents } = await mount()
    const fake = fakeAgent('session-1', [message('a'), message('b')])
    agents.set('session-1', fake)

    service.pauseItem('session-1', 'b')
    expect(service.state('session-1').parked.map(item => `${item.id}:${item.reason}`)).toEqual(['b:manual'])
    service.resume('session-1')
    expect(service.state('session-1').parked.map(item => `${item.id}:${item.reason}`)).toEqual(['b:manual'])
    fake.releaseMaintenance()
    await ctx.fiber.dispose()
  })

  it('restores an explicitly resumed item at its position while the queue stays paused', async () => {
    const { ctx, service, agents } = await mount()
    const fake = fakeAgent('session-1', [message('a'), message('b')])
    agents.set('session-1', fake)
    service.pause('session-1')
    expect(fake.inbox.nextTurn).toEqual([])

    const resumed = service.resumeItem('session-1', 'b')
    expect(fake.inbox.nextTurn.map(item => String(item.id))).toEqual(['b'])
    expect(resumed.order).toEqual(['a', 'b'])
    expect(resumed.paused).toBe(true)

    fake.inbox.nextTurn.length = 0
    ctx.emit('agent/inbox/claimed', { agent: fake.agent, message: message('b'), turn: 1 })
    // The queue still holds "a", so the pause stays armed.
    expect(service.state('session-1').paused).toBe(true)
    fake.releaseMaintenance()
    await ctx.fiber.dispose()
  })

  it('clears the queue-wide pause when the queue becomes empty', async () => {
    const { ctx, service, agents } = await mount()
    const fake = fakeAgent('session-1', [message('a')])
    agents.set('session-1', fake)
    expect(service.pause('session-1').paused).toBe(true)
    expect(service.state('session-1').parked.map(item => item.id)).toEqual(['a'])

    expect(service.discard('session-1', 'a').paused).toBe(false)
    fake.releaseMaintenance()
    await ctx.fiber.dispose()
  })

  it('keeps a pause requested on an empty queue from sticking', async () => {
    const { ctx, service, agents } = await mount()
    const fake = fakeAgent('session-1')
    agents.set('session-1', fake)
    expect(service.pause('session-1').paused).toBe(false)
    fake.releaseMaintenance()
    await ctx.fiber.dispose()
  })

  it('leaves an idle Agent alone while a paused queue waits for a resume', async () => {
    const { ctx, service, agents } = await mount()
    const fake = fakeAgent('session-1', [message('a')])
    fake.status = 'running'
    agents.set('session-1', fake)
    service.pause('session-1')

    fake.status = 'idle'
    ctx.emit('agent/status', { agent: fake.agent, status: 'idle' })
    expect(fake.maintenance).toBe(0)
    await ctx.fiber.dispose()
  })
})
