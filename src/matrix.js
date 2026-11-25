// Minimal Matrix client that talks to the local Synapse. It runs in the main process so chats keep
// being saved even while the window is hidden in the tray.
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const U = require('./util');

const HS = 'http://127.0.0.1:8008';
const FILTER = JSON.stringify({
  room: { timeline: { limit: 60 }, state: { lazy_load_members: true } },
  presence: { not_types: ['*'] },
});

class Matrix extends EventEmitter {
  constructor(cfg, store) {
    super();
    this.cfg = cfg;
    this.store = store;
    this.running = false;
    this.txn = Date.now();
    this.initialDone = false;
    this.userId = cfg.mxid;
    this.hadSince = !!cfg.matrix.since;
    this.lastActive = cfg.matrix.lastActive || 0;
  }
  get token() {
    return this.cfg.matrix.token;
  }

  async api(method, p, body, opt = {}) {
    const url = new URL(HS + p);
    if (opt.query) for (const [k, v] of Object.entries(opt.query)) if (v !== undefined && v !== null) url.searchParams.set(k, v);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), opt.timeout || 60000);
    const headers = { ...(this.token && !opt.noAuth ? { Authorization: 'Bearer ' + this.token } : {}), ...(opt.headers || {}) };
    let payload;
    if (opt.raw) payload = body;
    else if (body !== undefined && body !== null) { payload = JSON.stringify(body); headers['Content-Type'] = 'application/json'; }
    try {
      const r = await fetch(url, { method, headers, body: payload, signal: ctrl.signal });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        const e = new Error(j.error || 'HTTP ' + r.status);
        e.status = r.status; e.errcode = j.errcode; e.retry = j.retry_after_ms;
        throw e;
      }
      return j;
    } finally {
      clearTimeout(t);
    }
  }

  async login() {
    if (this.token) {
      try {
        const w = await this.api('GET', '/_matrix/client/v3/account/whoami');
        this.userId = w.user_id;
        return;
      } catch (e) {
        if (e.status !== 401) throw e;
      }
    }
    const j = await this.api('POST', '/_matrix/client/v3/login', {
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user: this.cfg.matrix.user },
      password: this.cfg.matrix.password,
      initial_device_display_name: 'Switchboard',
      device_id: this.cfg.matrix.deviceId || undefined,
    }, { noAuth: true });
    this.cfg.matrix.token = j.access_token;
    this.cfg.matrix.deviceId = j.device_id;
    this.userId = j.user_id;
    this.cfg.save(true);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.loop();
  }
  stop() {
    this.running = false;
  }

  async loop() {
    let fails = 0;
    while (this.running) {
      try {
        const j = await this.api('GET', '/_matrix/client/v3/sync', null, {
          query: { timeout: 25000, filter: FILTER, since: this.cfg.matrix.since || undefined, set_presence: 'offline' },
          timeout: 40000,
        });
        this.handleSync(j);
        this.cfg.matrix.since = j.next_batch;
        this.cfg.matrix.lastActive = Date.now();
        this.cfg.save();
        if (!this.initialDone) { this.initialDone = true; this.emit('ready'); }
        fails = 0;
        this.emit('online', true);
      } catch (e) {
        fails++;
        if (e.status === 401) {
          this.cfg.matrix.token = null;
          try { await this.login(); continue; } catch {}
        }
        this.emit('online', false, e.message);
        await U.sleep(Math.min(30000, 2000 * fails));
      }
    }
  }

  handleSync(j) {
    const rooms = j.rooms || {};
    for (const [roomId, inv] of Object.entries(rooms.invite || {})) {
      const me = (inv.invite_state && inv.invite_state.events || []).find((e) => e.type === 'm.room.member' && e.state_key === this.userId);
      const inviter = me && me.sender;
      if (inviter && /^@sb[a-z]+\d+(bot|_)/.test(inviter)) this.join(roomId).catch(() => {});
    }
    for (const [roomId, data] of Object.entries(rooms.join || {})) {
      const room = this.store.room(roomId);
      room.left = false;
      if (data.summary && data.summary['m.heroes']) room.heroes = data.summary['m.heroes'];
      for (const ev of (data.state && data.state.events) || []) this.store.applyState(roomId, ev);
      const tl = data.timeline || {};
      if (!room.prevBatch && tl.prev_batch) room.prevBatch = tl.prev_batch;
      for (const ev of tl.events || []) {
        if (ev.state_key !== undefined) { this.store.applyState(roomId, ev); continue; }
        const res = this.store.applyTimeline(roomId, ev);
        if (res) this.emit('event', roomId, res, { live: this.initialDone, catchup: !this.initialDone && this.hadSince, since: this.lastActive });
      }
      for (const ev of (data.ephemeral && data.ephemeral.events) || []) {
        if (ev.type === 'm.typing') {
          room.typing = (ev.content.user_ids || []).filter((u) => u !== this.userId);
          this.emit('typing', roomId);
        } else if (ev.type === 'm.receipt') {
          for (const [eventId, rec] of Object.entries(ev.content || {})) {
            for (const kind of ['m.read', 'm.read.private']) {
              for (const [uid, info] of Object.entries((rec && rec[kind]) || {})) {
                const prev = room.receipts[uid];
                if (!prev || (info.ts || 0) >= prev.ts) room.receipts[uid] = { eventId, ts: info.ts || Date.now() };
              }
            }
          }
          this.store.roomsDirty = true;
          this.emit('receipt', roomId);
        }
      }
      this.emit('room', roomId);
    }
    for (const roomId of Object.keys(rooms.leave || {})) {
      const r = this.store.room(roomId);
      r.left = true;
      this.store.roomsDirty = true;
      this.emit('room', roomId);
    }
  }

  async loadOlder(roomId, limit = 50) {
    const room = this.store.room(roomId);
    if (!room.prevBatch) return 0;
    const j = await this.api('GET', `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages`, null, {
      query: { dir: 'b', from: room.prevBatch, limit, filter: JSON.stringify({ lazy_load_members: true }) },
    });
    for (const ev of j.state || []) this.store.applyState(roomId, ev);
    let n = 0;
    for (const ev of (j.chunk || []).slice().reverse()) {
      if (ev.state_key !== undefined) { this.store.applyState(roomId, ev); continue; }
      if (this.store.applyTimeline(roomId, ev)) n++;
    }
    room.prevBatch = j.end && (j.chunk || []).length ? j.end : null;
    this.store.roomsDirty = true;
    return n;
  }

  join(roomId) {
    return this.api('POST', `/_matrix/client/v3/join/${encodeURIComponent(roomId)}`, {});
  }
  leave(roomId) {
    return this.api('POST', `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/leave`, {});
  }

  send(roomId, type, content) {
    return this.api('PUT', `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/${type}/sb${this.txn++}`, content);
  }
  sendText(roomId, text, replyTo) {
    const content = { msgtype: 'm.text', body: text };
    if (replyTo) content['m.relates_to'] = { 'm.in_reply_to': { event_id: replyTo } };
    return this.send(roomId, 'm.room.message', content);
  }
  edit(roomId, eventId, text) {
    return this.send(roomId, 'm.room.message', {
      msgtype: 'm.text', body: '* ' + text,
      'm.new_content': { msgtype: 'm.text', body: text },
      'm.relates_to': { rel_type: 'm.replace', event_id: eventId },
    });
  }
  react(roomId, eventId, key) {
    return this.send(roomId, 'm.reaction', { 'm.relates_to': { rel_type: 'm.annotation', event_id: eventId, key } });
  }
  redact(roomId, eventId) {
    return this.api('PUT', `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/redact/${encodeURIComponent(eventId)}/sb${this.txn++}`, {});
  }
  receipt(roomId, eventId) {
    return this.api('POST', `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/receipt/m.read/${encodeURIComponent(eventId)}`, {});
  }
  typing(roomId, on) {
    return this.api('PUT', `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/typing/${encodeURIComponent(this.userId)}`, { typing: on, timeout: 6000 });
  }

  async upload(file) {
    const buf = fs.readFileSync(file);
    const mime = U.mimeOf(file);
    const j = await this.api('POST', '/_matrix/media/v3/upload', buf, {
      raw: true, timeout: 300000, query: { filename: path.basename(file) }, headers: { 'Content-Type': mime },
    });
    return { uri: j.content_uri, mime, size: buf.length };
  }
  async sendFile(roomId, file, caption) {
    const up = await this.upload(file);
    const msgtype = up.mime.startsWith('image/') ? 'm.image' : up.mime.startsWith('video/') ? 'm.video' : up.mime.startsWith('audio/') ? 'm.audio' : 'm.file';
    const name = path.basename(file);
    const content = { msgtype, body: caption || name, filename: name, url: up.uri, info: { mimetype: up.mime, size: up.size } };
    return this.send(roomId, 'm.room.message', content);
  }

  // Authenticated media fetch used by the sbmedia:// protocol
  async media(server, mediaId, thumb) {
    const base = thumb
      ? `${HS}/_matrix/client/v1/media/thumbnail/${server}/${mediaId}?width=480&height=480&method=scale`
      : `${HS}/_matrix/client/v1/media/download/${server}/${mediaId}`;
    return fetch(base, { headers: { Authorization: 'Bearer ' + this.token } });
  }
}

module.exports = { Matrix };
