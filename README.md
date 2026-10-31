# dsh-message-queue

Drag-to-reorder and pause/resume for the DeepSeek Harness pending message queue.

The plugin replaces the built-in queue dock with a panel that can reorder queued turns by
dragging (or with the keyboard), keep the existing edit / remove / "send now" (steer)
actions, and pause the queue: when the running turn finishes, the next queued message
stays queued until you resume.

## Install

```bash
pnpm install --ignore-workspace
pnpm build
dsh plugin --profile <profile> add link:"$PWD"
```

`dsh plugin` writes the package into the profile. Build first: the host loads
`lib/index.js`, and the browser module loader loads `lib/client.js`.

## Configuration

`cordis.patch.yml` inserts the host entry into the profile tree:

```yaml
- insert:
    - id: message-queue
      name: 'dsh-message-queue'
      config:
        enabled: true
```

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | Mount the queue controller; the browser panel then has a live queue to talk to. |

## What it does

- **Reorder.** The host service exposes `messageQueue.move`, which writes the new
  `next-turn` order through the Agent inbox splice event. The order is durable, so it
  survives a page refresh and is shared with every connected client.
- **Pause / resume.** The row button pauses one item; the header button pauses the whole
  queue. A queue-wide pause holds every queued item, and new submissions join the held
  set. Resuming the queue restores only the items the queue-wide pause held; rows you
  paused yourself stay paused. Resuming a row while the queue is paused sends that one
  immediately, then the pause re-arms.
- **Existing actions.** Edit, remove, and steer keep using the Session's own
  `updateQueue` RPC, so their semantics and attachment handling are the built-in ones.
- **Panel.** The plugin registers the same slot cell as the built-in dock
  (`conversation.input.dock`, id `queue`) with a lower priority, so it renders instead of
  the built-in queue strip and steps aside when the plugin is disabled.

- **Withdraw a recent send.** The panel lists the last five messages the queue sent. Withdrawing
  one puts its text back at the front of the queue. A message the model has not seen yet returns
  unchanged; one the model already saw gains a model-visible replacement that says the user
  withdrew it, while the chat transcript keeps the original text.

## Limits

- The panel covers the main Conversation view. Sessions owned by a subagent route render
  the panel read-only; the host service itself works for any live Agent.
- Items held by a pause live in host memory. A host restart loses the pause flag and the
  held batch; a graceful plugin unload writes the batch back to the inbox.
- Held rows stay interactive while the queue is paused: drag them, step them with the
  ↑ / ↓ buttons, edit their text, remove them, or send one into a running turn with the
  send button. The pause itself still holds the next automatic turn.
- Dragging follows the pointer: the row is translated every animation frame while the
  rest of the list closes the gap; releasing commits the final index once.
- Rows reorder inside their own group: held rows first, queued rows after them.
- Steering input (`next-step`) is not listed by the panel.
- Withdrawal covers the last five messages this queue claimed. The window between claiming a
  message and its delivery to the model is short, so that branch is best-effort.
- Pause state is written per Session and refreshed on mount, on window focus, and every
  few seconds while paused; two browser tabs converge on the host answer.

## Development

```bash
pnpm install --ignore-workspace
pnpm typecheck   # tsc -p tsconfig.test.json
pnpm lint        # oxlint src tests scripts
pnpm test        # vitest run
pnpm build       # tsc, then tsdown for the browser half, then the loader wrapper
pnpm check       # typecheck + lint + test
```

The browser bundle is wrapped in `window.__ModuleLoader__.load({ id, factory })` by
`scripts/build-client.mjs`; its `id` is the package name.

After changing the Typert manifest (adding or renaming an invocation), restart the host
process. The typert loader caches each package's imported manifest for the lifetime of the
process, so reloading the plugin alone serves a new browser bundle against the old Host
manifest.

## License

MIT
