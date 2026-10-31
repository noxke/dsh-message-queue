/**
 * Wire vocabulary shared by the Host and browser faces: the queue-state JSON
 * shape, its strict codecs, and the invocation descriptors both Typert faces
 * register verbatim.
 * @module dsh-message-queue/wire
 */

import { z } from 'zod'
import type {
  InvocationDescriptor,
  RemoteResult,
  TypertCodec,
} from '@deepseek-ai/dsh-typert-protocol'

/** Package name; also the Client contribution owner and the bundle id. */
export const MESSAGE_QUEUE_PACKAGE = 'dsh-message-queue'

/** Cordis service key and Typert wire namespace. */
export const MESSAGE_QUEUE_NAMESPACE = 'messageQueue'

/** One queue item held by the plugin while its Session is paused. */
export interface ParkedItem {
  /** Message identity in the owning Session. */
  readonly id: string
  /**
   * Model-facing content blocks, JSON-safe. The field is a projection, not the
   * whole `UserMessage`: the source union and replay fields never cross the wire.
   */
  readonly content: readonly unknown[]
}

/** Observable state of one Session's queue. */
export interface QueueState {
  /** Whether a live Agent exists for this Session. */
  readonly available: boolean
  /** Whether the queue will stop claiming a new turn after the current one. */
  readonly paused: boolean
  /** Items held by the plugin; they are not in the Agent inbox while parked. */
  readonly parked: readonly ParkedItem[]
  /** Visible queue order: parked ids followed by `next-turn` ids. */
  readonly order: readonly string[]
}

/** New `next-turn` order after one move. */
export interface QueueOrder {
  /** Complete `next-turn` identity sequence, in the order the Host stored it. */
  readonly order: readonly string[]
}

/** Client-callable Remote face of the queue service. */
export interface MessageQueueRemote {
  /** Read the Session's queue state. */
  state(sessionId: string): Promise<RemoteResult<QueueState>>
  /** Move one `next-turn` item to `toIndex`, clamped to the list bounds. */
  move(sessionId: string, itemId: string, toIndex: number): Promise<RemoteResult<QueueOrder>>
  /** Pause claiming; the current turn finishes, later queued items stay queued. */
  pause(sessionId: string): Promise<RemoteResult<QueueState>>
  /** Resume claiming and restore parked items at the front of the queue. */
  resume(sessionId: string): Promise<RemoteResult<QueueState>>
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespaceMap {
    messageQueue: MessageQueueRemote
  }

  interface TypertRemoteMap {
    'messageQueue/state': (sessionId: string) => Promise<RemoteResult<QueueState>>
    'messageQueue/move': (
      sessionId: string,
      itemId: string,
      toIndex: number,
    ) => Promise<RemoteResult<QueueOrder>>
    'messageQueue/pause': (sessionId: string) => Promise<RemoteResult<QueueState>>
    'messageQueue/resume': (sessionId: string) => Promise<RemoteResult<QueueState>>
  }

  interface RemoteErrorDetailsMap {
    /** The Session has no live Agent to own a queue gate. */
    'message-queue/agent-not-attached': { readonly sessionId: string }
    /** The requested item is not in the Session's pending `next-turn` list. */
    'message-queue/item-not-found': { readonly sessionId: string; readonly itemId: string }
  }
}

/** Strict wire schema of one parked queue item. */
export const PARKED_ITEM_SCHEMA = z.object({
  id: z.string().min(1),
  content: z.array(z.json()),
})

/** Strict wire schema of {@link QueueState}. */
export const QUEUE_STATE_SCHEMA = z.object({
  available: z.boolean(),
  paused: z.boolean(),
  parked: z.array(PARKED_ITEM_SCHEMA),
  order: z.array(z.string()),
})

/** Strict wire schema of {@link QueueOrder}. */
export const QUEUE_ORDER_SCHEMA = z.object({
  order: z.array(z.string()),
})

/** Build the boundary codec both Typert faces carry for one type symbol. */
function strictCodec(typeSymbol: string, schema: z.ZodType): TypertCodec {
  return { mode: 'strict', typeSymbol, create: () => schema }
}

const SESSION_ID_CODEC = strictCodec('dsh-message-queue/types#SessionId', z.string().min(1))
const ITEM_ID_CODEC = strictCodec('dsh-message-queue/types#QueueItemId', z.string().min(1))
const INDEX_CODEC = strictCodec('dsh-message-queue/types#QueueIndex', z.number().int())
const STATE_RESULT_CODEC = strictCodec('dsh-message-queue/types#QueueState', QUEUE_STATE_SCHEMA)
const ORDER_RESULT_CODEC = strictCodec('dsh-message-queue/types#QueueOrder', QUEUE_ORDER_SCHEMA)

/** Frozen source position recorded for hand-written descriptors. */
const SOURCE = Object.freeze({ file: 'src/wire.ts', line: 1, column: 1 })

/** Describe one queue method; every parameter is plain JSON. */
function descriptor(
  method: keyof MessageQueueRemote,
  parameters: InvocationDescriptor['parameters'],
  result: TypertCodec,
): InvocationDescriptor {
  return Object.freeze({
    id: `${MESSAGE_QUEUE_PACKAGE}#${MESSAGE_QUEUE_NAMESPACE}/${method}`,
    service: MESSAGE_QUEUE_NAMESPACE,
    namespace: MESSAGE_QUEUE_NAMESPACE,
    method,
    invocation: Object.freeze({ kind: 'direct' as const }),
    parameters,
    result,
    sourceLocation: SOURCE,
  })
}

/** One parameter descriptor for a plain JSON field. */
function jsonParameter(name: string, codec: TypertCodec): InvocationDescriptor['parameters'][number] {
  return Object.freeze({ name, wire: name, source: 'json' as const, codec })
}

/** The `messageQueue/state` invocation. */
export const QUEUE_STATE_DESCRIPTOR = descriptor(
  'state',
  Object.freeze([jsonParameter('sessionId', SESSION_ID_CODEC)]),
  STATE_RESULT_CODEC,
)

/** The `messageQueue/move` invocation. */
export const QUEUE_MOVE_DESCRIPTOR = descriptor(
  'move',
  Object.freeze([
    jsonParameter('sessionId', SESSION_ID_CODEC),
    jsonParameter('itemId', ITEM_ID_CODEC),
    jsonParameter('toIndex', INDEX_CODEC),
  ]),
  ORDER_RESULT_CODEC,
)

/** The `messageQueue/pause` invocation. */
export const QUEUE_PAUSE_DESCRIPTOR = descriptor(
  'pause',
  Object.freeze([jsonParameter('sessionId', SESSION_ID_CODEC)]),
  STATE_RESULT_CODEC,
)

/** The `messageQueue/resume` invocation. */
export const QUEUE_RESUME_DESCRIPTOR = descriptor(
  'resume',
  Object.freeze([jsonParameter('sessionId', SESSION_ID_CODEC)]),
  STATE_RESULT_CODEC,
)

/**
 * Canonical invocation list: the Host manifest and the Client contribution
 * share these exact objects so the two codecs cannot drift.
 */
export const MESSAGE_QUEUE_INVOCATIONS: readonly InvocationDescriptor[] = Object.freeze([
  QUEUE_STATE_DESCRIPTOR,
  QUEUE_MOVE_DESCRIPTOR,
  QUEUE_PAUSE_DESCRIPTOR,
  QUEUE_RESUME_DESCRIPTOR,
])
