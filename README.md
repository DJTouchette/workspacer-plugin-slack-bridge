# Slack Bridge

Monitor and steer your fleet from Slack/Discord — bidirectionally.

A [workspacer](https://github.com/DJTouchette/workspacer) hub plugin (sidecar). **Runnable scaffold** — it loads, connects to the hub bus, and shows live activity; the real logic is stubbed with clear TODOs.

## What it does

Pushes needs-you moments (`agent.state_changed` → approval/question/stopped) and workflow results to a Slack/Discord webhook. Bidirectional: a reply calls `claude.approve` / `claude.answer` / `claude.setPermissionMode` so you approve tools and answer questions from your phone.

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

Edit `server.js` → `onEvent(event)`. Subscribed topics arrive there; use `call('method', params)` for capabilities and `publish('command.x', data)` for commands. `settings` holds the host-injected config above.

## Layout

```
slack-bridge/
  plugin.json      # manifest (events + capabilities)
  server.js        # zero-dep Node sidecar; implement onEvent()
  README.md
```

## License

MIT
