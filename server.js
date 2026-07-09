#!/usr/bin/env node
// Slack Bridge — workspacer plugin sidecar (zero dependencies, Node >= 22).
//
// OUTBOUND: watches `agent.state_changed` (mode ∈ approval|question|stopped) and
//   `workflow.completed`/`workflow.failed`, then POSTs a formatted message to the
//   configured incoming webhook (Slack or Discord, auto-detected by host). For
//   approval/question it pulls `sessions.snapshot` to include the pending
//   tool/question detail. Rapid repeats per (sessionId, state) are de-duped.
// INBOUND: exposes POST /reply {sessionId, action, text} on its own port and maps
//   it to claude.approve / claude.answer / claude.setPermissionMode so a Slack app
//   (Events API / Socket Mode) can forward the user's replies back to the fleet.
const http = require('http');
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'plugin.json'), 'utf8'));
const PORT = Number(process.env.PORT || (manifest.server && manifest.server.port) || 9201);

// The hub injects the bus URL + this plugin's scoped token. Accept the common
// conventions so the scaffold runs however your hub wires it.
const BUS_URL = process.env.WKS_BUS_URL || 'ws://127.0.0.1:7895/bus';
function readToken() {
  if (process.env.WKS_BUS_TOKEN) return process.env.WKS_BUS_TOKEN;
  try { return fs.readFileSync(path.join(DIR, '.bus-token'), 'utf8').trim(); } catch { return ''; }
}
// Host-injected settings (from manifest `settings`), passed as JSON in env.
let settings = {};
try { settings = JSON.parse(process.env.WKS_SETTINGS || '{}'); } catch {}

const TOPICS = manifest.consumes || [];
const recent = [];
let ws = null, connected = false, callSeq = 0;
const pending = new Map();

function log(msg) {
  console.log('[' + manifest.id + '] ' + msg);
  recent.unshift(new Date().toISOString() + '  ' + msg);
  if (recent.length > 100) recent.pop();
}

// Call a hub capability (must be declared in plugin.json `capabilities`).
function call(method, params) {
  return new Promise((resolve, reject) => {
    if (!connected) return reject(new Error('not connected'));
    const id = 'c' + (++callSeq);
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ op: 'call', id, method, params: params || {} }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('timeout')); } }, 8000);
  });
}
// Publish an event/command (must be declared in `emits`).
function publish(type, data) {
  if (connected) ws.send(JSON.stringify({ op: 'publish', event: { type, source: manifest.id, data: data || {} } }));
}

function connect() {
  const tok = readToken();
  ws = new WebSocket(BUS_URL + (tok ? '?token=' + encodeURIComponent(tok) : ''));
  ws.addEventListener('open', () => {
    connected = true;
    if (TOPICS.length) ws.send(JSON.stringify({ op: 'subscribe', topics: TOPICS }));
    log('connected; subscribed to ' + (TOPICS.join(', ') || '(nothing)'));
  });
  ws.addEventListener('message', (ev) => {
    let f; try { f = JSON.parse(ev.data); } catch { return; }
    if (f.op === 'event' && f.event) onEvent(f.event).catch((e) => log('onEvent error: ' + e.message));
    else if (f.op === 'result' && pending.has(f.id)) { pending.get(f.id).resolve(f.result); pending.delete(f.id); }
    else if (f.op === 'error' && pending.has(f.id)) { pending.get(f.id).reject(new Error(f.error)); pending.delete(f.id); }
  });
  ws.addEventListener('close', () => { connected = false; setTimeout(connect, 1500); });
  ws.addEventListener('error', () => { try { ws.close(); } catch {} });
}

// ── Outbound: format + deliver to Slack/Discord ────────────────────────────────

// Which webhook flavour is configured — Slack and Discord speak different JSON.
function webhookKind(url) {
  if (!url) return null;
  let host = '';
  try { host = new URL(url).host.toLowerCase(); } catch { return null; }
  if (host.includes('discord.com') || host.includes('discordapp.com')) return 'discord';
  // hooks.slack.com, plus Mattermost/other Slack-compatible endpoints.
  return 'slack';
}

// Truncate for chat + strip control chars so a rogue payload can't garble output.
function clip(s, n) {
  const t = String(s == null ? '' : s).replace(/[\x00-\x1f]+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

// A short, human name for a session: its label if any, else the cwd basename.
function agentName(label, cwd) {
  const l = (label || '').trim();
  if (l) return clip(l, 60);
  const base = cwd ? path.basename(String(cwd)) : '';
  return base ? clip(base, 60) : 'agent';
}

// Best-effort one-line description of a pending tool call.
function describeTool(pa) {
  if (!pa || !pa.toolName) return 'a tool';
  const t = pa.toolName;
  const inp = pa.toolInput || {};
  if (t === 'Bash' && inp.command) return 'Bash: `' + clip(inp.command, 200) + '`';
  const target = inp.file_path || inp.path || inp.url || inp.pattern;
  return target ? t + ': ' + clip(target, 160) : t;
}

async function deliver(text) {
  const url = settings.webhookUrl;
  if (!url) { log('no webhookUrl configured; skipping outbound'); return; }
  const kind = webhookKind(url);
  // Slack incoming webhooks read {text}; Discord reads {content}. `channel` is
  // honoured by Slack legacy webhooks (Discord ignores it).
  const body = kind === 'discord'
    ? { content: clip(text, 1900) }
    : { text: clip(text, 3000), ...(settings.channel ? { channel: settings.channel } : {}) };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) log('webhook POST ' + res.status + ' ' + clip(await res.text().catch(() => ''), 120));
    else log('delivered to ' + kind + ' webhook');
  } catch (e) {
    log('webhook POST failed: ' + e.message);
  }
}

// ── Dedup: swallow rapid repeats of the same (sessionId, state) ────────────────
const DEDUP_MS = 10000;
const lastSent = new Map();
function shouldSend(key) {
  const now = Date.now();
  const prev = lastSent.get(key);
  lastSent.set(key, now);
  // Opportunistic prune so the map can't grow unbounded.
  if (lastSent.size > 500) for (const [k, t] of lastSent) if (now - t > 60000) lastSent.delete(k);
  return !(prev && now - prev < DEDUP_MS);
}

// ── Event handling ─────────────────────────────────────────────────────────────
const NOTIFY_MODES = new Set(['approval', 'question', 'stopped']);

async function onEvent(event) {
  const type = event.type;
  const d = event.data || {};

  if (type === 'agent.state_changed') {
    const mode = d.mode;
    if (!NOTIFY_MODES.has(mode)) return;
    const sessionId = d.sessionId;
    if (!sessionId) return;
    if (!shouldSend(sessionId + '|' + mode)) return;

    // For approval/question, pull the snapshot for the concrete detail + a nicer
    // agent name (label). Tolerate a missing/failed snapshot.
    let snap = null;
    if (mode === 'approval' || mode === 'question') {
      try { snap = await call('sessions.snapshot', { sessionId }); } catch (e) { log('snapshot failed: ' + e.message); }
    }
    const name = agentName(snap && snap.label, (snap && snap.cwd) || d.cwd);
    let text;
    if (mode === 'approval') {
      const detail = snap && snap.pendingApproval ? describeTool(snap.pendingApproval) : 'a tool';
      text = '⏳ *' + name + '* needs approval — ' + detail + '\n`' + sessionId + '`';
    } else if (mode === 'question') {
      const q = snap && snap.pendingQuestions && snap.pendingQuestions[0];
      let body = 'a question';
      if (q) {
        const opts = (q.options || []).map((o, i) => (i + 1) + ') ' + clip(o.label, 60)).join('  ');
        body = clip(q.question, 300) + (opts ? '\n' + opts : '');
      }
      text = '❓ *' + name + '* asked: ' + body + '\n`' + sessionId + '`';
    } else {
      // stopped
      text = '🛑 *' + name + '* stopped and is waiting for you.\n`' + sessionId + '`';
    }
    await deliver(text);
    return;
  }

  if (type === 'workflow.completed' || type === 'workflow.failed') {
    const sessionId = d.sessionId || d.runId || '';
    const failed = type === 'workflow.failed';
    if (sessionId && !shouldSend(sessionId + '|' + type)) return;
    const name = agentName(d.name, d.cwd);
    const secs = d.durationMs ? Math.round(d.durationMs / 1000) : null;
    const bits = [];
    if (secs != null) bits.push(secs + 's');
    if (d.totalTokens) bits.push(d.totalTokens + ' tok');
    if (d.totalToolCalls) bits.push(d.totalToolCalls + ' tools');
    const meta = bits.length ? ' (' + bits.join(', ') + ')' : '';
    const verb = failed ? '❌ failed' : '✅ finished';
    const label = d.name ? clip(d.name, 60) : name;
    let text = verb + ': *' + label + '*' + meta;
    if (sessionId) text += '\n`' + sessionId + '`';
    await deliver(text);
    return;
  }

  log('event ' + type + ' (ignored)');
}

// ── Inbound: /reply endpoint → drive the agent from a Slack app ────────────────
// A user's own Slack app (Events API / Socket Mode) forwards replies here.
async function handleReply(payload) {
  const { sessionId, action, text } = payload || {};
  if (!sessionId) throw new Error('reply requires { sessionId }');
  const act = String(action || '').toLowerCase();

  if (act === 'approve') {
    // text carries the decision: yes | no | always (default yes).
    let decision = String(text || 'yes').trim().toLowerCase();
    if (decision === 'y' || decision === 'ok' || decision === 'approve') decision = 'yes';
    if (decision === 'n' || decision === 'deny' || decision === 'reject') decision = 'no';
    if (decision !== 'yes' && decision !== 'no' && decision !== 'always') decision = 'yes';
    await call('claude.approve', { sessionId, decision });
    return { ok: true, action: 'approve', decision };
  }

  if (act === 'answer') {
    // A numeric text selects an option (1-based); anything else is free text.
    const trimmed = String(text == null ? '' : text).trim();
    const asNum = Number(trimmed);
    const params = Number.isInteger(asNum) && trimmed !== '' && asNum > 0
      ? { sessionId, option: asNum }
      : { sessionId, text: trimmed };
    await call('claude.answer', params);
    return { ok: true, action: 'answer', ...('option' in params ? { option: params.option } : { text: params.text }) };
  }

  if (act === 'mode' || act === 'setpermissionmode' || act === 'permission') {
    const mode = String(text || '').trim();
    if (!mode) throw new Error("action 'mode' requires text = the permission mode");
    await call('claude.setPermissionMode', { sessionId, mode });
    return { ok: true, action: 'mode', mode };
  }

  throw new Error("unknown action '" + act + "' (want approve|answer|mode)");
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let data = '', size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      data += c;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const server = http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200); return res.end('ok'); }

  if (req.method === 'POST' && (req.url === '/reply' || (req.url || '').split('?')[0] === '/reply')) {
    readBody(req).then(async (raw) => {
      let payload; try { payload = JSON.parse(raw || '{}'); } catch { payload = null; }
      if (!payload || typeof payload !== 'object') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: 'invalid JSON body' }));
      }
      try {
        const out = await handleReply(payload);
        log('reply ' + (payload.action || '?') + ' → ' + (payload.sessionId || '?'));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(out));
      } catch (e) {
        log('reply error: ' + e.message);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    }).catch((e) => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    });
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<!doctype html><meta charset=utf-8><meta http-equiv=refresh content=2>'
    + '<title>' + manifest.name + '</title><body style="font-family:system-ui;'
    + 'background:var(--wks-bg-base,#161616);color:var(--wks-text-primary,#e8e8e8);margin:0;padding:14px">'
    + '<h2 style="font-size:1rem">' + manifest.name + '</h2>'
    + '<p style="color:var(--wks-text-muted,#888);font-size:.8rem">'
    + (connected ? '\u{1F7E2} connected to hub' : '\u{1F534} disconnected')
    + ' · ' + (settings.webhookUrl ? (webhookKind(settings.webhookUrl) + ' webhook set') : 'no webhookUrl')
    + ' · POST /reply for inbound</p>'
    + '<pre style="font-size:.7rem;color:var(--wks-text-faint,#777);white-space:pre-wrap">'
    + (recent.map(escapeHtml).join('\n') || 'waiting for events…') + '</pre>');
});
function escapeHtml(s) { return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
server.listen(PORT, '127.0.0.1', () => log('pane + /reply on http://127.0.0.1:' + PORT));
connect();
