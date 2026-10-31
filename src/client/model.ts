/**
 * Pure queue-row helpers for the browser panel: row merging, optimistic
 * ordering, group-clamped moves, and drag target resolution.
 * @module dsh-message-queue/client/model
 */

import type { ParkedItem } from '../wire.ts'

/** One row shown by the queue panel. */
export interface QueueRow {
  readonly kind: 'queued' | 'parked'
  readonly id: string
  readonly content: readonly unknown[]
}

/** One queued item echoed from the Session projection. */
export interface QueuedItem {
  readonly id: string
  readonly content: readonly unknown[]
}

/** Inclusive index range occupied by one row kind. */
export interface RowRange {
  readonly start: number
  readonly end: number
}

/**
 * Read the text blocks of one row.
 * @param content - model-facing content blocks.
 * @returns the concatenated text, or an empty string when the row has no text.
 */
export function textOf(content: readonly unknown[]): string {
  const parts: string[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const { type, text } = block as { type?: unknown; text?: unknown }
    if (type === 'text' && typeof text === 'string') parts.push(text)
  }
  return parts.join('')
}

/**
 * Merge the parked projection and the inbox projection into display rows.
 * Held rows come first: they were queued before anything the pause gate let in.
 * @param parked - items held by the pause gate.
 * @param queued - pending `next-turn` rows from the inbox projection.
 * @returns rows in visible queue order.
 */
export function mergeRows(
  parked: readonly ParkedItem[],
  queued: readonly QueuedItem[],
): QueueRow[] {
  const parkedIds = new Set(parked.map(item => item.id))
  return [
    ...parked.map(item => ({ kind: 'parked' as const, id: item.id, content: item.content })),
    ...queued
      .filter(item => !parkedIds.has(item.id))
      .map(item => ({ kind: 'queued' as const, id: item.id, content: item.content })),
  ]
}

/**
 * Apply an optimistic identity order to the display rows.
 * @param rows - current display rows.
 * @param order - desired identity sequence; unknown ids are dropped.
 * @returns rows in the requested order.
 */
export function reorderRows(rows: readonly QueueRow[], order: readonly string[]): QueueRow[] {
  const byId = new Map(rows.map(row => [row.id, row]))
  const ordered = order.flatMap(id => {
    const row = byId.get(id)
    return row === undefined ? [] : [row]
  })
  return ordered.length === rows.length ? ordered : [...rows]
}

/**
 * Move one identity inside an ordered sequence.
 * @param ids - current sequence.
 * @param from - index of the moved identity.
 * @param to - requested destination, clamped into bounds.
 * @returns a new sequence; the input is copied unchanged for invalid indexes.
 */
export function moveIds(ids: readonly string[], from: number, to: number): string[] {
  if (from < 0 || from >= ids.length) return [...ids]
  const moved = ids[from] as string
  const target = Math.min(Math.max(to, 0), ids.length - 1)
  return ids.toSpliced(from, 1).toSpliced(target, 0, moved)
}

/**
 * Resolve the row index a pointer currently sits over.
 * @param midpoints - vertical midpoints of the row rects, in display order.
 * @param pointerY - current pointer position.
 * @returns the destination index within `[0, midpoints.length - 1]`; 0 when empty.
 */
export function dragTarget(midpoints: readonly number[], pointerY: number): number {
  if (midpoints.length === 0) return 0
  for (let index = 0; index < midpoints.length; index += 1) {
    if (pointerY < (midpoints[index] as number)) return index
  }
  return midpoints.length - 1
}

/**
 * Index range occupied by one row kind; `end` is -1 when the group is empty.
 * @param rows - display rows.
 * @param kind - row kind to measure.
 */
export function groupRange(rows: readonly QueueRow[], kind: QueueRow['kind']): RowRange {
  let start = -1
  let end = -1
  rows.forEach((row, index) => {
    if (row.kind !== kind) return
    if (start < 0) start = index
    end = index
  })
  return start < 0 ? { start: 0, end: -1 } : { start, end }
}

/**
 * Move one row to a visible index, clamped inside its own group.
 * @param rows - display rows.
 * @param id - identity of the moved row.
 * @param targetVisible - requested visible destination.
 * @returns the complete identity order after the move.
 */
export function moveWithinGroup(rows: readonly QueueRow[], id: string, targetVisible: number): string[] {
  const ids = rows.map(row => row.id)
  const row = rows.find(item => item.id === id)
  if (row === undefined) return ids
  const range = groupRange(rows, row.kind)
  if (range.end < 0) return ids
  const groupIds = ids.slice(range.start, range.end + 1)
  const from = groupIds.indexOf(id)
  if (from < 0) return ids
  const to = Math.min(Math.max(targetVisible - range.start, 0), groupIds.length - 1)
  const moved = moveIds(groupIds, from, to)
  const next = [...ids]
  next.splice(range.start, groupIds.length, ...moved)
  return next
}

/**
 * Visible destination for one keyboard step, or undefined at the group edge.
 * @param rows - display rows.
 * @param id - identity of the row being moved.
 * @param step - negative moves up; positive moves down.
 */
export function stepTarget(rows: readonly QueueRow[], id: string, step: number): number | undefined {
  const row = rows.find(item => item.id === id)
  if (row === undefined) return undefined
  const range = groupRange(rows, row.kind)
  if (range.end < 0) return undefined
  const index = rows.findIndex(item => item.id === id)
  const target = index + step
  if (target < range.start || target > range.end) return undefined
  return target
}

/**
 * Whether the visible row set matches one expected identity sequence.
 * @param rows - current display rows.
 * @param order - expected identity sequence.
 */
export function matchesOrder(rows: readonly QueueRow[], order: readonly string[]): boolean {
  const ids = rows.map(row => row.id)
  return ids.length === order.length && ids.every((id, index) => id === order[index])
}
