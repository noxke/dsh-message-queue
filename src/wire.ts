/**
 * Wire vocabulary shared by the Host and browser faces: the queue-state JSON
 * shape, its strict boundary validators, and the invocation descriptors both
 * Typert faces register verbatim.
 * @module dsh-message-queue/wire
 */

import type {
  InvocationDescriptor,
  RemoteResult,
  TypertCodec,
  TypertSchema,
} from '@deepseek-ai/dsh-typert-protocol'

/** Package name; also the Client contribution owner and the bundle id. */
export const MESSAGE_QUEUE_PACKAGE = 'dsh-message-queue'

/** Cordis service key and Typert wire namespace. */
export const MESSAGE_QUEUE_NAMESPACE = 'messageQueue'

/** How long after a message leaves the queue it can still be withdrawn. */
export const REVOKE_WINDOW_MS = 15_000

/** One queue item held by the plugin while its Session is paused. */
export interface ParkedItem {
  /** Message identity in the owning Session. */
  readonly id: string
  /**
   * Model-facing content blocks, JSON-safe. The field is a projection, not the
   * whole `UserMessage`: the source union and replay fields never cross the wire.
   */
  readonly content: readonly unknown[]
  /** Why the row is held: an explicit per-item pause or the queue-wide pause. */
  readonly reason: 'manual' | 'global'
}

/** One steering message waiting for the running turn's next step boundary. */
export interface SteeringItem {
  /** Identity of the pending steering message. */
  readonly id: string
  /** Model-facing content blocks, JSON-safe. */
  readonly content: readonly unknown[]
}

/** One message the queue already sent to the model, revocable while it is recent. */
export interface SentItem {
  /** Identity of the sent message. */
  readonly id: string
  /** Model-facing content blocks, JSON-safe. */
  readonly content: readonly unknown[]
  /** Turn that claimed the message. */
  readonly turn: number
  /** Whether the message already entered the model-visible surface. */
  readonly delivered: boolean
  /** Remaining withdrawal time in milliseconds, measured at projection time. */
  readonly remainingMs: number
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
  /** Recently sent messages, newest last. */
  readonly sent: readonly SentItem[]
  /** Steering messages still waiting for a step boundary; revocable without a notice. */
  readonly steering: readonly SteeringItem[]
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
  /** Edit one held (parked) item's text in place. */
  edit(sessionId: string, itemId: string, text: string): Promise<RemoteResult<QueueState>>
  /** Discard one held (parked) item. */
  discard(sessionId: string, itemId: string): Promise<RemoteResult<QueueState>>
  /** Send one held (parked) item into the running turn ahead of the queue. */
  steer(sessionId: string, itemId: string): Promise<RemoteResult<QueueState>>
  /** Hold one queued item without pausing the queue. */
  pauseItem(sessionId: string, itemId: string): Promise<RemoteResult<QueueState>>
  /** Restore one held item; under a queue-wide pause this sends it immediately. */
  resumeItem(sessionId: string, itemId: string): Promise<RemoteResult<QueueState>>
  /** Withdraw one recently sent message and return its text to the queue. */
  revoke(sessionId: string, itemId: string): Promise<RemoteResult<QueueState>>
  /** Pause the queue; every queued item is held until a queue-wide resume. */
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
    'messageQueue/edit': (sessionId: string, itemId: string, text: string) => Promise<RemoteResult<QueueState>>
    'messageQueue/discard': (sessionId: string, itemId: string) => Promise<RemoteResult<QueueState>>
    'messageQueue/steer': (sessionId: string, itemId: string) => Promise<RemoteResult<QueueState>>
    'messageQueue/pauseItem': (sessionId: string, itemId: string) => Promise<RemoteResult<QueueState>>
    'messageQueue/resumeItem': (sessionId: string, itemId: string) => Promise<RemoteResult<QueueState>>
    'messageQueue/revoke': (sessionId: string, itemId: string) => Promise<RemoteResult<QueueState>>
    'messageQueue/pause': (sessionId: string) => Promise<RemoteResult<QueueState>>
    'messageQueue/resume': (sessionId: string) => Promise<RemoteResult<QueueState>>
  }

  interface RemoteErrorDetailsMap {
    /** The Session has no live Agent to own a queue gate. */
    'message-queue/agent-not-attached': { readonly sessionId: string }
    /** The requested item is neither queued nor held by the pause gate. */
    'message-queue/item-not-found': { readonly sessionId: string; readonly itemId: string }
    /** A held item was sent while no turn is running to accept steering. */
    'message-queue/steer-unavailable': { readonly sessionId: string; readonly itemId: string }
    /** A held item edit carried no non-whitespace text. */
    'message-queue/invalid-content': { readonly sessionId: string; readonly itemId: string }
    /** The withdrawal window for a sent message has closed. */
    'message-queue/revoke-expired': { readonly sessionId: string; readonly itemId: string }
  }
}

/** Raise the stable validation failure the Gateway turns into `gateway/bad-request`. */
function invalid(path: string, expected: string): never {
  throw new TypeError(`message-queue wire: ${path} must be ${expected}`)
}

/** Whether a value is a non-null, non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read one non-empty identity string. */
function readId(value: unknown, path: string): string {
  if (typeof value !== 'string' || value === '') invalid(path, 'a non-empty string')
  return value
}

/** Read one safe-integer index. */
function readIndex(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) invalid(path, 'a safe integer')
  return value
}

/** Read an array value. */
function readArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) invalid(path, 'an array')
  return value
}

/** Read an array of non-empty identity strings. */
function readIdArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) invalid(path, 'an array')
  return value.map((item, index) => readId(item, `${path}[${index}]`))
}

/** Read one parked item projection. */
function readParkedItem(value: unknown, path: string): ParkedItem {
  if (!isRecord(value)) invalid(path, 'an object')
  const content = value.content
  if (!Array.isArray(content)) invalid(`${path}.content`, 'an array')
  const reason = value.reason
  if (reason !== 'manual' && reason !== 'global') invalid(`${path}.reason`, "'manual' or 'global'")
  return { id: readId(value.id, `${path}.id`), content, reason }
}

/** Strict validator of one parked queue item. */
export const PARKED_ITEM_SCHEMA: TypertSchema = {
  parse(value: unknown): ParkedItem {
    return readParkedItem(value, 'parkedItem')
  },
}

/** Strict validator of one pending steering item. */
export const STEERING_ITEM_SCHEMA: TypertSchema = {
  parse(value: unknown): SteeringItem {
    if (!isRecord(value)) invalid('steeringItem', 'an object')
    const content = value.content
    if (!Array.isArray(content)) invalid('steeringItem.content', 'an array')
    return { id: readId(value.id, 'steeringItem.id'), content }
  },
}

/** Strict validator of one sent item. */
export const SENT_ITEM_SCHEMA: TypertSchema = {
  parse(value: unknown): SentItem {
    if (!isRecord(value)) invalid('sentItem', 'an object')
    const content = value.content
    if (!Array.isArray(content)) invalid('sentItem.content', 'an array')
    if (typeof value.turn !== 'number' || !Number.isSafeInteger(value.turn)) invalid('sentItem.turn', 'a safe integer')
    if (typeof value.delivered !== 'boolean') invalid('sentItem.delivered', 'a boolean')
    if (typeof value.remainingMs !== 'number' || !Number.isSafeInteger(value.remainingMs)) {
      invalid('sentItem.remainingMs', 'a safe integer')
    }
    return {
      id: readId(value.id, 'sentItem.id'),
      content,
      turn: value.turn,
      delivered: value.delivered,
      remainingMs: value.remainingMs,
    }
  },
}

/** Strict validator of {@link QueueState}. */
export const QUEUE_STATE_SCHEMA: TypertSchema = {
  parse(value: unknown): QueueState {
    if (!isRecord(value)) invalid('queueState', 'an object')
    if (typeof value.available !== 'boolean') invalid('queueState.available', 'a boolean')
    if (typeof value.paused !== 'boolean') invalid('queueState.paused', 'a boolean')
    const parked = value.parked
    if (!Array.isArray(parked)) invalid('queueState.parked', 'an array')
    return {
      available: value.available,
      paused: value.paused,
      parked: parked.map((item, index) => readParkedItem(item, `queueState.parked[${index}]`)),
      order: readIdArray(value.order, 'queueState.order'),
      sent: readArray(value.sent, 'queueState.sent').map(item => SENT_ITEM_SCHEMA.parse(item) as SentItem),
      steering: readArray(value.steering, 'queueState.steering')
        .map(item => STEERING_ITEM_SCHEMA.parse(item) as SteeringItem),
    }
  },
}

/** Strict validator of {@link QueueOrder}. */
export const QUEUE_ORDER_SCHEMA: TypertSchema = {
  parse(value: unknown): QueueOrder {
    if (!isRecord(value)) invalid('queueOrder', 'an object')
    return { order: readIdArray(value.order, 'queueOrder.order') }
  },
}

/** Build the boundary codec both Typert faces carry for one type symbol. */
function strictCodec(typeSymbol: string, schema: TypertSchema): TypertCodec {
  return { mode: 'strict', typeSymbol, create: () => schema }
}

const SESSION_ID_CODEC = strictCodec('dsh-message-queue/types#SessionId', {
  parse: (value: unknown) => readId(value, 'sessionId'),
})
const ITEM_ID_CODEC = strictCodec('dsh-message-queue/types#QueueItemId', {
  parse: (value: unknown) => readId(value, 'itemId'),
})
const INDEX_CODEC = strictCodec('dsh-message-queue/types#QueueIndex', {
  parse: (value: unknown) => readIndex(value, 'toIndex'),
})
const TEXT_CODEC = strictCodec('dsh-message-queue/types#QueueText', {
  parse: (value: unknown) => readId(value, 'text'),
})
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

/** The `messageQueue/edit` invocation. */
export const QUEUE_EDIT_DESCRIPTOR = descriptor(
  'edit',
  Object.freeze([
    jsonParameter('sessionId', SESSION_ID_CODEC),
    jsonParameter('itemId', ITEM_ID_CODEC),
    jsonParameter('text', TEXT_CODEC),
  ]),
  STATE_RESULT_CODEC,
)

/** The `messageQueue/discard` invocation. */
export const QUEUE_DISCARD_DESCRIPTOR = descriptor(
  'discard',
  Object.freeze([
    jsonParameter('sessionId', SESSION_ID_CODEC),
    jsonParameter('itemId', ITEM_ID_CODEC),
  ]),
  STATE_RESULT_CODEC,
)

/** The `messageQueue/steer` invocation. */
export const QUEUE_STEER_DESCRIPTOR = descriptor(
  'steer',
  Object.freeze([
    jsonParameter('sessionId', SESSION_ID_CODEC),
    jsonParameter('itemId', ITEM_ID_CODEC),
  ]),
  STATE_RESULT_CODEC,
)

/** The `messageQueue/revoke` invocation. */
export const QUEUE_REVOKE_DESCRIPTOR = descriptor(
  'revoke',
  Object.freeze([
    jsonParameter('sessionId', SESSION_ID_CODEC),
    jsonParameter('itemId', ITEM_ID_CODEC),
  ]),
  STATE_RESULT_CODEC,
)

/** The `messageQueue/pauseItem` invocation. */
export const QUEUE_PAUSE_ITEM_DESCRIPTOR = descriptor(
  'pauseItem',
  Object.freeze([
    jsonParameter('sessionId', SESSION_ID_CODEC),
    jsonParameter('itemId', ITEM_ID_CODEC),
  ]),
  STATE_RESULT_CODEC,
)

/** The `messageQueue/resumeItem` invocation. */
export const QUEUE_RESUME_ITEM_DESCRIPTOR = descriptor(
  'resumeItem',
  Object.freeze([
    jsonParameter('sessionId', SESSION_ID_CODEC),
    jsonParameter('itemId', ITEM_ID_CODEC),
  ]),
  STATE_RESULT_CODEC,
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
  QUEUE_EDIT_DESCRIPTOR,
  QUEUE_DISCARD_DESCRIPTOR,
  QUEUE_STEER_DESCRIPTOR,
  QUEUE_REVOKE_DESCRIPTOR,
  QUEUE_PAUSE_ITEM_DESCRIPTOR,
  QUEUE_RESUME_ITEM_DESCRIPTOR,
  QUEUE_PAUSE_DESCRIPTOR,
  QUEUE_RESUME_DESCRIPTOR,
])
