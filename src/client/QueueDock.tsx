/**
 * Queue panel replacing the built-in dock: native-style rows with
 * pointer-following drag reorder, queue-wide and per-row pause toggles, held
 * row editing, and step buttons.
 * @module dsh-message-queue/client/QueueDock
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactElement } from 'react'
import type { InboxItem, InboxProjection, PendingSubmission, QueueDockProps } from './contracts.ts'
import {
  dragTarget,
  groupRange,
  mergeRows,
  moveWithinGroup,
  reorderRows,
  textOf,
} from './model.ts'
import type { QueueRow } from './model.ts'
import type { QueueState } from '../wire.ts'
import {
  CheckIcon,
  ChevronIcon,
  CloseIcon,
  EditIcon,
  GripIcon,
  PauseBadgeIcon,
  PauseIcon,
  PlayIcon,
  QueueIcon,
  SendIcon,
  TrashIcon,
  UndoIcon,
} from './icons.tsx'

const EMPTY_ITEMS: readonly InboxItem[] = []
const EMPTY_PARKED: QueueState['parked'] = []
const EMPTY_SENT: QueueState['sent'] = []
/** Distance from a list edge that starts auto-scrolling during a drag. */
const AUTOSCROLL_EDGE_PX = 24

/** One attachment reference found in a content block. */
interface AttachmentRef {
  readonly type: 'image' | 'file'
  readonly attachment: {
    readonly attachmentId?: string
    readonly name?: string
    readonly bytes?: number
  }
}

/** Live drag bookkeeping; kept in a ref so pointer frames do not re-render. */
interface DragSession {
  readonly id: string
  readonly kind: QueueRow['kind']
  readonly element: HTMLElement
  readonly startIndex: number
  readonly startY: number
  readonly startTop: number
  index: number
  lastY: number
  frame: number
}

/** Read durable attachment references from model-facing content blocks. */
function attachmentRefs(content: readonly unknown[]): AttachmentRef[] {
  const refs: AttachmentRef[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const { type, attachment } = block as { type?: unknown; attachment?: unknown }
    if (type !== 'image' && type !== 'file') continue
    if (typeof attachment !== 'object' || attachment === null) continue
    const value = attachment as { attachmentId?: unknown; name?: unknown; bytes?: unknown }
    refs.push({
      type,
      attachment: {
        ...(typeof value.attachmentId === 'string' ? { attachmentId: value.attachmentId } : {}),
        ...(typeof value.name === 'string' ? { name: value.name } : {}),
        ...(typeof value.bytes === 'number' ? { bytes: value.bytes } : {}),
      },
    })
  }
  return refs
}

/** Render one durable image reference through the Session-scoped URL resolver. */
function ImageThumb({ attachment, loadImage, label }: {
  attachment: AttachmentRef['attachment']
  loadImage: QueueDockProps['loadImage']
  label: string
}): ReactElement {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    void loadImage(attachment).then(
      resolved => { if (alive) setUrl(resolved) },
      () => { /* keep the placeholder; the transcript owns read errors */ },
    )
    return () => { alive = false }
  }, [attachment, loadImage])
  return url === null
    ? <span className="mq-thumb" aria-hidden />
    : <img className="mq-thumb" src={url} alt={label} />
}

/** Durable attachment chips for one row. */
function Attachments({ content, loadImage, t }: {
  content: readonly unknown[]
  loadImage: QueueDockProps['loadImage']
  t: QueueDockProps['t']
}): ReactElement | null {
  const refs = attachmentRefs(content)
  if (refs.length === 0) return null
  return (
    <span className="mq-attachments">
      {refs.map((ref, index) => ref.type === 'image'
        ? <ImageThumb key={`${ref.attachment.attachmentId ?? index}`} attachment={ref.attachment}
          loadImage={loadImage} label={t('image')} />
        : (
          <span key={`${ref.attachment.attachmentId ?? ref.attachment.name ?? index}`} className="mq-file"
            title={ref.attachment.name}>
            {ref.attachment.name ?? ''}
          </span>
        ))}
    </span>
  )
}

/** Attachment chips for a submission this browser has not had admitted yet. */
function PendingAttachments({ attachments }: { attachments: PendingSubmission['attachments'] }): ReactElement | null {
  if (attachments.length === 0) return null
  return (
    <span className="mq-attachments">
      {attachments.map((item, index) => item.type === 'image' && item.value.previewUrl !== undefined
        ? <img key={`${item.value.previewUrl}:${index}`} className="mq-thumb" src={item.value.previewUrl} alt="" />
        : <span key={`${item.value.name ?? index}`} className="mq-file" title={item.value.name}>
          {item.value.name ?? ''}
        </span>)}
    </span>
  )
}

/** Row text, with an explicit empty-state marker. */
function Preview({ content, t }: { content: readonly unknown[]; t: QueueDockProps['t'] }): ReactElement {
  const text = textOf(content).trim()
  return text === ''
    ? <span className="mq-preview mq-preview-empty">{t('image')}</span>
    : <span className="mq-preview">{text}</span>
}

/**
 * Queue panel for one Session.
 * @param props - Session hooks, locale translator, and the injected queue facade.
 */
export function QueueDock(props: QueueDockProps): ReactElement | null {
  const { sessionId, useSession, useProjection, t, queue, updateQueue, notify, loadImage } = props
  const inbox = useProjection('inbox') as InboxProjection | undefined
  const pendingSubmissions = useSession(snapshot => snapshot.pendingSubmissions)
  const running = useSession(snapshot => snapshot.running)
  const subagent = useSession(snapshot => snapshot.subagent)
  const queueMutable = subagent == null || subagent.address?.mode === 'continuable'

  const queued = inbox?.['next-turn'] ?? EMPTY_ITEMS
  const [remoteState, setRemoteState] = useState<QueueState | undefined>(undefined)
  const [localOrder, setLocalOrder] = useState<readonly string[] | undefined>(undefined)
  const [editing, setEditing] = useState<{ id: string; text: string; kind: QueueRow['kind'] } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState(true)
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [announcement, setAnnouncement] = useState('')
  const listRef = useRef<HTMLUListElement | null>(null)
  const dragRef = useRef<DragSession | null>(null)
  const rowsRef = useRef<readonly QueueRow[]>([])

  const refresh = useCallback((): void => {
    void queue.state().then(setRemoteState, () => {
      /* state reads are advisory; the panel still renders the projection */
    })
  }, [queue])

  useEffect(() => { refresh() }, [refresh, sessionId])
  useEffect(() => {
    const onFocus = (): void => { refresh() }
    window.addEventListener('focus', onFocus)
    return () => { window.removeEventListener('focus', onFocus) }
  }, [refresh])
  useEffect(() => {
    if (remoteState?.paused !== true) return
    const timer = setInterval(() => { refresh() }, 5000)
    return () => { clearInterval(timer) }
  }, [refresh, remoteState?.paused])
  useEffect(() => () => {
    const session = dragRef.current
    if (session !== null && session.frame !== 0) cancelAnimationFrame(session.frame)
  }, [])

  const parked = remoteState?.parked ?? EMPTY_PARKED
  const rows = useMemo(() => mergeRows(parked, queued), [parked, queued])
  const displayRows = useMemo(
    () => localOrder === undefined ? rows : reorderRows(rows, localOrder),
    [localOrder, rows],
  )
  rowsRef.current = displayRows
  const queuedKey = queued.map(item => item.id).join(',')
  const parkedKey = parked.map(item => item.id).join(',')

  useEffect(() => {
    setLocalOrder(current => {
      if (current === undefined) return current
      const hostIds: string[] = []
      for (const item of parked) hostIds.push(item.id)
      for (const item of queued) hostIds.push(item.id)
      const same = current.length === hostIds.length && current.every((id, index) => id === hostIds[index])
      return same ? undefined : current
    })
  }, [queuedKey, parkedKey, parked, queued])

  const pendingQueue = useMemo(() => {
    const admitted = new Set(queued.flatMap(item => (
      item.source?.kind === 'user' && item.source.rpcId !== undefined ? [item.source.rpcId] : []
    )))
    return pendingSubmissions.filter(submission => submission.placement === 'queued'
      && !admitted.has(submission.requestId))
  }, [pendingSubmissions, queued])

  const sentItems = remoteState?.sent ?? EMPTY_SENT
  const rowCount = displayRows.length + pendingQueue.length
  const paused = remoteState?.paused === true
  const interactionActive = queueMutable && (editing !== null || busy !== null || draggingId !== null)
  const expanded = !collapsed || interactionActive
  const listVisible = rowCount === 0 || sentItems.length > 0 ? true : rowCount === 1 || expanded
  const pauseAvailable = remoteState?.available !== false

  useEffect(() => {
    if (rowCount === 0 && !collapsed) setCollapsed(true)
    if (editing !== null && (!queueMutable || !displayRows.some(row => row.id === editing.id))) setEditing(null)
  }, [collapsed, displayRows, editing, queueMutable, rowCount])

  /** Visible destination for one row, undefined at its group edge. */
  const edgeTarget = (row: QueueRow, direction: -1 | 1): number | undefined => {
    const range = groupRange(displayRows, row.kind)
    if (range.end < 0) return undefined
    const current = displayRows.findIndex(item => item.id === row.id)
    const target = direction < 0 ? current - 1 : current + 1
    if (target < range.start || target > range.end) return undefined
    return target
  }

  const runAction = useCallback(async (id: string, action: Parameters<typeof updateQueue>[1], failure: string): Promise<boolean> => {
    setBusy(id)
    try {
      await updateQueue(id, action)
      return true
    } catch {
      notify('error', failure)
      return false
    } finally {
      setBusy(current => current === id ? null : current)
    }
  }, [notify, updateQueue])

  const runState = useCallback(async (
    id: string,
    operation: () => Promise<QueueState>,
    failure: string,
  ): Promise<boolean> => {
    setBusy(id)
    try {
      setRemoteState(await operation())
      return true
    } catch {
      notify('error', failure)
      return false
    } finally {
      setBusy(current => current === id ? null : current)
    }
  }, [notify])

  const saveEdit = async (): Promise<void> => {
    if (editing === null || editing.text.trim() === '') return
    const { id, text, kind } = editing
    const saved = kind === 'parked'
      ? await runState(id, () => queue.edit(id, text), t('editFailed'))
      : await runAction(id, { kind: 'edit', content: [{ type: 'text', text }] }, t('editFailed'))
    if (saved) setEditing(null)
  }

  const commitMove = useCallback(async (itemId: string, targetVisible: number): Promise<void> => {
    const row = displayRows.find(item => item.id === itemId)
    if (row === undefined) return
    const parkedCount = displayRows.filter(item => item.kind === 'parked').length
    const groupIndex = row.kind === 'parked' ? targetVisible : targetVisible - parkedCount
    setLocalOrder(moveWithinGroup(displayRows, itemId, targetVisible))
    setBusy(itemId)
    try {
      const result = await queue.move(itemId, groupIndex)
      setLocalOrder(result.order.length === 0 ? undefined : result.order)
    } catch {
      setLocalOrder(undefined)
      notify('error', t('moveFailed'))
    } finally {
      setBusy(current => current === itemId ? null : current)
      refresh()
    }
  }, [displayRows, notify, queue, refresh, t])

  const toggleGlobalPause = async (): Promise<void> => {
    if (!pauseAvailable || busy !== null) return
    setBusy('pause')
    try {
      const next = paused ? await queue.resume() : await queue.pause()
      setRemoteState(next)
      setLocalOrder(undefined)
      refresh()
    } catch {
      notify('error', paused ? t('resumeFailed') : t('pauseFailed'))
    } finally {
      setBusy(null)
    }
  }

  const toggleRowPause = (row: QueueRow): void => {
    if (busy !== null) return
    if (row.kind === 'parked') {
      void runState(row.id, () => queue.resumeItem(row.id), t('resumeItemFailed'))
    } else {
      void runState(row.id, () => queue.pauseItem(row.id), t('pauseItemFailed'))
    }
  }

  /** Re-measure after React commits a reorder while dragging. */
  const applyDrag = (): void => {
    const session = dragRef.current
    if (session === null) return
    session.frame = 0
    const list = listRef.current
    const element = session.element
    element.style.transform = 'none'
    const naturalTop = element.getBoundingClientRect().top
    const desiredTop = session.startTop + (session.lastY - session.startY)
    if (list !== null) {
      const rect = list.getBoundingClientRect()
      if (session.lastY < rect.top + AUTOSCROLL_EDGE_PX) list.scrollTop -= 10
      else if (session.lastY > rect.bottom - AUTOSCROLL_EDGE_PX) list.scrollTop += 10
      const midpoints = [...list.querySelectorAll<HTMLElement>('[data-mq-sortable]')].map(node => {
        const nodeRect = node.getBoundingClientRect()
        return nodeRect.top + nodeRect.height / 2
      })
      const targetRaw = dragTarget(midpoints, session.lastY)
      const range = groupRange(rowsRef.current, session.kind)
      const target = Math.min(Math.max(targetRaw, range.start), range.end)
      if (target !== session.index) {
        session.index = target
        setLocalOrder(moveWithinGroup(rowsRef.current, session.id, target))
        // Layout moves this row's natural slot; the next frame re-applies the offset.
        session.frame = requestAnimationFrame(applyDrag)
        element.style.transform = `translateY(${desiredTop - naturalTop}px)`
        return
      }
    }
    element.style.transform = `translateY(${desiredTop - naturalTop}px)`
  }

  const scheduleDrag = (clientY: number): void => {
    const session = dragRef.current
    if (session === null) return
    session.lastY = clientY
    if (session.frame !== 0) return
    session.frame = requestAnimationFrame(applyDrag)
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLButtonElement>, row: QueueRow): void => {
    if (!queueMutable || busy !== null || event.button !== 0) return
    const element = event.currentTarget.closest<HTMLElement>('[data-mq-row]')
    if (element === null) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    element.style.transform = 'none'
    const startTop = element.getBoundingClientRect().top
    const index = displayRows.findIndex(item => item.id === row.id)
    dragRef.current = {
      id: row.id,
      kind: row.kind,
      element,
      startIndex: index,
      startY: event.clientY,
      startTop,
      index,
      lastY: event.clientY,
      frame: 0,
    }
    setDraggingId(row.id)
  }

  const finishDrag = (cancelled: boolean): void => {
    const session = dragRef.current
    dragRef.current = null
    setDraggingId(null)
    if (session === null) return
    if (session.frame !== 0) cancelAnimationFrame(session.frame)
    session.element.style.transform = ''
    if (cancelled || session.index === session.startIndex) {
      setLocalOrder(undefined)
      return
    }
    setAnnouncement(t('moved', { index: session.index + 1 }))
    void commitMove(session.id, session.index)
  }

  const onHandleKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, row: QueueRow): void => {
    if (!queueMutable || busy !== null) return
    let target: number | undefined
    if (event.altKey && event.key === 'ArrowUp') target = edgeTarget(row, -1)
    else if (event.altKey && event.key === 'ArrowDown') target = edgeTarget(row, 1)
    else if (event.altKey && (event.key === 'Home' || event.key === 'End')) {
      const range = groupRange(displayRows, row.kind)
      if (range.end >= 0) target = event.key === 'Home' ? range.start : range.end
    }
    if (target === undefined) return
    event.preventDefault()
    setAnnouncement(t('moved', { index: target + 1 }))
    void commitMove(row.id, target)
  }

  if (rowCount === 0 && sentItems.length === 0 && !paused) return null

  if (rowCount === 0 && sentItems.length === 0) {
    return (
      <div className="mq-dock">
        <div className="mq-panel">
          <div className="mq-paused-bar">
            <span className="mq-status">{t('pausedBar')}</span>
            <button type="button" className="mq-button" onClick={() => { void toggleGlobalPause() }} disabled={!pauseAvailable}>
              {t('resumeAction')}
            </button>
          </div>
        </div>
      </div>
    )
  }

  /** Step button shared by both row groups. */
  const stepButton = (row: QueueRow, direction: -1 | 1): ReactElement => {
    const target = edgeTarget(row, direction)
    const label = direction < 0 ? t('moveUp') : t('moveDown')
    return (
      <button type="button" className="mq-action" aria-label={label} title={label}
        disabled={!queueMutable || busy !== null || target === undefined}
        onClick={() => { if (target !== undefined) void commitMove(row.id, target) }}>
        <ChevronIcon direction={direction < 0 ? 'up' : 'down'} />
      </button>
    )
  }

  return (
    <div className="mq-dock" data-message-queue-dock="">
      <div className="mq-panel">
        <div className="mq-head">
          <button type="button" className="mq-toggle" aria-controls="mq-list" aria-expanded={listVisible}
            disabled={rowCount === 1 || interactionActive} onClick={() => { setCollapsed(value => !value) }}>
            <span className="mq-lead"><QueueIcon /></span>
            <span className="mq-count">
              {rowCount === 0
                ? t('sentTitle', { n: sentItems.length })
                : paused ? t('paused', { n: rowCount }) : t('count', { n: rowCount })}
            </span>
            {!listVisible && pendingQueue.length > 0 && <span className="mq-status">{t('sending')}</span>}
            <span className="mq-chevron" aria-hidden>
              {listVisible ? <ChevronIcon direction="up" /> : <ChevronIcon direction="down" />}
            </span>
          </button>
          {queueMutable && rowCount > 0 && (
            <button type="button" className="mq-action" aria-label={paused ? t('resumeAll') : t('pauseAll')}
              title={paused ? t('resumeAll') : t('pauseAll')} disabled={busy !== null || !pauseAvailable}
              onClick={() => { void toggleGlobalPause() }}>
              {paused ? <PlayIcon /> : <PauseIcon />}
            </button>
          )}
        </div>
        <ul id="mq-list" ref={listRef} className="mq-list" data-dragging={draggingId !== null || undefined}
          hidden={!listVisible}>
          {listVisible && displayRows.map((row) => {
            const isParked = row.kind === 'parked'
            const editableText = textOf(row.content)
            const rowBusy = busy !== null
            const isEditing = editing?.id === row.id
            const heldReason = isParked
              ? (parked.find(item => item.id === row.id)?.reason ?? 'global')
              : undefined
            return (
              <li key={`${row.kind}:${row.id}`} className="mq-row" data-mq-row=""
                data-mq-sortable="" data-parked={isParked || undefined}
                data-dragging={draggingId === row.id || undefined}>
                <button type="button" className="mq-handle" aria-label={t('dragHint')} title={t('dragHint')}
                  disabled={!queueMutable || rowBusy}
                  onPointerDown={event => { onPointerDown(event, row) }}
                  onPointerMove={event => { scheduleDrag(event.clientY) }}
                  onPointerUp={() => { finishDrag(false) }}
                  onPointerCancel={() => { finishDrag(true) }}
                  onKeyDown={event => { onHandleKeyDown(event, row) }}>
                  <GripIcon />
                </button>
                <button type="button" className="mq-action" data-pause-toggle=""
                  aria-label={isParked
                    ? (paused ? t('resumeSend') : t('resumeItem'))
                    : t('pauseItem')}
                  title={isParked
                    ? (paused ? t('resumeSend') : t('resumeItem'))
                    : t('pauseItem')}
                  disabled={!queueMutable || rowBusy}
                  onClick={() => { toggleRowPause(row) }}>
                  {isParked ? <PlayIcon /> : <PauseIcon />}
                </button>
                {isParked && (
                  <span className="mq-badge" title={heldReason === 'manual' ? t('heldManual') : t('heldGlobal')}>
                    <PauseBadgeIcon />
                    {heldReason === 'manual' ? t('heldManual') : t('heldGlobal')}
                  </span>
                )}
                {isEditing
                  ? (
                    <span className="mq-editor">
                      <textarea className="mq-textarea" value={editing.text} aria-label={t('edit')} autoFocus
                        onChange={event => { setEditing({ id: row.id, text: event.target.value, kind: row.kind }) }}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' && !event.shiftKey) {
                            event.preventDefault()
                            void saveEdit()
                          } else if (event.key === 'Escape') {
                            setEditing(null)
                          }
                        }} />
                      <span className="mq-editor-actions">
                        <button type="button" className="mq-action" aria-label={t('save')} title={t('save')}
                          disabled={rowBusy || editing.text.trim() === ''} onClick={() => { void saveEdit() }}>
                          <CheckIcon />
                        </button>
                        <button type="button" className="mq-action" aria-label={t('cancelEdit')} title={t('cancelEdit')}
                          disabled={rowBusy} onClick={() => { setEditing(null) }}>
                          <CloseIcon />
                        </button>
                      </span>
                    </span>
                  )
                  : (
                    <>
                      <Attachments content={row.content} loadImage={loadImage} t={t} />
                      <Preview content={row.content} t={t} />
                    </>
                  )}
                {!isEditing && queueMutable && (
                  <span className="mq-actions">
                    {stepButton(row, -1)}
                    {stepButton(row, 1)}
                    <button type="button" className="mq-action" aria-label={t('edit')} title={t('edit')}
                      disabled={rowBusy || editableText.length === 0}
                      onClick={() => { setEditing({ id: row.id, text: editableText, kind: row.kind }) }}>
                      <EditIcon />
                    </button>
                    <button type="button" className="mq-action" aria-label={t('remove')} title={t('remove')}
                      disabled={rowBusy}
                      onClick={() => {
                        if (isParked) void runState(row.id, () => queue.discard(row.id), t('removeFailed'))
                        else void runAction(row.id, { kind: 'remove' }, t('removeFailed'))
                      }}>
                      <TrashIcon />
                    </button>
                    <button type="button" className="mq-action" aria-label={t('steer')}
                      title={running ? t('steer') : t('steerUnavailable')} disabled={rowBusy || !running}
                      onClick={() => {
                        if (isParked) void runState(row.id, () => queue.steer(row.id), t('steerFailed'))
                        else void runAction(row.id, { kind: 'steer' }, t('steerFailed'))
                      }}>
                      <SendIcon />
                    </button>
                  </span>
                )}
              </li>
            )
          })}
          {listVisible && pendingQueue.map(submission => (
            <li key={submission.requestId} className="mq-row mq-pending-row" data-mq-row="">
              <span className="mq-badge" aria-hidden><QueueIcon /></span>
              <PendingAttachments attachments={submission.attachments} />
              <span className="mq-preview">{submission.text}</span>
              <span className="mq-status" role="status">{t('sending')}</span>
            </li>
          ))}
          {listVisible && sentItems.map(item => (
            <li key={`sent:${item.id}`} className="mq-row mq-sent-row" data-mq-row="" data-sent="">
              <span className="mq-badge" aria-hidden><UndoIcon /></span>
              <Attachments content={item.content} loadImage={loadImage} t={t} />
              <Preview content={item.content} t={t} />
              <span className="mq-status">
                {item.delivered ? t('sentDelivered') : t('sentPending')} · {t('sentTurn', { n: item.turn })}
              </span>
              <span className="mq-actions">
                <button type="button" className="mq-action" aria-label={t('revoke')} title={t('revoke')}
                  disabled={busy !== null}
                  onClick={() => { void runState(item.id, () => queue.revoke(item.id), t('revokeFailed')) }}>
                  <UndoIcon />
                </button>
              </span>
            </li>
          ))}
        </ul>
      </div>
      <span className="mq-sr" role="status" aria-live="polite">{announcement}</span>
    </div>
  )
}
