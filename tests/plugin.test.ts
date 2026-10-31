/**
 * Mount contract: the plugin entry registers the `messageQueue` Remote service
 * and keeps the pause gate wired to Agent inbox and status events.
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
  abortMaintenance: (reason?: Error) => void
}

/** Build a fake Agent rooted at one Session identity. */
function fakeAgent(id: string, initial: UserMessage[] = []): FakeAgent {
  const inbox = { nextTurn: [...initial], nextStep: [] as UserMessage[] }
  const holder = { controller: undefined as AbortController | undefined }
  const fake = {
    status: 'idle' as 'idle' | 'running',
    inbox,
    maintenance: 0,
    abortMaintenance: (reason?: Error) => { holder.controller?.abort(reason) },
    agent: undefined as unknown as Agent,
  }
  fake.agent = {
    id: id as unknown as SessionId,
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
    send(item: UserMessage, target: 'next-turn' | 'next-step') {
      const list = target === 'next-turn' ? inbox.nextTurn : inbox.nextStep
      list.push(item)
    },
    runMaintenance(task: (signal: AbortSignal) => Promise<unknown>) {
      fake.maintenance += 1
      const controller = new AbortController()
      holder.controller = controller
      const settled = task(controller.signal)
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
  it('registers the Remote service under the messageQueue key', async () => {
    const { ctx, service } = await mount()
    expect(typeof service.state).toBe('function')
    expect(typeof service.move).toBe('function')
    expect(typeof service.pause).toBe('function')
    expect(typeof service.resume).toBe('function')
    await ctx.fiber.dispose()
  })

  it('reports unavailable for a Session without a live Agent', async () => {
    const { ctx, service } = await mount()
    expect(service.state('missing')).toEqual({ available: false, paused: false, parked: [], order: [] })
    expect(() => service.move('missing', 'a', 0)).toThrowError(/has no live agent/)
    await ctx.fiber.dispose()
  })

  it('parks the queue when paused while running and opens the gate on idle', async () => {
    const { ctx, service, agents } = await mount()
    const fake = fakeAgent('session-1', [message('a'), message('b')])
    fake.status = 'running'
    agents.set('session-1', fake)

    const paused = service.pause('session-1')
    expect(paused.paused).toBe(true)
    expect(paused.parked.map(item => item.id)).toEqual(['a', 'b'])
    expect(fake.inbox.nextTurn).toEqual([])
    expect(fake.maintenance).toBe(0)

    fake.status = 'idle'
    ctx.emit('agent/status', { agent: fake.agent, status: 'idle' })
    expect(fake.maintenance).toBe(1)
    await ctx.fiber.dispose()
  })

  it('parks a submission inserted before the running turn ends', async () => {
    const { ctx, service, agents } = await mount()
    const fake = fakeAgent('session-1', [message('a')])
    fake.status = 'running'
    agents.set('session-1', fake)
    service.pause('session-1')

    fake.inbox.nextTurn.push(message('late'))
    ctx.emit('agent/inbox/inserted', { agent: fake.agent, message: message('late') })
    expect(fake.inbox.nextTurn).toEqual([])
    expect(service.state('session-1').parked.map(item => item.id)).toEqual(['a', 'late'])
    await ctx.fiber.dispose()
  })

  it('restores parked items on resume', async () => {
    const { ctx, service, agents } = await mount()
    const fake = fakeAgent('session-1', [message('a')])
    agents.set('session-1', fake)
    service.pause('session-1')
    expect(fake.maintenance).toBe(1)

    const resumed = service.resume('session-1')
    expect(resumed.paused).toBe(false)
    expect(fake.inbox.nextTurn.map(item => item.id)).toEqual(['a'])
    expect(service.state('session-1').paused).toBe(false)
    await ctx.fiber.dispose()
  })
})
