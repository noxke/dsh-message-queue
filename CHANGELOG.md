# Changelog

## 0.1.0

- Reorder queued turns by dragging in the queue panel, with the ↑ / ↓ row buttons, or
  with `Alt+↑` / `Alt+↓` / `Alt+Home` / `Alt+End`; the order is written through the Agent
  inbox and survives a refresh.
- Pause one row or the whole queue: the queue-wide resume restores only the rows it
  held, and resuming a row under a queue-wide pause sends that row immediately.
- Keep every row interactive while paused: drag or step held rows, edit their text,
  remove them, and send one into a running turn.
- Drag the row itself: it follows the pointer every frame and the list closes the gap.
- Match the built-in queue strip's layout, type scale, and hover states.
- Withdraw recent sends from the panel: undelivered messages return to the queue, delivered
  messages gain a model-visible withdrawal replacement and their text rejoins the queue.
- Add pause/resume: the running turn finishes, later queued messages stay queued until
  resume, and items submitted while paused are not claimed.
- Keep the built-in edit, remove, and send-now (steer) actions on queued rows.
- Replace the built-in queue dock by shadowing its slot cell, so disabling the plugin
  restores the original strip.
- Count held rows in the panel header and keep the released row at its dragged position
  when the pointer goes up.
