/**
 * Inline SVG icons for the queue panel. Local artwork keeps the panel free of
 * a UI-primitives version coupling.
 * @module dsh-message-queue/client/icons
 */

import type { ReactElement, ReactNode } from 'react'

/** Shared stroke-icon wrapper. */
function Icon({ children, size = 14 }: { children: ReactNode; size?: number }): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false">
      {children}
    </svg>
  )
}

/** Queue strip glyph used by the header lead. */
export function QueueIcon(): ReactElement {
  return (
    <Icon>
      <path d="M4 7h16" />
      <path d="M4 12h16" />
      <path d="M4 17h10" />
    </Icon>
  )
}

/** Drag handle: six dots. */
export function GripIcon(): ReactElement {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="currentColor" aria-hidden focusable="false">
      <circle cx="9" cy="6" r="1.6" /><circle cx="15" cy="6" r="1.6" />
      <circle cx="9" cy="12" r="1.6" /><circle cx="15" cy="12" r="1.6" />
      <circle cx="9" cy="18" r="1.6" /><circle cx="15" cy="18" r="1.6" />
    </svg>
  )
}

/** Pause control. */
export function PauseIcon(): ReactElement {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="currentColor" aria-hidden focusable="false">
      <rect x="7" y="5" width="3.5" height="14" rx="1" />
      <rect x="13.5" y="5" width="3.5" height="14" rx="1" />
    </svg>
  )
}

/** Resume control. */
export function PlayIcon(): ReactElement {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="currentColor" aria-hidden focusable="false">
      <path d="M8 5.5v13a1 1 0 0 0 1.5.86l10-6.5a1 1 0 0 0 0-1.72l-10-6.5A1 1 0 0 0 8 5.5Z" />
    </svg>
  )
}

/** Edit control. */
export function EditIcon(): ReactElement {
  return (
    <Icon>
      <path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17v3Z" />
      <path d="M13.5 6.5 17.5 10.5" />
    </Icon>
  )
}

/** Remove control. */
export function TrashIcon(): ReactElement {
  return (
    <Icon>
      <path d="M4 7h16" />
      <path d="M9 7V4.8A.8.8 0 0 1 9.8 4h4.4a.8.8 0 0 1 .8.8V7" />
      <path d="M6.5 7l.9 12.2a1 1 0 0 0 1 .8h7.2a1 1 0 0 0 1-.8L17.5 7" />
    </Icon>
  )
}

/** Send / steer control. */
export function SendIcon(): ReactElement {
  return (
    <Icon>
      <path d="M21 3 10.5 13.5" />
      <path d="M21 3l-6.5 18-4-8.5L2 8.5 21 3Z" />
    </Icon>
  )
}

/** Confirm control. */
export function CheckIcon(): ReactElement {
  return <Icon><path d="m5 12.5 4.5 4.5L19 7" /></Icon>
}

/** Cancel control. */
export function CloseIcon(): ReactElement {
  return <Icon><path d="M6 6l12 12M18 6 6 18" /></Icon>
}

/** Collapse / expand control. */
export function ChevronIcon({ direction }: { direction: 'up' | 'down' }): ReactElement {
  return direction === 'down'
    ? <Icon><path d="m6 9 6 6 6-6" /></Icon>
    : <Icon><path d="m6 15 6-6 6 6" /></Icon>
}

/** Held-item badge. */
export function PauseBadgeIcon(): ReactElement {
  return (
    <svg width={12} height={12} viewBox="0 0 24 24" fill="currentColor" aria-hidden focusable="false">
      <rect x="7" y="6" width="3.5" height="12" rx="1" />
      <rect x="13.5" y="6" width="3.5" height="12" rx="1" />
    </svg>
  )
}
