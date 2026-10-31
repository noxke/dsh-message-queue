/**
 * Browser half of dsh-message-queue: mounts the `messageQueue` Remote
 * contribution and replaces the built-in queue dock with the reordering and
 * pausable panel.
 * @module dsh-message-queue/client
 */

import { QueueDock } from './QueueDock.tsx'
import type {
  ClientContext,
  ClientScope,
  ConversationService,
  QueueDockInjected,
  SessionsService,
  SlotsService,
  UiConversationService,
} from './contracts.ts'
import { NS, en, zh } from './locales.ts'
import { MESSAGE_QUEUE_REMOTE } from './remote.ts'
import { installQueueStyles } from './styles.ts'
import type { QueueOrder, QueueState } from '../wire.ts'

/** Client services required before this plugin applies. */
export const inject = ['slots', 'locale', 'remote', 'sessions', 'uiConversation']

/** Seat replaced by this plugin; the built-in entry owns id `queue` at priority 0. */
const DOCK_SEAT = 'conversation.input.dock'

/** Lower priority shadows the built-in dock at the same cell. */
const DOCK_PRIORITY = -10

/** Panel entry ordering inside the seat. */
const DOCK_ORDER = 20

/** Unwrap one Remote envelope or throw its failure. */
function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }, method: string): T {
  if (!result.ok) throw new Error(`messageQueue.${method} failed: ${result.error.code}: ${result.error.message}`)
  return result.value
}

/** Build the per-Session injected facade the dock renders against. */
function createInjected(scope: ClientScope, sessionId: string): QueueDockInjected {
  const sessions = scope.get('sessions') as SessionsService | undefined
  const conversation = sessions?.scope(sessionId)?.get('conversation') as ConversationService | undefined
  const uiConversation = scope.get('uiConversation') as UiConversationService | undefined
  const remote = scope.remote.messageQueue
  const requireConversation = (): ConversationService => {
    if (conversation === undefined) throw new Error('message-queue: conversation service unavailable')
    return conversation
  }
  return {
    queue: {
      state: async (): Promise<QueueState> => unwrap(await remote.state(sessionId), 'state'),
      move: async (itemId: string, toIndex: number): Promise<QueueOrder> =>
        unwrap(await remote.move(sessionId, itemId, toIndex), 'move'),
      edit: async (itemId: string, text: string): Promise<QueueState> =>
        unwrap(await remote.edit(sessionId, itemId, text), 'edit'),
      discard: async (itemId: string): Promise<QueueState> =>
        unwrap(await remote.discard(sessionId, itemId), 'discard'),
      steer: async (itemId: string): Promise<QueueState> =>
        unwrap(await remote.steer(sessionId, itemId), 'steer'),
      pauseItem: async (itemId: string): Promise<QueueState> =>
        unwrap(await remote.pauseItem(sessionId, itemId), 'pauseItem'),
      resumeItem: async (itemId: string): Promise<QueueState> =>
        unwrap(await remote.resumeItem(sessionId, itemId), 'resumeItem'),
      pause: async (): Promise<QueueState> => unwrap(await remote.pause(sessionId), 'pause'),
      resume: async (): Promise<QueueState> => unwrap(await remote.resume(sessionId), 'resume'),
    },
    updateQueue: (itemId, action) => requireConversation().updateQueue(itemId, action),
    notify: (level, text) => {
      requireConversation().input.for(scope).notify(level, text)
    },
    loadImage: async (attachment: unknown): Promise<string> => {
      if (uiConversation === undefined) throw new Error('message-queue: uiConversation service unavailable')
      return uiConversation.imageUrl(sessionId, attachment)
    },
  }
}

/**
 * Register the panel in place of the built-in queue dock.
 * @returns disposer for the seat registration.
 */
function registerDock(scope: ClientScope): () => void {
  const slots = scope.get('slots') as SlotsService | undefined
  if (slots === undefined) throw new Error('message-queue: slots service unavailable')
  return slots.inject(DOCK_SEAT, () => slots.register({
    name: DOCK_SEAT,
    id: 'queue',
    order: DOCK_ORDER,
    priority: DOCK_PRIORITY,
    locale: NS,
    inject: (sessionId: string) => createInjected(scope, sessionId),
  }, QueueDock))
}

/**
 * Mount dictionaries, the Remote contribution, and the queue panel.
 * @param ctx - client root context.
 */
export async function apply(ctx: ClientContext): Promise<void> {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-message-queue: dictionaries')
  ctx.effect(() => installQueueStyles(), 'dsh-message-queue: stylesheet')
  await ctx.remote.$mount(MESSAGE_QUEUE_REMOTE)
  ctx.inject(['remote.messageQueue'], (scope) => {
    ctx.effect(() => registerDock(scope), 'dsh-message-queue: queue dock')
  })
}

export { QueueDock }
export type { QueueDockInjected } from './contracts.ts'
