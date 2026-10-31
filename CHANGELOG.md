# Changelog

## 0.1.0

- Reorder queued turns by dragging in the queue panel, with the ↑ / ↓ row buttons, or
  with `Alt+↑` / `Alt+↓` / `Alt+Home` / `Alt+End`; the order is written through the Agent
  inbox and survives a refresh.
- Keep every row interactive while paused: drag or step held rows, edit their text,
  remove them, and send one into a running turn.
- Match the built-in queue strip's layout, type scale, and hover states.
- Add pause/resume: the running turn finishes, later queued messages stay queued until
  resume, and items submitted while paused are not claimed.
- Keep the built-in edit, remove, and send-now (steer) actions on queued rows.
- Replace the built-in queue dock by shadowing its slot cell, so disabling the plugin
  restores the original strip.
- Count held rows in the panel header and keep the released row at its dragged position
  when the pointer goes up.
