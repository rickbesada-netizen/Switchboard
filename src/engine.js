// Runs one engine.exe process per account (WhatsApp / Messenger / Instagram) and turns its
// output into the same chat/message updates the rest of the app uses. No Docker, no server.
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const U = require('./util');

function engineBinary() {
  const exe = process.platform === 'win32' ? 'engine.exe' : 'engine';
  let electronApp = null;
  try { electronApp = require('electron').app; } catch {}
  const candidates = [];
  if (electronApp && electronApp.isPackaged) candidates.push(path.join(process.resourcesPath, 'engine', exe));
  candidates.push(path.join(__dirname, '..', 'engine', 'bin', exe));
  return candidates.find((p) => fs.existsSync(p)) || candidates[0];
}

class Proc {
  constructor(mgr, acc) {
    this.mgr = mgr;
    this.acc = acc;
    this.child = null;
    this.buf = '';
    this.pending = new Map();
    this.nextId = 1;
    this.ready = false;
    this.stopping = false;
    this.restarts = 0;
    this.logFile = U.p('logs', `engine-${acc.id}.log`);
  }

  start() {
    const bin = engineBinary();
    if (!fs.existsSync(bin)) {
      this.mgr.emit('account-error', this.acc.id, 'Engine file is missing: ' + bin);
      return;
    }
    const cfg = this.mgr.cfg;
    const args = [
      '-network', this.acc.network,
      '-account', this.acc.id,
      '-data', U.p('engine', this.acc.id),
      '-media', U.p('media'),
      '-server', cfg.settings.serverName,
      '-user', cfg.matrix.user,
      '-backfill', String(cfg.settings.backfillMessages || 200),
    ];
    if (this.acc.proxy) args.push('-proxy', this.acc.proxy);
    fs.mkdirSync(U.p('engine', this.acc.id), { recursive: true });
    fs.mkdirSync(U.p('media'), { recursive: true });
    this.rotateLog();
    this.ready = false;
    this.stopping = false;
    this.child = spawn(bin, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const logStream = fs.createWriteStream(this.logFile, { flags: 'a' });
    this.child.stderr.pipe(logStream);
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (d) => this.onData(d));
    this.child.on('error', (e) => this.mgr.emit('account-error', this.acc.id, e.message));
    this.child.on('exit', (code) => {
      logStream.end();
      this.child = null;
      this.ready = false;
      for (const p of this.pending.values()) p.reject(new Error('Engine stopped'));
      this.pending.clear();
      this.mgr.emit('account-status', this.acc.id, { running: false, code });
      if (!this.stopping) {
        this.restarts++;
        const wait = Math.min(60000, 3000 * this.restarts);
        setTimeout(() => { if (!this.stopping && this.mgr.procs[this.acc.id] === this) this.start(); }, wait);
      }
    });
  }

  rotateLog() {
    try {
      const st = fs.statSync(this.logFile);
      if (st.size > 5 * 1024 * 1024) fs.renameSync(this.logFile, this.logFile + '.old');
    } catch {}
  }

  onData(d) {
    this.buf += d;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.type === 'reply') {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          clearTimeout(p.timer);
          if (msg.ok) p.resolve(msg.data);
          else p.reject(new Error(msg.error || 'Engine error'));
        }
        continue;
      }
      if (msg.type === 'ready') {
        this.ready = true;
        this.restarts = 0;
        this.mgr.emit('account-status', this.acc.id, { running: true });
      }
      this.mgr.handle(this.acc, msg);
    }
  }

  call(cmd, args = {}, timeout = 60000) {
    if (!this.child) return Promise.reject(new Error('The engine for this account is not running'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Engine did not answer in time')); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, cmd, args }) + '\n');
    });
  }

  async waitReady(ms = 60000) {
    const end = Date.now() + ms;
    while (!this.ready) {
      if (Date.now() > end) throw new Error('The engine for this account did not start. Check its log in Accounts.');
      await U.sleep(300);
    }
  }

  async stop() {
    this.stopping = true;
    if (!this.child) return;
    const child = this.child;
    try { await this.call('quit', {}, 5000); } catch {}
    await U.sleep(1500);
    try { if (!child.killed && child.exitCode === null) child.kill(); } catch {}
  }
}

class Engine extends EventEmitter {
  constructor(cfg, store) {
    super();
    this.cfg = cfg;
    this.store = store;
    this.procs = {};
    this.typingTimers = {};
    this.initialDone = true;
  }
  get userId() {
    return this.cfg.mxid;
  }

  // ---- process management
  startAccount(acc) {
    if (this.procs[acc.id]) return this.procs[acc.id];
    const p = new Proc(this, acc);
    this.procs[acc.id] = p;
    p.start();
    return p;
  }
  async stopAccount(id) {
    const p = this.procs[id];
    if (!p) return;
    delete this.procs[id];
    await p.stop();
  }
  async restartAccount(acc) {
    await this.stopAccount(acc.id);
    return this.startAccount(acc);
  }
  startAll() {
    for (const acc of this.cfg.accounts) this.startAccount(acc);
  }
  async stopAll() {
    await Promise.all(Object.keys(this.procs).map((id) => this.stopAccount(id)));
  }
  proc(accId) {
    const p = this.procs[accId];
    if (!p) throw new Error('This account is not running');
    return p;
  }
  async call(accId, cmd, args, timeout) {
    const p = this.proc(accId);
    await p.waitReady();
    return p.call(cmd, args, timeout);
  }
  accountOfRoom(roomId) {
    const r = this.store.rooms[roomId];
    if (r && r.accountId) return r.accountId;
    const m = /^!([a-z]+\d+)_/.exec(roomId || '');
    return m ? m[1] : null;
  }
  roomCall(roomId, cmd, args, timeout) {
    const acc = this.accountOfRoom(roomId);
    if (!acc) return Promise.reject(new Error('Unknown chat'));
    return this.call(acc, cmd, { room_id: roomId, ...args }, timeout);
  }

  // ---- output from engines
  handle(acc, msg) {
    switch (msg.type) {
      case 'event': {
        const roomId = msg.room_id;
        const ev = msg.event;
        const r = this.store.room(roomId);
        if (!r.accountId) { r.accountId = acc.id; this.store.roomsDirty = true; }
        r.left = false;
        if (ev.state_key !== undefined) {
          this.store.applyState(roomId, ev);
          this.emit('room', roomId);
        } else {
          const res = this.store.applyTimeline(roomId, ev);
          if (res) this.emit('event', roomId, res, { live: true });
        }
        break;
      }
      case 'receipt': {
        const r = this.store.room(msg.room_id);
        const prev = r.receipts[msg.user_id];
        if (!prev || msg.ts >= prev.ts) r.receipts[msg.user_id] = { eventId: msg.event_id, ts: msg.ts };
        if (msg.user_id === this.userId) r.unread = 0; // read on the phone
        this.store.roomsDirty = true;
        this.emit('receipt', msg.room_id);
        break;
      }
      case 'typing': {
        const r = this.store.room(msg.room_id);
        const key = msg.room_id + '|' + msg.user_id;
        clearTimeout(this.typingTimers[key]);
        r.typing = (r.typing || []).filter((u) => u !== msg.user_id);
        if (msg.typing && msg.user_id !== this.userId) {
          r.typing.push(msg.user_id);
          this.typingTimers[key] = setTimeout(() => {
            r.typing = (r.typing || []).filter((u) => u !== msg.user_id);
            this.emit('typing', msg.room_id);
          }, Math.max(3000, Math.min(msg.timeout_ms || 6000, 30000)));
        }
        this.emit('typing', msg.room_id);
        break;
      }
      case 'mark_unread': {
        const r = this.store.room(msg.room_id);
        r.unread = msg.unread ? Math.max(1, r.unread || 0) : 0;
        this.store.roomsDirty = true;
        this.emit('room', msg.room_id);
        break;
      }
      case 'room_deleted': {
        const r = this.store.room(msg.room_id);
        r.left = true;
        this.store.roomsDirty = true;
        this.emit('room', msg.room_id);
        break;
      }
      case 'bridge_state':
        this.emit('bridge-state', acc.id, msg.state || {});
        break;
      case 'msg_status':
        if (msg.status && /FAIL|RETRI/i.test(String(msg.status))) {
          const m = this.store.find(msg.room_id, msg.event_id);
          if (m) { m.failed = msg.error || 'Not delivered'; this.store.touch(msg.room_id); }
          this.emit('msg-status', msg.room_id, msg.event_id, msg.error || 'Not delivered');
        }
        break;
      case 'fatal':
        this.emit('account-error', acc.id, msg.error);
        break;
      default:
        break;
    }
  }

  // ---- API used by main.js (same shape as the old Matrix client)
  login() { return Promise.resolve(); }
  start() { this.startAll(); }
  stop() { return this.stopAll(); }
  loadOlder() { return Promise.resolve(0); }

  send(roomId, type, content) {
    return this.roomCall(roomId, 'send', { event_type: type, content });
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
    return this.send(roomId, 'm.room.redaction', { redacts: eventId });
  }
  receipt(roomId, eventId) {
    return this.roomCall(roomId, 'receipt', { event_id: eventId });
  }
  typing(roomId, on) {
    return this.roomCall(roomId, 'typing', { typing: !!on });
  }
  sendFile(roomId, file, caption) {
    return this.roomCall(roomId, 'send_file', { path: file, caption: caption || '' }, 300000);
  }

  // media lives in data/media/<id> with a <id>.json sidecar
  mediaFile(mxc) {
    const m = /^mxc:\/\/[^/]+\/([A-Za-z0-9_-]+)$/.exec(mxc || '');
    if (!m) return null;
    const file = U.p('media', m[1]);
    if (!fs.existsSync(file)) return null;
    const meta = U.readJSON(file + '.json', {});
    return { file, mime: meta.mime || 'application/octet-stream', name: meta.name || m[1] };
  }
}

module.exports = { Engine, engineBinary };
