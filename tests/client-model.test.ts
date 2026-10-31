/**
 * Row-model behavior for the queue panel: merging held and queued rows,
 * optimistic ordering, group-clamped moves, and drag-target resolution.
 * @module dsh-message-queue/tests/client-model
 */

import { describe, expect, it } from 'vitest'
import {
  dragTarget,
  matchesOrder,
  mergeRows,
  moveIds,
  moveRow,
  reorderRows,
  stepTarget,
  textOf,
} from '../src/client/model.ts'

const text = (value: string) => [{ type: 'text', text: value }]

/** One linear queue: two paused rows interleaved with three queued rows. */
function mixedRows() {
  return mergeRows(
    [
      { id: 'p1', content: text('p1'), reason: 'global' },
      { id: 'p2', content: text('p2'), reason: 'manual' },
    ],
    [
      { id: 'q1', content: text('q1') },
      { id: 'q2', content: text('q2') },
      { id: 'q3', content: text('q3') },
    ],
    ['q1', 'p1', 'q2', 'p2', 'q3'],
  )
}

describe('textOf', () => {
  it('joins text blocks and skips other block kinds', () => {
    expect(textOf([{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }])).toBe('ab')
    expect(textOf([])).toBe('')
  })
})

describe('mergeRows', () => {
  it('follows the host order so paused rows keep their position', () => {
    const rows = mergeRows(
      [{ id: 'a', content: text('parked'), reason: 'global' }],
      [{ id: 'b', content: text('queued') }],
      ['b', 'a'],
    )
    expect(rows.map(row => `${row.kind}:${row.id}`)).toEqual(['queued:b', 'parked:a'])
  })

  it('appends rows the host order does not mention', () => {
    const rows = mergeRows(
      [{ id: 'a', content: text('parked'), reason: 'manual' }],
      [{ id: 'b', content: text('queued') }],
      [],
    )
    expect(rows.map(row => row.id)).toEqual(['a', 'b'])
  })
})

describe('reorderRows', () => {
  it('reorders by identity and keeps every row', () => {
    const rows = mixedRows()
    expect(reorderRows(rows, ['q2', 'p1', 'q1', 'p2', 'q3']).map(row => row.id))
      .toEqual(['q2', 'p1', 'q1', 'p2', 'q3'])
  })

  it('falls back to the current order when ids do not cover every row', () => {
    const rows = mixedRows()
    expect(reorderRows(rows, ['q1']).map(row => row.id)).toEqual(rows.map(row => row.id))
  })
})

describe('moveIds', () => {
  it('moves inside the sequence and clamps the destination', () => {
    expect(moveIds(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b'])
    expect(moveIds(['a', 'b', 'c'], 0, 99)).toEqual(['b', 'c', 'a'])
    expect(moveIds(['a'], 4, 0)).toEqual(['a'])
  })
})

describe('moveRow', () => {
  it('moves a queued row past paused rows', () => {
    expect(moveRow(mixedRows(), 'q3', 0)).toEqual(['q3', 'q1', 'p1', 'q2', 'p2'])
  })

  it('moves a paused row to the front without leaving the queue', () => {
    expect(moveRow(mixedRows(), 'p2', 0)).toEqual(['p2', 'q1', 'p1', 'q2', 'q3'])
  })

  it('clamps a destination past either end', () => {
    expect(moveRow(mixedRows(), 'q1', 99)).toEqual(['p1', 'q2', 'p2', 'q3', 'q1'])
    expect(moveRow(mixedRows(), 'q3', -5)).toEqual(['q3', 'q1', 'p1', 'q2', 'p2'])
  })
})

describe('stepTarget', () => {
  it('returns the neighbouring row and undefined at either end', () => {
    const rows = mixedRows()
    expect(stepTarget(rows, 'p1', 1)).toBe(2)
    expect(stepTarget(rows, 'q1', -1)).toBeUndefined()
    expect(stepTarget(rows, 'q3', 1)).toBeUndefined()
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
  it('compares the complete visible sequence', () => {
    const rows = mixedRows()
    expect(matchesOrder(rows, ['q1', 'p1', 'q2', 'p2', 'q3'])).toBe(true)
    expect(matchesOrder(rows, ['q1', 'q2', 'q3'])).toBe(false)
  })
})
