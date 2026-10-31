/**
 * Wire contract: descriptor identity, parameter order, and strict codec
 * admission for both Typert faces.
 * @module dsh-message-queue/tests/wire
 */

import { describe, expect, it } from 'vitest'
import {
  MESSAGE_QUEUE_INVOCATIONS,
  MESSAGE_QUEUE_NAMESPACE,
  MESSAGE_QUEUE_PACKAGE,
  QUEUE_MOVE_DESCRIPTOR,
  QUEUE_ORDER_SCHEMA,
  QUEUE_STATE_DESCRIPTOR,
  QUEUE_STATE_SCHEMA,
} from '../src/wire.ts'

describe('invocation descriptors', () => {
  it('exposes the four queue methods in the shared namespace', () => {
    expect(MESSAGE_QUEUE_INVOCATIONS.map(item => item.method)).toEqual([
      'state',
      'move',
      'pause',
      'resume',
    ])
    for (const descriptor of MESSAGE_QUEUE_INVOCATIONS) {
      expect(descriptor.id).toBe(`${MESSAGE_QUEUE_PACKAGE}#${MESSAGE_QUEUE_NAMESPACE}/${descriptor.method}`)
      expect(descriptor.service).toBe(MESSAGE_QUEUE_NAMESPACE)
      expect(descriptor.namespace).toBe(MESSAGE_QUEUE_NAMESPACE)
      expect(descriptor.invocation).toEqual({ kind: 'direct' })
      expect(descriptor.parameters.every(parameter => parameter.source === 'json')).toBe(true)
    }
  })

  it('matches each method parameter list to the Host signature', () => {
    expect(QUEUE_STATE_DESCRIPTOR.parameters.map(parameter => parameter.name)).toEqual(['sessionId'])
    expect(QUEUE_MOVE_DESCRIPTOR.parameters.map(parameter => parameter.name)).toEqual([
      'sessionId',
      'itemId',
      'toIndex',
    ])
  })

  it('keeps descriptor results strict', () => {
    for (const descriptor of MESSAGE_QUEUE_INVOCATIONS) {
      expect(descriptor.result.mode).toBe('strict')
    }
  })
})

describe('strict codecs', () => {
  it('accepts a queue state projection and rejects a malformed one', () => {
    const codec = QUEUE_STATE_DESCRIPTOR.result
    expect(codec.mode).toBe('strict')
    if (codec.mode !== 'strict') return
    expect(codec.create().parse({
      available: true,
      paused: true,
      parked: [{ id: 'a', content: [{ type: 'text', text: 'hello' }] }],
      order: ['a'],
    })).toEqual({
      available: true,
      paused: true,
      parked: [{ id: 'a', content: [{ type: 'text', text: 'hello' }] }],
      order: ['a'],
    })
    expect(() => codec.create().parse({ available: true, paused: 'yes', parked: [], order: [] })).toThrow()
  })

  it('rejects a non-integer move index and an empty identity', () => {
    const indexCodec = QUEUE_MOVE_DESCRIPTOR.parameters[2]?.codec
    expect(indexCodec?.mode).toBe('strict')
    if (indexCodec?.mode !== 'strict') return
    expect(() => indexCodec.create().parse(1.5)).toThrow()
    const sessionIdCodec = QUEUE_MOVE_DESCRIPTOR.parameters[0]?.codec
    if (sessionIdCodec?.mode !== 'strict') return
    expect(() => sessionIdCodec.create().parse('')).toThrow()
  })

  it('exposes the order schema the Host returns', () => {
    expect(QUEUE_ORDER_SCHEMA.parse({ order: ['a', 'b'] })).toEqual({ order: ['a', 'b'] })
    expect(QUEUE_STATE_SCHEMA.parse({ available: false, paused: false, parked: [], order: [] }))
      .toEqual({ available: false, paused: false, parked: [], order: [] })
  })
})
