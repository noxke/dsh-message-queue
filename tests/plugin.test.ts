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
    expect(service.state('missing')).toEqual({ available: false, paused: false, parked: [], order: [], sent: [] })
    expect(() => service.move('missing', 'a', 0)).toThrowError(/has no live agent/)
    await ctx.fiber.dispose()
  })

  it('holds the queued items and opens the gate when the queue is paused', async () => {
    const { ctx, service, agents } = await mount()
    const fake = fakeAgent('session-1', [message('a'), message('b')])
    agents.set('session-1', fake)

    const paused = service.pause('session-1')
    expect(paused.paused).toBe(true)
    expect(paused.parked.map(item => `${item.id}:${item.reason}`)).toEqual(['a:global', 'b:global'])
    expect(fake.inbox.nextTurn).toEqual([])
    expect(fake.maintenance).toBe(1)
    await ctx.fiber.dispose()
  })

  it('parks a submission inserted while the queue is paused', async () => {
    const { ctx, service, agents } = await mount()
    const fake = fakeAgent('session-1')
    agents.set('session-1', fake)
    service.pause('session-1')

    fake.inbox.nextTurn.push(message('late'))
    ctx.emit('agent/inbox/inserted', { agent: fake.agent, message: message('late') })
    expect(fake.inbox.nextTurn).toEqual([])
    expect(service.state('session-1').parked.map(item => `${item.id}:${item.reason}`)).toEqual(['late:global'])
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

  it('runs an explicitly resumed item before re-arming the queue pause', async () => {
    const { ctx, service, agents } = await mount()
    const fake = fakeAgent('session-1', [message('a')])
    fake.status = 'running'
    agents.set('session-1', fake)
    service.pause('session-1')
    expect(fake.inbox.nextTurn).toEqual([])

    service.resumeItem('session-1', 'a')
    expect(fake.inbox.nextTurn.map(item => String(item.id))).toEqual(['a'])
    expect(service.state('session-1').paused).toBe(true)

    fake.status = 'idle'
    ctx.emit('agent/status', { agent: fake.agent, status: 'idle' })
    // The bypass item keeps the driver waking instead of re-arming the gate.
    expect(fake.maintenance).toBe(1)

    fake.inbox.nextTurn.length = 0
    ctx.emit('agent/inbox/claimed', { agent: fake.agent, message: message('a'), turn: 1 })
    expect(service.state('session-1').paused).toBe(true)
    fake.releaseMaintenance()
    await ctx.fiber.dispose()
  })

  it('tracks claimed messages and revokes a delivered one through a surface replacement', async () => {
    const { ctx, service, agents } = await mount()
    const fake = fakeAgent('session-1')
    agents.set('session-1', fake)

    ctx.emit('agent/inbox/claimed', { agent: fake.agent, message: message('a'), turn: 3 })
    expect(service.state('session-1').sent).toEqual([
      expect.objectContaining({ id: 'a', turn: 3, delivered: false }),
    ])

    fake.status = 'idle'
    ctx.emit('session/event', fake.agent.session, { type: 'user/message', data: message('a'), seq: 41 } as never)
    expect(service.state('session-1').sent[0]?.delivered).toBe(true)

    const after = service.revoke('session-1', 'a')
    expect(after.sent).toEqual([])
    expect(fake.inbox.nextTurn).toHaveLength(1)
    expect(String(fake.inbox.nextTurn[0]?.id)).not.toBe('a')
    expect(fake.appended).toHaveLength(1)
    const appended = fake.appended[0] as { type: string; intent: { surfaceOp: { startSeq: number } } }
    expect(appended.type).toBe('user/message')
    expect(Number(appended.intent.surfaceOp.startSeq)).toBe(41)
    fake.releaseMaintenance()
    await ctx.fiber.dispose()
  })

  it('reopens the gate when an idle Agent returns to the paused queue', async () => {
    const { ctx, service, agents } = await mount()
    const fake = fakeAgent('session-1', [message('a')])
    fake.status = 'running'
    agents.set('session-1', fake)
    service.pause('session-1')
    expect(fake.maintenance).toBe(0)

    fake.status = 'idle'
    ctx.emit('agent/status', { agent: fake.agent, status: 'idle' })
    expect(fake.maintenance).toBe(1)
    fake.releaseMaintenance()
    await ctx.fiber.dispose()
  })
})
