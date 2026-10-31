/**
 * Structural contracts the browser half reads from the DSH client. Each
 * interface names only the members this plugin uses, so a small UI-package
 * change does not break the build.
 * @module dsh-message-queue/client/contracts
 */

import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import type { MessageQueueRemote } from '../wire.ts'
import type { Translate } from './locales.ts'

/** One queued message echoed by the Session projection. */
export interface InboxItem {
  readonly id: string
  readonly content: readonly unknown[]
  /** Producer facts the panel reads to match in-flight submission echoes. */
  readonly source?: { readonly kind?: string; readonly rpcId?: string }
}

/** Pending `next-turn` / `next-step` projection value. */
export interface InboxProjection {
  readonly 'next-turn'?: readonly InboxItem[]
  readonly 'next-step'?: readonly InboxItem[]
}

/** Browser-owned attachment awaiting Host admission. */
export interface PendingAttachment {
  readonly type: 'image' | 'file'
  readonly value: {
    readonly previewUrl?: string
    readonly name?: string
    readonly bytes?: number
    readonly attachmentId?: string
  }
}

/** One submission still in flight from this browser. */
export interface PendingSubmission {
  readonly requestId: string
  readonly placement: 'queued' | 'transcript'
  readonly text: string
  readonly attachments: readonly PendingAttachment[]
}

/** Session fields the panel renders. */
export interface SessionSnapshot {
  readonly running: boolean
  readonly subagent: { readonly address?: { readonly mode?: string } } | null | undefined
  readonly pendingSubmissions: readonly PendingSubmission[]
}

/** Selector hook over the current Session snapshot. */
export type UseSession = <T>(selector: (snapshot: SessionSnapshot) => T) => T

/** Projection reader for Host-computed values. */
export type UseProjection = (key: 'inbox', selector?: (value: unknown) => unknown) => unknown

/** One client-requested queue mutation. */
export type QueueAction =
  | { readonly kind: 'edit'; readonly content: readonly { readonly type: 'text'; readonly text: string }[] }
  | { readonly kind: 'remove' }
  | { readonly kind: 'steer' }

/** Session-scoped conversation service. */
export interface ConversationService {
  updateQueue(itemId: string, action: QueueAction): Promise<void>
  input: {
    for(context: unknown): { notify(level: 'info' | 'error', text: string): void }
  }
}

/** Conversation UI service helpers. */
export interface UiConversationService {
  imageUrl(sessionId: string, attachment: unknown): Promise<string>
}

/** Session service used to resolve one Session's scoped context. */
export interface SessionsService {
  scope(sessionId: string): { get(name: string): unknown } | undefined
}

/** Slot registration options this plugin sets. */
export interface SlotEntryOptions {
  readonly name: 'conversation.input.dock'
  readonly id: string
  readonly order: number
  readonly priority: number
  readonly locale: string
  readonly inject: (sessionId: string) => QueueDockInjected
}

/** Client slots registry face. */
export interface SlotsService {
  inject(seat: string, register: () => () => void): () => void
  register(options: SlotEntryOptions, component: unknown): () => void
}

/** Client locale registry face. */
export interface LocaleService {
  register(namespace: string, dictionaries: { readonly zh: object; readonly en: object }): () => void
}

/** Client Remote face after this plugin mounts its contribution. */
export interface ClientRemote {
  $mount(contribution: TypertRemoteContribution): Promise<unknown>
  messageQueue: MessageQueueRemote
}

/** Injected scope handed to a client `inject` callback. */
export interface ClientScope {
  get(name: string): unknown
  readonly remote: ClientRemote
}

/** Client root context. */
export interface ClientContext {
  effect(callback: () => void | (() => void), label?: string): void
  inject(dependencies: readonly string[], callback: (scope: ClientScope) => void): void
  readonly remote: ClientRemote
  readonly locale: LocaleService
}

/** Operations the dock calls for the Session it renders. */
export interface QueueDockInjected {
  readonly queue: {
    state(): Promise<import('../wire.ts').QueueState>
    move(itemId: string, toIndex: number): Promise<import('../wire.ts').QueueOrder>
    pause(): Promise<import('../wire.ts').QueueState>
    resume(): Promise<import('../wire.ts').QueueState>
  }
  updateQueue(itemId: string, action: QueueAction): Promise<void>
  notify(level: 'info' | 'error', text: string): void
  loadImage(attachment: unknown): Promise<string>
}

/** Complete props of the queue dock entry. */
export interface QueueDockProps extends QueueDockInjected {
  readonly sessionId: string
  readonly useSession: UseSession
  readonly useProjection: UseProjection
  readonly t: Translate
}
