/**
 * Panel stylesheet installed once per page. Class names carry the `mq-` prefix
 * so the bundle cannot collide with client styles.
 * @module dsh-message-queue/client/styles
 */

const STYLE_ID = 'dsh-message-queue-styles'

const CSS = `
.mq-dock{display:flex;flex-direction:column;gap:2px;margin:0 0 6px;font-size:12px;line-height:1.4;
  color:var(--dsh-text-secondary,inherit);border:1px solid color-mix(in srgb,currentColor 16%,transparent);
  border-radius:10px;background:color-mix(in srgb,currentColor 4%,transparent);overflow:hidden}
.mq-head{display:flex;align-items:center;gap:6px;padding:4px 6px 4px 8px;min-height:26px}
.mq-toggle{display:flex;align-items:center;gap:6px;flex:1;min-width:0;padding:0;border:0;background:none;
  color:inherit;font:inherit;cursor:pointer;text-align:left}
.mq-toggle:disabled{cursor:default;opacity:.7}
.mq-count{font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mq-status{color:var(--dsh-text-accent,#d97706);font-weight:600}
.mq-spacer{flex:1}
.mq-icon-button{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;padding:0;
  border:0;border-radius:6px;background:none;color:inherit;cursor:pointer;opacity:.8}
.mq-icon-button:hover:not(:disabled){background:color-mix(in srgb,currentColor 12%,transparent);opacity:1}
.mq-icon-button:disabled{opacity:.35;cursor:default}
.mq-icon-button[data-active='true']{background:color-mix(in srgb,currentColor 12%,transparent);opacity:1}
.mq-list{list-style:none;margin:0;padding:0;max-height:40vh;overflow-y:auto}
.mq-list[hidden]{display:none}
.mq-row{display:flex;align-items:center;gap:6px;padding:3px 6px 3px 4px;border-top:1px solid
  color-mix(in srgb,currentColor 9%,transparent)}
.mq-row:first-child{border-top:0}
.mq-row[data-dragging='true']{background:color-mix(in srgb,currentColor 10%,transparent)}
.mq-row[data-parked='true']{opacity:.72}
.mq-handle{display:inline-flex;align-items:center;justify-content:center;width:18px;height:22px;padding:0;
  border:0;border-radius:5px;background:none;color:inherit;cursor:grab;touch-action:none;opacity:.55;flex:none}
.mq-handle:hover:not(:disabled){opacity:.9;background:color-mix(in srgb,currentColor 10%,transparent)}
.mq-handle:disabled{opacity:.25;cursor:default}
.mq-index{width:16px;text-align:right;font-variant-numeric:tabular-nums;opacity:.55;flex:none}
.mq-badge{display:inline-flex;align-items:center;gap:3px;flex:none;font-size:11px;opacity:.75}
.mq-preview{flex:1;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;color:inherit}
.mq-preview-empty{opacity:.5;font-style:italic}
.mq-attachments{display:inline-flex;align-items:center;gap:4px;flex:none;max-width:40%}
.mq-thumb{width:24px;height:24px;object-fit:cover;border-radius:5px;flex:none;
  background:color-mix(in srgb,currentColor 10%,transparent)}
.mq-file{display:inline-flex;align-items:center;gap:3px;max-width:100%;padding:1px 5px;border-radius:5px;
  background:color-mix(in srgb,currentColor 8%,transparent);font-size:11px;overflow:hidden;
  white-space:nowrap;text-overflow:ellipsis}
.mq-actions{display:inline-flex;align-items:center;gap:1px;flex:none}
.mq-editor{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px;padding:2px 0}
.mq-textarea{width:100%;box-sizing:border-box;resize:vertical;min-height:42px;max-height:160px;padding:5px 7px;
  border:1px solid color-mix(in srgb,currentColor 24%,transparent);border-radius:7px;
  background:var(--dsh-bg-input,transparent);color:var(--dsh-text-primary,inherit);font:inherit;line-height:1.45}
.mq-textarea:focus{outline:1px solid color-mix(in srgb,currentColor 40%,transparent);outline-offset:0}
.mq-editor-actions{display:flex;justify-content:flex-end;gap:2px}
.mq-pending .mq-preview{opacity:.8}
.mq-paused-bar{display:flex;align-items:center;gap:8px;margin:0 0 6px;padding:4px 8px;font-size:12px;
  border:1px dashed color-mix(in srgb,currentColor 26%,transparent);border-radius:9px;
  color:var(--dsh-text-secondary,inherit)}
.mq-paused-bar .mq-spacer{flex:1}
.mq-button{padding:2px 8px;border:1px solid color-mix(in srgb,currentColor 26%,transparent);border-radius:7px;
  background:none;color:inherit;font:inherit;cursor:pointer}
.mq-button:hover{background:color-mix(in srgb,currentColor 10%,transparent)}
.mq-sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);
  white-space:nowrap;border:0}
`

/**
 * Install the panel stylesheet once per document.
 * @returns disposer removing the element this call owns.
 */
export function installQueueStyles(): () => void {
  if (typeof document === 'undefined') return () => {}
  const existing = document.getElementById(STYLE_ID)
  if (existing !== null) return () => {}
  const element = document.createElement('style')
  element.id = STYLE_ID
  element.textContent = CSS
  document.head.appendChild(element)
  return () => { element.remove() }
}
