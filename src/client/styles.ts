/**
 * Panel stylesheet installed once per page. The layout, spacing, radii, and
 * type scale mirror the built-in queue strip so the plugin reads as the same
 * surface; class names carry the `mq-` prefix.
 * @module dsh-message-queue/client/styles
 */

const STYLE_ID = 'dsh-message-queue-styles'

const CSS = `
.mq-dock{box-sizing:border-box;flex:none;width:calc(100% - var(--dsh-composer-side-clearance) - var(--dsh-composer-side-clearance) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));max-width:calc(var(--dsh-composer-card-max-width) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));margin:0 auto calc(0px - var(--dsh-composer-stack-gap) - 3px);padding:0 var(--dsh-composer-dock-inset)}
.mq-panel{position:relative;isolation:isolate;overflow:hidden;width:100%;padding:2px 0;border-radius:var(--dsw-radius-lg) var(--dsw-radius-lg) 0 0;--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2)}
.mq-panel::before{position:absolute;z-index:-1;inset:0;border-radius:inherit;background:var(--dsw-specific-menu);backdrop-filter:var(--dsw-menu-backdrop-filter);content:'';pointer-events:none}
.mq-panel::after{position:absolute;inset:0;border:0.5px solid var(--dsw-alias-border-l1);border-bottom:none;border-radius:inherit;content:'';pointer-events:none}
.mq-head{box-sizing:border-box;display:flex;align-items:center;gap:10px;width:100%;height:36px;padding:4px 12px;border-radius:var(--dsw-radius-md);color:var(--dsw-alias-label-primary)}
.mq-toggle{display:flex;align-items:center;gap:10px;flex:1 1 auto;min-width:0;height:100%;padding:0;border:none;background:transparent;color:inherit;text-align:left;cursor:pointer;font:inherit}
.mq-toggle:focus-visible,.mq-action:focus-visible,.mq-handle:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}
.mq-toggle:disabled{cursor:default}
.mq-lead{display:grid;flex:none;place-items:center;color:var(--dsw-alias-label-tertiary)}
.mq-count{flex:1 1 auto;min-width:0;font-family:Inter,var(--dsw-font-family);font-size:13px;font-weight:500;line-height:24px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mq-status{flex:none;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xs-13);white-space:nowrap}
.mq-chevron{display:grid;flex:none;place-items:center;width:14px;height:14px;color:var(--dsw-alias-label-tertiary)}
.mq-list{max-height:180px;overflow-y:auto;margin:0;padding:0;list-style:none}
.mq-list[hidden]{display:none}
.mq-row{box-sizing:border-box;display:flex;align-items:center;gap:8px;width:100%;min-height:36px;padding:4px 5px 4px 8px;border-radius:var(--dsw-radius-md);position:relative}
.mq-row + .mq-row{box-shadow:inset 0 1px 0 var(--dsw-alias-border-l1)}
.mq-row[data-dragging='true']{background:var(--dsw-alias-interactive-bg-hover);box-shadow:0 6px 18px rgba(0,0,0,.18);z-index:1;border-radius:var(--dsw-radius-md)}
.mq-list[data-dragging='true'] .mq-row:not([data-dragging='true']){opacity:.55}
.mq-handle{display:grid;flex:none;place-items:center;width:18px;height:28px;padding:0;border:none;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-tertiary);cursor:grab;touch-action:none;opacity:.6}
@media (hover:hover){.mq-handle:hover:not(:disabled){opacity:1;background:var(--dsw-alias-interactive-bg-hover)}}
.mq-handle:active{cursor:grabbing}
.mq-handle:disabled{opacity:.3;cursor:default}
.mq-badge{display:inline-flex;flex:none;align-items:center;gap:4px;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xs-13)}
.mq-attachments{display:flex;flex:none;gap:4px;min-width:0;max-width:55%;overflow:hidden}
.mq-file{display:inline-flex;flex:0 1 180px;align-items:center;gap:4px;min-width:74px;height:24px;padding:0 6px;overflow:hidden;box-sizing:border-box;border:0.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary-dimmed);font:var(--dsw-font-xs-13);white-space:nowrap;text-overflow:ellipsis}
.mq-thumb{width:24px;height:24px;border:0.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-xs);background:var(--dsw-alias-bg-base);object-fit:cover}
.mq-preview{flex:1 1 auto;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font:var(--dsw-font-xs-13);font-family:Inter,var(--dsw-font-family);color:var(--dsw-alias-label-primary-dimmed)}
.mq-preview-empty{color:var(--dsw-alias-label-tertiary);font-style:italic}
.mq-actions{display:flex;flex:none;align-items:center;gap:2px}
.mq-action{display:grid;flex:none;place-items:center;width:28px;height:28px;padding:0;border:none;border-radius:999px;corner-shape:round;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer}
@media (hover:hover){.mq-action:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}}
.mq-action:disabled{cursor:default;opacity:.45}
.mq-editor{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:4px;padding:2px 0}
.mq-textarea{box-sizing:border-box;width:100%;min-height:42px;max-height:160px;resize:vertical;padding:6px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:var(--dsw-font-xs-13);line-height:1.45}
.mq-textarea:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-1px}
.mq-editor-actions{display:flex;justify-content:flex-end;gap:2px}
.mq-pending-row .mq-preview{color:var(--dsw-alias-label-tertiary)}
.mq-paused-bar{display:flex;align-items:center;gap:10px;box-sizing:border-box;min-height:36px;padding:4px 12px;color:var(--dsw-alias-label-primary)}
.mq-paused-bar .mq-status{flex:1}
.mq-button{flex:none;padding:4px 12px;border:0.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:var(--dsw-font-xs-13);cursor:pointer}
.mq-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.mq-button:disabled{opacity:.45;cursor:default}
.mq-sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
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
