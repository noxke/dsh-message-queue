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
- Open the dock expanded and allow collapsing a queue that holds a single row.
- Withdraw a steering message while it still waits in `next-step`: it returns to the queue
  without a model notice and without touching the running task.
- Keep withdrawal entries reactive: steering rows come from the inbox projection,
  and the sent list refreshes whenever the inbox changes or a turn keeps running.
- Track withdrawals of not-yet-delivered sends: a late delivery gains the withdrawal notice and
  its duplicate queue copy is dropped instead of running the task twice.
- Withdraw a send within 15 seconds from the panel: undelivered messages return to the queue,
  delivered messages gain a model-visible withdrawal replacement and their text rejoins the
  queue. The row shows the remaining window and disappears once it closes.
- Add pause/resume: the running turn finishes, later queued messages stay queued until
  resume, and items submitted while paused are not claimed.
- Keep the built-in edit, remove, and send-now (steer) actions on queued rows.
- Replace the built-in queue dock by shadowing its slot cell, so disabling the plugin
  restores the original strip.
- Count held rows in the panel header and keep the released row at its dragged position
  when the pointer goes up.
