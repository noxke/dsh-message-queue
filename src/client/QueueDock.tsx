/**
 * Queue panel replacing the built-in dock: drag-to-reorder, pause/resume, and
 * the existing edit / remove / steer actions over the Session inbox.
 * @module dsh-message-queue/client/QueueDock
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactElement } from 'react'
import type { InboxItem, InboxProjection, PendingSubmission, QueueDockProps } from './contracts.ts'
import {
  dragTarget,
  mergeRows,
  moveIds,
  reorderQueued,
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
  SendIcon,
  TrashIcon,
} from './icons.tsx'

const EMPTY_ITEMS: readonly InboxItem[] = []
const EMPTY_PARKED: QueueState['parked'] = []

/** One attachment reference found in a content block. */
interface AttachmentRef {
  readonly type: 'image' | 'file'
  readonly attachment: {
    readonly attachmentId?: string
    readonly name?: string
    readonly bytes?: number
  }
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

/** Durable attachment chips for one queued row. */
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
            {ref.attachment.name ?? t('file', { name: '' })}
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
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState(true)
  const [dragging, setDragging] = useState<{ id: string; from: number } | null>(null)
  const [announcement, setAnnouncement] = useState('')
  const listRef = useRef<HTMLUListElement | null>(null)

  const refresh = useCallback((): void => {
    void queue.state().then(
      state => { setRemoteState(state) },
      () => { /* state reads are advisory; the panel still renders the projection */ },
    )
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

  const parked = remoteState?.parked ?? EMPTY_PARKED
  const rows = useMemo(
    () => mergeRows(parked, queued),
    [parked, queued],
  )
  const displayRows = useMemo(
    () => localOrder === undefined ? rows : reorderQueued(rows, localOrder),
    [localOrder, rows],
  )
  const queuedRows = useMemo(() => displayRows.filter(row => row.kind === 'queued'), [displayRows])
  const queuedKey = queued.map(item => item.id).join(',')

  useEffect(() => {
    setLocalOrder(current => {
      if (current === undefined) return current
      const ids = queuedKey === '' ? [] : queuedKey.split(',')
      const same = current.length === ids.length && current.every((id, index) => id === ids[index])
      return same ? undefined : current
    })
  }, [queuedKey])

  const pendingQueue = useMemo(() => {
    const admitted = new Set(queued.flatMap(item => {
      const source = item as InboxItem & { source?: { kind?: string; rpcId?: string } }
      return source.source?.kind === 'user' && source.source.rpcId !== undefined ? [source.source.rpcId] : []
    }))
    return pendingSubmissions.filter(submission => submission.placement === 'queued'
      && !admitted.has(submission.requestId))
  }, [pendingSubmissions, queued])

  const rowCount = displayRows.length + pendingQueue.length
  const paused = remoteState?.paused === true
  const interactionActive = queueMutable && (editing !== null || busy !== null || dragging !== null)
  const expanded = !collapsed || interactionActive
  const listVisible = rowCount === 1 || expanded
  const pauseAvailable = remoteState?.available !== false

  useEffect(() => {
    if (rowCount === 0 && !collapsed) setCollapsed(true)
    if (editing !== null && (!queueMutable || !queuedRows.some(row => row.id === editing.id))) setEditing(null)
  }, [collapsed, editing, queueMutable, queuedRows, rowCount])

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

  const saveEdit = async (): Promise<void> => {
    if (editing === null || editing.text.trim() === '') return
    const id = editing.id
    if (await runAction(id, { kind: 'edit', content: [{ type: 'text', text: editing.text }] }, t('editFailed'))) {
      setEditing(null)
    }
  }

  const commitMove = useCallback(async (itemId: string, toIndex: number): Promise<void> => {
    setBusy(itemId)
    try {
      const result = await queue.move(itemId, toIndex)
      setLocalOrder(result.order.length === 0 ? undefined : result.order)
    } catch {
      setLocalOrder(undefined)
      notify('error', t('moveFailed'))
    } finally {
      setBusy(current => current === itemId ? null : current)
      refresh()
    }
  }, [notify, queue, refresh, t])

  const togglePause = async (): Promise<void> => {
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

  const midpoints = (): number[] => {
    const list = listRef.current
    if (list === null) return []
    return [...list.querySelectorAll<HTMLElement>('[data-mq-queued]')].map(node => {
      const rect = node.getBoundingClientRect()
      return rect.top + rect.height / 2
    })
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLButtonElement>, row: QueueRow, index: number): void => {
    if (!queueMutable || row.kind !== 'queued' || busy !== null) return
    if (event.button !== 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    setDragging({ id: row.id, from: index })
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    if (dragging === null) return
    const target = dragTarget(midpoints(), event.clientY)
    if (target === dragging.from) return
    const current = localOrder ?? queuedRows.map(row => row.id)
    setLocalOrder(moveIds(current, dragging.from, target))
    setDragging({ id: dragging.id, from: target })
  }

  const onPointerUp = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    if (dragging === null) return
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    const { id, from } = dragging
    setDragging(null)
    const current = localOrder ?? queuedRows.map(row => row.id)
    const origin = current.indexOf(id)
    if (origin < 0 || origin === from) {
      setLocalOrder(undefined)
      return
    }
    setAnnouncement(t('moved', { index: from + 1 }))
    void commitMove(id, from)
  }

  const moveByKeyboard = (row: QueueRow, index: number): ((event: ReactKeyboardEvent<HTMLButtonElement>) => void) =>
    (event) => {
      if (!queueMutable || busy !== null) return
      const ids = queuedRows.map(item => item.id)
      const step = event.altKey && event.key === 'ArrowUp' ? -1
        : event.altKey && event.key === 'ArrowDown' ? 1
          : 0
      const destination = step !== 0
        ? Math.min(Math.max(index + step, 0), ids.length - 1)
        : event.altKey && event.key === 'Home' ? 0
          : event.altKey && event.key === 'End' ? ids.length - 1
            : undefined
      if (destination === undefined || destination === index) return
      event.preventDefault()
      setLocalOrder(moveIds(ids, index, destination))
      setAnnouncement(t('moved', { index: destination + 1 }))
      void commitMove(row.id, destination)
    }

  if (rowCount === 0 && !paused) return null

  if (rowCount === 0) {
    return (
      <div className="mq-dock">
        <div className="mq-paused-bar">
          <PauseBadgeIcon />
          <span>{t('pausedBar')}</span>
          <span className="mq-spacer" />
          <button type="button" className="mq-button" onClick={() => { void togglePause() }} disabled={!pauseAvailable}>
            {t('resumeAction')}
          </button>
        </div>
      </div>
    )
  }

  const totalQueued = queuedRows.length + pendingQueue.length

  return (
    <div className="mq-dock" data-message-queue-dock="">
      <div className="mq-head">
        {rowCount > 1
          ? (
            <button type="button" className="mq-toggle" aria-controls="mq-list" aria-expanded={expanded}
              disabled={interactionActive} onClick={() => { setCollapsed(value => !value) }}>
              <span className="mq-count">
                {paused ? t('paused', { n: totalQueued }) : t('count', { n: totalQueued })}
              </span>
              {!listVisible && pendingQueue.length > 0 && <span className="mq-status">{t('sending')}</span>}
              <span className="mq-spacer" />
              <span aria-hidden>{expanded ? <ChevronIcon direction="up" /> : <ChevronIcon direction="down" />}</span>
            </button>
          )
          : (
            <span className="mq-count">
              {paused ? t('paused', { n: totalQueued }) : t('count', { n: totalQueued })}
            </span>
          )}
        {queueMutable && (
          <button type="button" className="mq-icon-button" data-active={paused}
            aria-label={paused ? t('resume') : t('pause')} title={paused ? t('resume') : t('pause')}
            disabled={busy !== null || !pauseAvailable} onClick={() => { void togglePause() }}>
            {paused ? <PlayIcon /> : <PauseIcon />}
          </button>
        )}
      </div>
      <ul id="mq-list" ref={listRef} className="mq-list" hidden={!listVisible}>
        {listVisible && displayRows.map((row) => {
          const queuedIndex = queuedRows.findIndex(item => item.id === row.id)
          const isParked = row.kind === 'parked'
          const editableText = textOf(row.content)
          const rowBusy = busy !== null
          return (
            <li key={`${row.kind}:${row.id}`} className="mq-row" data-mq-row=""
              data-mq-queued={isParked ? undefined : queuedIndex}
              data-parked={isParked || undefined}
              data-dragging={dragging?.id === row.id || undefined}>
              {isParked
                ? <span className="mq-badge" title={t('parkedHint')}><PauseBadgeIcon />{t('parked')}</span>
                : (
                  <>
                    <button type="button" className="mq-handle" aria-label={t('dragHint')} title={t('dragHint')}
                      disabled={!queueMutable || rowBusy}
                      onPointerDown={event => { onPointerDown(event, row, queuedIndex) }}
                      onPointerMove={onPointerMove}
                      onPointerUp={onPointerUp}
                      onPointerCancel={() => { setDragging(null); setLocalOrder(undefined) }}
                      onKeyDown={moveByKeyboard(row, queuedIndex)}>
                      <GripIcon />
                    </button>
                    <span className="mq-index" aria-hidden>{queuedIndex + 1}</span>
                  </>
                )}
              {editing?.id === row.id
                ? (
                  <span className="mq-editor">
                    <textarea className="mq-textarea" value={editing.text} aria-label={t('edit')} autoFocus
                      onChange={event => { setEditing({ id: row.id, text: event.target.value }) }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' && !event.shiftKey) {
                          event.preventDefault()
                          void saveEdit()
                        } else if (event.key === 'Escape') {
                          setEditing(null)
                        }
                      }} />
                    <span className="mq-editor-actions">
                      <button type="button" className="mq-icon-button" aria-label={t('save')} title={t('save')}
                        disabled={rowBusy || editing.text.trim() === ''} onClick={() => { void saveEdit() }}>
                        <CheckIcon />
                      </button>
                      <button type="button" className="mq-icon-button" aria-label={t('cancelEdit')} title={t('cancelEdit')}
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
              {!isParked && editing?.id !== row.id && queueMutable && (
                <span className="mq-actions">
                  <button type="button" className="mq-icon-button" aria-label={t('edit')} title={t('edit')}
                    disabled={rowBusy || editableText.length === 0}
                    onClick={() => { setEditing({ id: row.id, text: editableText }) }}>
                    <EditIcon />
                  </button>
                  <button type="button" className="mq-icon-button" aria-label={t('remove')} title={t('remove')}
                    disabled={rowBusy}
                    onClick={() => { void runAction(row.id, { kind: 'remove' }, t('removeFailed')) }}>
                    <TrashIcon />
                  </button>
                  <button type="button" className="mq-icon-button" aria-label={t('steer')}
                    title={running ? t('steer') : t('steerUnavailable')} disabled={rowBusy || !running}
                    onClick={() => { void runAction(row.id, { kind: 'steer' }, t('steerFailed')) }}>
                    <SendIcon />
                  </button>
                </span>
              )}
            </li>
          )
        })}
        {listVisible && pendingQueue.map(submission => (
          <li key={submission.requestId} className="mq-row mq-pending" data-mq-row="">
            <span className="mq-badge" aria-hidden><PauseBadgeIcon /></span>
            <PendingAttachments attachments={submission.attachments} />
            <span className="mq-preview">{submission.text}</span>
            <span className="mq-status" role="status">{t('sending')}</span>
          </li>
        ))}
      </ul>
      <span className="mq-sr" role="status" aria-live="polite">{announcement}</span>
    </div>
  )
}
