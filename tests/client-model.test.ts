/**
 * Row-model behavior for the queue panel: merging parked and queued rows,
 * optimistic ordering, and drag-target resolution.
 * @module dsh-message-queue/tests/client-model
 */

import { describe, expect, it } from 'vitest'
import {
  dragTarget,
  matchesOrder,
  mergeRows,
  moveIds,
  reorderQueued,
  textOf,
} from '../src/client/model.ts'

const text = (value: string) => [{ type: 'text', text: value }]

describe('textOf', () => {
  it('joins text blocks and skips other block kinds', () => {
    expect(textOf([{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }])).toBe('ab')
    expect(textOf([])).toBe('')
  })
})

describe('mergeRows', () => {
  it('puts parked rows before queued rows and drops duplicates', () => {
    const rows = mergeRows(
      [{ id: 'a', content: text('parked') }],
      [{ id: 'a', content: text('stale') }, { id: 'b', content: text('queued') }],
    )
    expect(rows.map(row => `${row.kind}:${row.id}`)).toEqual(['parked:a', 'queued:b'])
  })
})

describe('reorderQueued', () => {
  it('reorders queued rows and preserves parked rows in front', () => {
    const rows = mergeRows([{ id: 'p', content: text('p') }], [
      { id: 'a', content: text('a') },
      { id: 'b', content: text('b') },
    ])
    const reordered = reorderQueued(rows, ['b', 'a'])
    expect(reordered.map(row => row.id)).toEqual(['p', 'b', 'a'])
  })

  it('leaves rows unchanged when the order is empty', () => {
    const rows = mergeRows([], [{ id: 'a', content: text('a') }])
    expect(reorderQueued(rows, []).map(row => row.id)).toEqual(['a'])
  })
})

describe('moveIds', () => {
  it('moves inside the sequence and clamps the destination', () => {
    expect(moveIds(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b'])
    expect(moveIds(['a', 'b', 'c'], 0, 99)).toEqual(['b', 'c', 'a'])
    expect(moveIds(['a'], 4, 0)).toEqual(['a'])
  })
})

describe('dragTarget', () => {
  it('maps a pointer position to the row it sits over', () => {
    expect(dragTarget([10, 30, 50], 5)).toBe(0)
    expect(dragTarget([10, 30, 50], 25)).toBe(1)
    expect(dragTarget([10, 30, 50], 60)).toBe(2)
    expect(dragTarget([], 60)).toBe(0)
  })
})

describe('matchesOrder', () => {
  it('compares only queued identities', () => {
    const rows = mergeRows([{ id: 'p', content: text('p') }], [
      { id: 'a', content: text('a') },
      { id: 'b', content: text('b') },
    ])
    expect(matchesOrder(rows, ['a', 'b'])).toBe(true)
    expect(matchesOrder(rows, ['b', 'a'])).toBe(false)
  })
})
