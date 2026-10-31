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
 * Build the display rows for one linear queue.
 * The host order is authoritative because paused rows are held outside the
 * inbox; without it the rows fall back to inbox order followed by held order.
 * @param parked - items held by the pause gate.
 * @param queued - pending `next-turn` rows from the inbox projection.
 * @param order - host-reported visible identity order, paused rows included.
 * @returns rows in visible queue order.
 */
export function mergeRows(
  parked: readonly ParkedItem[],
  queued: readonly QueuedItem[],
  order: readonly string[] = [],
): QueueRow[] {
  const parkedById = new Map(parked.map(item => [item.id, item]))
  const queuedById = new Map(queued.map(item => [item.id, item]))
  const rows: QueueRow[] = []
  for (const id of order) {
    const held = parkedById.get(id)
    if (held !== undefined) {
      rows.push({ kind: 'parked', id, content: held.content })
      parkedById.delete(id)
      continue
    }
    const item = queuedById.get(id)
    if (item !== undefined) {
      rows.push({ kind: 'queued', id, content: item.content })
      queuedById.delete(id)
    }
  }
  for (const item of parkedById.values()) rows.push({ kind: 'parked', id: item.id, content: item.content })
  for (const item of queuedById.values()) rows.push({ kind: 'queued', id: item.id, content: item.content })
  return rows
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
 * Move one row to a visible index of the single linear queue.
 * @param rows - display rows.
 * @param id - identity of the moved row.
 * @param targetVisible - requested visible destination, clamped.
 * @returns the complete identity order after the move.
 */
export function moveRow(rows: readonly QueueRow[], id: string, targetVisible: number): string[] {
  const ids = rows.map(row => row.id)
  const from = ids.indexOf(id)
  if (from < 0) return ids
  return moveIds(ids, from, targetVisible)
}

/**
 * Visible destination for one keyboard step, or undefined at the list edge.
 * @param rows - display rows.
 * @param id - identity of the row being moved.
 * @param step - negative moves up; positive moves down.
 */
export function stepTarget(rows: readonly QueueRow[], id: string, step: number): number | undefined {
  const index = rows.findIndex(row => row.id === id)
  if (index < 0) return undefined
  const target = index + step
  return target < 0 || target >= rows.length ? undefined : target
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
