# Slack Bridge

Monitor and steer your fleet from Slack/Discord — bidirectionally.

A [workspacer](https://github.com/DJTouchette/workspacer) hub plugin (sidecar). Implemented and exercised end-to-end against a headless workspacer hub.

## What it does

Pushes needs-you moments (`agent.state_changed` → approval/question/stopped) and workflow results to a Slack/Discord webhook. Bidirectional: a reply calls `claude.approve` / `claude.answer` / `claude.setPermissionMode` so you approve tools and answer questions from your phone.

## Notifications (v1.1)

The bridge is itself a notification channel, so routine traffic is **never**
mirrored into the workspacer notification center. Only operational failures are:

- **Outbound delivery fails** (webhook `POST` non-2xx or network error) →
  `notifications.post` with `level: 'error'`, naming the webhook kind, HTTP
  status/error, and the direction.
- **Inbound reply fails** (a `/reply` from your Slack app couldn't be applied —
  e.g. the `claude.approve` call errored) → same `level: 'error'` notification;
  from Slack's side that failure is otherwise invisible.
- Both use **`key: 'slack-bridge:error'`** so repeated failures hold a single
  slot instead of stacking.
- On first bus connect a **silent, history-only** "Slack Bridge connected" entry
  (`silent` + `inAppOnly`) records the bridge status — no toast, no OS popup.

## Bus wiring

- **Subscribes to:** `agent.state_changed`, `workflow.completed`, `workflow.failed`
- **Calls capabilities:** `notifications.post`, `claude.approve`, `claude.answer`, `claude.setPermissionMode`, `sessions.snapshot`
- **Emits:** —
- **Settings:**
- `webhookUrl` (string) — Slack/Discord incoming webhook for outbound messages.
- `botToken` (string) — Optional: a bot token to receive replies and act on them.
- `channel` (string) — Channel to post to.

## Run it

1. Copy this folder to `~/.config/workspacer/plugins/slack-bridge/` (or install from GitHub via the workspacer command palette → *Install from GitHub…* → `DJTouchette/workspacer-plugin-slack-bridge`).
2. Reload plugins in workspacer.
   The hub supervises `node server.js` and injects the bus token.
3. Open the **Slack Bridge** pane from the command palette.

## Implement

Implemented in `server.js`. Two directions:

### Outbound (fully working)

On each subscribed event the sidecar formats a message and POSTs it to
`settings.webhookUrl` via the global `fetch`. Slack vs Discord is detected by the
webhook host (`hooks.slack.com` → Slack `{ text }` [+ `channel` if set];
`discord.com`/`discordapp.com` → Discord `{ content }`).

- `agent.state_changed` with `mode ∈ { approval, question, stopped }`:
  - **approval** — `⏳ *<name>* needs approval — <tool>`. It first calls
    `sessions.snapshot` to pull `pendingApproval` so the tool (e.g. the `Bash`
    command or the target file) is named.
  - **question** — `❓ *<name>* asked: <question>` plus the numbered options,
    read from the snapshot's `pendingQuestions[0]`. Both snapshot provider
    shapes are supported (the desktop app's `pendingApproval`/`pendingQuestions`
    and the headless brain's claudemon `pending {kind, tool, raw, questions}`),
    so the bridge also works GUI-less.
  - **stopped** — `🛑 *<name>* stopped and is waiting for you.`
- `workflow.completed` / `workflow.failed` — `✅ finished` / `❌ failed:
  *<name>* (<duration>, <tokens>, <tools>)`.

`<name>` is the session `label` (falling back to the cwd basename). Every message
carries the ``sessionId`` so you know what to reply to. Rapid repeats of the same
`(sessionId, state)` inside 10 s are de-duped.

### Inbound (bidirectional, best-effort)

The sidecar also serves **`POST /reply`** on its own port
(`http://127.0.0.1:<server.port>/reply`, default `9201`) so your own Slack app can
forward the user's replies back to the fleet. Body is JSON:

```
POST /reply   Content-Type: application/json
{ "sessionId": "<id>", "action": "approve" | "answer" | "mode", "text": "<...>" }
```

- `action: "approve"` → `claude.approve` — `text` is the decision
  `yes | no | always` (default `yes`; `y`/`ok` → yes, `n`/`deny` → no).
- `action: "answer"` → `claude.answer` — a numeric `text` selects the 1-based
  option (`{ option }`); any other `text` is sent as the free-text answer.
- `action: "mode"` → `claude.setPermissionMode` — `text` is the permission mode
  (e.g. `plan`, `acceptEdits`, `default`, `bypassPermissions`).

Responds `200 { ok: true, ... }` on success, `400 { ok: false, error }` otherwise.

**Receiving Slack messages directly requires a Slack app you own.** This sidecar
does not open a socket to Slack itself — set up a Slack app with the Events API
(or Socket Mode) that listens for messages/interactions in your channel and, for
each reply, does an HTTP `POST` to this endpoint with the matching `sessionId`
(from the outbound message) and the mapped `action`/`text`. Discord works the same
way via an interactions endpoint or a bot. `settings.botToken` is reserved for a
future built-in Socket-Mode listener and is not required for `/reply`.

## Layout

```
slack-bridge/
  plugin.json      # manifest (events + capabilities)
  server.js        # zero-dep Node sidecar; implement onEvent()
  README.md
```

## License

MIT
