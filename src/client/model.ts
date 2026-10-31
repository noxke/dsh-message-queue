/**
 * Pure queue-row helpers for the browser panel: row merging, optimistic
 * ordering, and drag target resolution, kept free of React and the DOM.
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
 * Parked rows come first: they were queued before anything the pause gate let in.
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
 * Apply an optimistic identity order to the queued rows.
 * @param rows - current display rows.
 * @param order - desired queued identity sequence; ignored when empty.
 * @returns rows with queued entries reordered, unknown ids dropped.
 */
export function reorderQueued(rows: readonly QueueRow[], order: readonly string[]): QueueRow[] {
  if (order.length === 0) return [...rows]
  const parked = rows.filter(row => row.kind === 'parked')
  const byId = new Map(rows.filter(row => row.kind === 'queued').map(row => [row.id, row]))
  const ordered = order.flatMap(id => {
    const row = byId.get(id)
    return row === undefined ? [] : [row]
  })
  return [...parked, ...ordered]
}

/**
 * Move one identity inside an ordered sequence.
 * @param ids - current sequence.
 * @param from - index of the moved identity.
 * @param to - requested destination, clamped into bounds.
 * @returns a new sequence; the input is returned unchanged for invalid indexes.
 */
export function moveIds(ids: readonly string[], from: number, to: number): string[] {
  if (from < 0 || from >= ids.length) return [...ids]
  const moved = ids[from] as string
  const target = Math.min(Math.max(to, 0), ids.length - 1)
  return ids.toSpliced(from, 1).toSpliced(target, 0, moved)
}

/**
 * Resolve the row index a pointer currently sits over.
 * @param midpoints - vertical midpoints of the queued row rects, in display order.
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
 * Whether the visible row set matches one expected identity sequence.
 * @param rows - current display rows.
 * @param order - expected identity sequence.
 */
export function matchesOrder(rows: readonly QueueRow[], order: readonly string[]): boolean {
  const queued = rows.filter(row => row.kind === 'queued').map(row => row.id)
  return queued.length === order.length && queued.every((id, index) => id === order[index])
}
