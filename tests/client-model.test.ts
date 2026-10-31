/**
 * Row-model behavior for the queue panel: merging held and queued rows,
 * optimistic ordering, group-clamped moves, and drag-target resolution.
 * @module dsh-message-queue/tests/client-model
 */

import { describe, expect, it } from 'vitest'
import {
  dragTarget,
  groupRange,
  matchesOrder,
  mergeRows,
  moveIds,
  moveWithinGroup,
  reorderRows,
  stepTarget,
  textOf,
} from '../src/client/model.ts'

const text = (value: string) => [{ type: 'text', text: value }]

/** Rows holding two parked items followed by three queued items. */
function mixedRows() {
  return mergeRows(
    [{ id: 'p1', content: text('p1') }, { id: 'p2', content: text('p2') }],
    [
      { id: 'q1', content: text('q1') },
      { id: 'q2', content: text('q2') },
      { id: 'q3', content: text('q3') },
    ],
  )
}

describe('textOf', () => {
  it('joins text blocks and skips other block kinds', () => {
    expect(textOf([{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }])).toBe('ab')
    expect(textOf([])).toBe('')
  })
})

describe('mergeRows', () => {
  it('puts held rows before queued rows and drops duplicates', () => {
    const rows = mergeRows(
      [{ id: 'a', content: text('parked') }],
      [{ id: 'a', content: text('stale') }, { id: 'b', content: text('queued') }],
    )
    expect(rows.map(row => `${row.kind}:${row.id}`)).toEqual(['parked:a', 'queued:b'])
  })
})

describe('reorderRows', () => {
  it('reorders by identity and keeps every row', () => {
    const rows = mixedRows()
    expect(reorderRows(rows, ['q2', 'p1', 'q1', 'q3', 'p2']).map(row => row.id))
      .toEqual(['q2', 'p1', 'q1', 'q3', 'p2'])
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

describe('groupRange', () => {
  it('reports the inclusive indexes of each group', () => {
    expect(groupRange(mixedRows(), 'parked')).toEqual({ start: 0, end: 1 })
    expect(groupRange(mixedRows(), 'queued')).toEqual({ start: 2, end: 4 })
    expect(groupRange([], 'queued')).toEqual({ start: 0, end: -1 })
  })
})

describe('moveWithinGroup', () => {
  it('moves a queued row inside its group', () => {
    expect(moveWithinGroup(mixedRows(), 'q3', 2)).toEqual(['p1', 'p2', 'q3', 'q1', 'q2'])
  })

  it('moves a held row inside the held group', () => {
    expect(moveWithinGroup(mixedRows(), 'p2', 0)).toEqual(['p2', 'p1', 'q1', 'q2', 'q3'])
  })

  it('clamps a queued row dragged above the queued group', () => {
    expect(moveWithinGroup(mixedRows(), 'q1', 0)).toEqual(['p1', 'p2', 'q1', 'q2', 'q3'])
  })

  it('clamps a held row carried past the held group', () => {
    expect(moveWithinGroup(mixedRows(), 'p1', 9)).toEqual(['p2', 'p1', 'q1', 'q2', 'q3'])
  })
})

describe('stepTarget', () => {
  it('returns the neighbour inside the group and undefined at its edge', () => {
    const rows = mixedRows()
    expect(stepTarget(rows, 'q2', -1)).toBe(2)
    expect(stepTarget(rows, 'q1', -1)).toBeUndefined()
    expect(stepTarget(rows, 'p1', 1)).toBe(1)
    expect(stepTarget(rows, 'p2', 1)).toBeUndefined()
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
    expect(matchesOrder(rows, ['p1', 'p2', 'q1', 'q2', 'q3'])).toBe(true)
    expect(matchesOrder(rows, ['q1', 'q2', 'q3'])).toBe(false)
  })
})
