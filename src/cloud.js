// Switchboard account (Supabase): sign-in on every device, deciding which PC is the "host" that
// runs the messaging accounts, moving everything between PCs with encrypted snapshots, and a relay
// so phones/other PCs can reach the host from anywhere.
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const zlib = require('zlib');
const WS = require('ws');
const { createClient } = require('@supabase/supabase-js');
const U = require('./util');
const C = require('./cloud-config');

const LEASE = 90; // seconds
const TICK = Number(process.env.SB_CLOUD_TICK) || 20000;
const PART = 45 * 1024 * 1024; // storage parts stay under the 50 MB limit
const RELAY_CHUNK = 180 * 1024;

class FileStore {
  // Session storage for supabase-js, encrypted with Windows' own data protection when available
  constructor(file, safe) { this.file = file; this.safe = safe; this.cache = null; }
  load() {
    if (this.cache) return this.cache;
    try {
      const raw = fs.readFileSync(this.file);
      const txt = this.safe && this.safe.isEncryptionAvailable() ? this.safe.decryptString(raw) : raw.toString('utf8');
      this.cache = JSON.parse(txt);
    } catch { this.cache = {}; }
    return this.cache;
  }
  save() {
    const txt = JSON.stringify(this.cache || {});
    const data = this.safe && this.safe.isEncryptionAvailable() ? this.safe.encryptString(txt) : Buffer.from(txt);
    fs.writeFileSync(this.file, data);
  }
  getItem(k) { return this.load()[k] ?? null; }
  setItem(k, v) { this.load()[k] = v; this.save(); }
  removeItem(k) { delete this.load()[k]; this.save(); }
}

class Cloud extends EventEmitter {
  constructor({ cfg, log, safe, version, hooks }) {
    super();
    this.cfg = cfg;
    this.log = log;
    this.safe = safe;
    this.version = version;
    this.hooks = hooks; // prepareHandoff, collectState, applyState, engineBackups, isDirty
    this.role = null;
    this.user = null;
    this.timer = null;
    this.busy = false;
    this.lastSnapshot = 0;
    this.verified = new Map();
    this.relay = null;
    this.relayViewers = 0;
    if (!cfg.cloud) cfg.cloud = {};
    this.store = new FileStore(U.p('cloud-session.bin'), safe);
    this.sb = createClient(C.url, C.key, {
      auth: { storage: this.store, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: 'sb-switchboard' },
      realtime: { transport: WS, params: { eventsPerSecond: 50 } },
    });
  }

  get signedIn() { return !!this.user; }
  get deviceId() { return this.cfg.cloud.deviceId; }

  // ------------------------------------------------------------ key (derived from the password)
  saveKey(key) {
    const hex = key.toString('hex');
    this.cfg.cloud.key = this.safe && this.safe.isEncryptionAvailable() ? 'safe:' + this.safe.encryptString(hex).toString('base64') : 'raw:' + hex;
    this.cfg.save(true);
  }
  key() {
    const k = this.cfg.cloud.key;
    if (!k) return null;
    if (k.startsWith('safe:')) return Buffer.from(this.safe.decryptString(Buffer.from(k.slice(5), 'base64')), 'hex');
    return Buffer.from(k.slice(4), 'hex');
  }

  // ------------------------------------------------------------ account
  async init() {
    try {
      const { data } = await this.sb.auth.getSession();
      if (data && data.session) this.user = data.session.user;
    } catch (e) {
      this.log('Cloud: could not load session: ' + e.message);
    }
    this.sb.auth.onAuthStateChange((ev, session) => {
      this.user = session ? session.user : null;
      if (session && this.relay) this.sb.realtime.setAuth(session.access_token);
      this.emit('auth', this.status());
    });
    return this.signedIn;
  }

  async createAccount(email, password) {
    const r = await fetch(`${C.url}/functions/v1/create-account`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', apikey: C.key }, body: JSON.stringify({ email, password }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'Could not create the account');
    return this.signIn(email, password);
  }

  async signIn(email, password, opts = {}) {
    const { data, error } = await this.sb.auth.signInWithPassword({ email: String(email).trim(), password });
    if (error) throw new Error(error.message === 'Invalid login credentials' ? 'Wrong email or password.' : error.message);
    this.user = data.user;
    this.saveKey(crypto.pbkdf2Sync(password, 'switchboard:' + data.user.id, 310000, 32, 'sha256'));
    this.cfg.cloud.email = data.user.email;
    this.cfg.save(true);
    await this.ensureDevice();
    if (opts.start !== false) this.start();
    return this.status();
  }

  async signOut() {
    this.stop();
    if (this.role === 'host') {
      try { await this.snapshot(true); await this.sb.rpc('hand_over', { from_dev: this.deviceId, to_dev: null, snap_id: null, parts: null }); } catch {}
    }
    try { await this.sb.from('devices').delete().eq('id', this.deviceId); } catch {}
    await this.sb.auth.signOut().catch(() => {});
    this.user = null;
    delete this.cfg.cloud.key;
    delete this.cfg.cloud.deviceId;
    this.cfg.save(true);
    this.setRole('standalone');
  }

  async ensureDevice() {
    if (this.deviceId) {
      const { data } = await this.sb.from('devices').select('id').eq('id', this.deviceId).maybeSingle();
      if (data) return;
    }
    const { data: pcs } = await this.sb.from('devices').select('priority').eq('kind', 'pc');
    const server = !!process.env.SB_SERVER;
    // A server is on all the time, so it goes to the top of the list and runs the accounts
    const prio = server
      ? (pcs || []).reduce((m, d) => Math.min(m, d.priority), 10) - 10
      : ((pcs || []).reduce((m, d) => Math.max(m, d.priority), 0) || 0) + 10;
    const name = server ? 'Switchboard server' : os.hostname();
    const { data, error } = await this.sb.from('devices').insert({ name, kind: 'pc', priority: prio, version: this.version }).select().single();
    if (error) throw new Error(error.message);
    this.cfg.cloud.deviceId = data.id;
    this.cfg.save(true);
  }

  status() {
    return {
      signedIn: this.signedIn,
      email: this.user ? this.user.email : this.cfg.cloud.email || null,
      role: this.role,
      deviceId: this.deviceId || null,
      relayViewers: this.relayViewers,
    };
  }

  async devices() {
    const [{ data: devs }, { data: hs }] = await Promise.all([
      this.sb.from('devices').select('*').order('priority'),
      this.sb.from('host_state').select('*').maybeSingle(),
    ]);
    const now = Date.now();
    return (devs || []).map((d) => ({
      ...d,
      me: d.id === this.deviceId,
      online: now - new Date(d.last_seen).getTime() < 75000,
      host: !!(hs && hs.host_device === d.id && hs.lease_until && new Date(hs.lease_until).getTime() > now),
    }));
  }
  async setPriorities(order) {
    for (let i = 0; i < order.length; i++) await this.sb.from('devices').update({ priority: (i + 1) * 10 }).eq('id', order[i]);
    return this.devices();
  }
  async removeDevice(id) {
    if (id === this.deviceId) throw new Error('Use Sign out on this PC instead.');
    await this.sb.from('devices').delete().eq('id', id);
    return this.devices();
  }
  async makeHost() {
    const { data: hs } = await this.sb.from('host_state').select('*').maybeSingle();
    const alive = hs && hs.host_device && new Date(hs.lease_until).getTime() > Date.now();
    if (!alive) { await this.tick(true); return this.status(); }
    if (hs.host_device === this.deviceId) return this.status();
    await this.sb.from('host_state').update({ handoff_to: this.deviceId }).eq('user_id', this.user.id);
    this.log('Asked the current host PC to hand over...');
    return this.status();
  }

  // ------------------------------------------------------------ host election loop
  start() {
    if (this.timer || !this.signedIn) return;
    this.tick().catch((e) => this.log('Cloud: ' + e.message));
    this.timer = setInterval(() => this.tick().catch((e) => this.log('Cloud: ' + e.message)), TICK);
  }
  stop() {
    clearInterval(this.timer);
    this.timer = null;
    this.stopRelay();
  }

  setRole(role) {
    if (this.role === role) return;
    this.role = role;
    this.cfg.cloud.lastRole = role;
    this.cfg.save();
    this.emit('role', role);
  }

  async tick(force) {
    if (this.busy || !this.signedIn) return;
    this.busy = true;
    try {
      await this.ensureDevice();
      await this.sb.from('devices').update({ last_seen: new Date().toISOString(), addresses: this.hooks.addresses(), version: this.version }).eq('id', this.deviceId);
      const devs = await this.devices();
      const me = devs.find((d) => d.me);
      const { data: hs } = await this.sb.from('host_state').select('*').maybeSingle();
      const now = Date.now();
      const alive = hs && hs.host_device && hs.lease_until && new Date(hs.lease_until).getTime() > now;

      if (this.role === 'host') {
        const { data: st, error } = await this.sb.rpc('claim_host', { dev: this.deviceId, lease_seconds: LEASE });
        if (error) throw error;
        if (st.host_device !== this.deviceId) {
          // Another PC took over (e.g. after we were offline). Stop at once so both don't run.
          this.log('Another PC is now the host. Switching this PC to viewer.');
          await this.hooks.prepareHandoff();
          this.setRole('viewer');
          return;
        }
        if (st.handoff_to && st.handoff_to !== this.deviceId) return await this.handoff(st.handoff_to);
        // Hand over automatically to a higher-priority PC that is online
        const better = devs.filter((d) => d.kind === 'pc' && d.online && !d.me && d.priority < me.priority).sort((a, b) => a.priority - b.priority)[0];
        if (better) return await this.handoff(better.id);
        if (now - this.lastSnapshot > 10 * 60000 && this.hooks.isDirty()) await this.snapshot(false).catch((e) => this.log('Cloud backup failed: ' + e.message));
        this.ensureRelay();
        return;
      }

      // Not host
      const pcsOnline = devs.filter((d) => d.kind === 'pc' && d.online).sort((a, b) => a.priority - b.priority);
      const bestOnline = pcsOnline[0];
      if (!alive) {
        if (force || (bestOnline && bestOnline.me) || !bestOnline) {
          const { data: st, error } = await this.sb.rpc('claim_host', { dev: this.deviceId, lease_seconds: LEASE });
          if (error) throw error;
          if (st.host_device === this.deviceId) {
            await this.restoreIfNeeded(st);
            this.setRole('host');
            this.ensureRelay();
            return;
          }
        }
        this.setRole('viewer');
        return;
      }
      if (hs.host_device === this.deviceId) {
        // The previous host handed the accounts to this PC
        const { data: st, error } = await this.sb.rpc('claim_host', { dev: this.deviceId, lease_seconds: LEASE });
        if (error) throw error;
        await this.restoreIfNeeded(st);
        this.setRole('host');
        this.ensureRelay();
        return;
      }
      const host = devs.find((d) => d.id === hs.host_device);
      if (host && me && me.priority < host.priority && hs.handoff_to !== this.deviceId) {
        await this.sb.from('host_state').update({ handoff_to: this.deviceId }).eq('user_id', this.user.id);
        this.log(`This PC is preferred over ${host.name}. Asking it to hand over.`);
      }
      this.setRole('viewer');
    } finally {
      this.busy = false;
    }
  }

  // ------------------------------------------------------------ handover + snapshots
  async handoff(toDevice) {
    this.log('Handing accounts over to another PC...');
    this.emit('handoff', 'start');
    await this.hooks.prepareHandoff(); // stops engines, flushes everything
    const snap = await this.snapshot(true);
    const { error } = await this.sb.rpc('hand_over', { from_dev: this.deviceId, to_dev: toDevice, snap_id: snap.id, parts: snap.parts });
    if (error) throw error;
    this.log('Handed over. This PC is now a viewer.');
    this.stopRelay();
    this.setRole('viewer');
  }

  encrypt(buf) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', this.key(), iv);
    const enc = Buffer.concat([c.update(buf), c.final()]);
    return Buffer.concat([Buffer.from('SB1'), iv, c.getAuthTag(), enc]);
  }
  decrypt(buf) {
    if (buf.slice(0, 3).toString() !== 'SB1') throw new Error('Unknown snapshot format');
    const iv = buf.slice(3, 15);
    const tag = buf.slice(15, 31);
    const d = crypto.createDecipheriv('aes-256-gcm', this.key(), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(buf.slice(31)), d.final()]);
  }

  // full=true: engines are stopped, copy their files directly. full=false: live backup via the engines.
  async snapshot(full) {
    if (!this.key()) throw new Error('Sign in again to unlock cloud backups');
    const files = [];
    const add = (rel, abs) => { try { const b = fs.readFileSync(abs); files.push({ p: rel.replace(/\\/g, '/'), b }); } catch {} };
    const walk = (relDir) => {
      const abs = U.p(relDir);
      if (!fs.existsSync(abs)) return;
      for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
        const rel = path.join(relDir, e.name);
        if (e.isDirectory()) walk(rel);
        else if (!/\.tmp$/.test(e.name)) add(rel, U.p(rel));
      }
    };
    walk('chats');
    if (full) walk('engine');
    else {
      for (const b of await this.hooks.engineBackups()) {
        add(`engine/${b.id}/bridge.db`, b.dbPath);
        add(`engine/${b.id}/state.json`, U.p('engine', b.id, 'state.json'));
      }
    }
    const state = await this.hooks.collectState();
    const header = Buffer.from(JSON.stringify({ v: 1, at: Date.now(), by: this.deviceId, state, files: files.map((f) => ({ p: f.p, n: f.b.length })) }));
    const len = Buffer.alloc(4);
    len.writeUInt32BE(header.length);
    const blob = this.encrypt(zlib.gzipSync(Buffer.concat([len, header, ...files.map((f) => f.b)]), { level: 6 }));
    const id = `${Date.now()}-${U.rand(6)}`;
    const parts = Math.max(1, Math.ceil(blob.length / PART));
    for (let i = 0; i < parts; i++) {
      const { error } = await this.sb.storage.from('snapshots').upload(`${this.user.id}/${id}/part-${i}`, blob.subarray(i * PART, (i + 1) * PART), { contentType: 'application/octet-stream', upsert: true });
      if (error) throw new Error('Upload failed: ' + error.message);
    }
    if (!full) {
      await this.sb.from('host_state').update({ snapshot_id: id, snapshot_parts: parts, snapshot_at: new Date().toISOString(), snapshot_by: this.deviceId }).eq('user_id', this.user.id).eq('host_device', this.deviceId);
    }
    this.cfg.cloud.appliedSnapshot = id;
    this.cfg.save();
    this.lastSnapshot = Date.now();
    this.cleanupSnapshots(id).catch(() => {});
    this.log(`Cloud backup saved (${(blob.length / 1048576).toFixed(1)} MB${full ? ', for handover' : ''}).`);
    return { id, parts };
  }

  async cleanupSnapshots(keep) {
    const { data } = await this.sb.storage.from('snapshots').list(this.user.id, { limit: 100 });
    for (const f of data || []) {
      if (f.name === keep) continue;
      const { data: inner } = await this.sb.storage.from('snapshots').list(`${this.user.id}/${f.name}`);
      const paths = (inner || []).map((x) => `${this.user.id}/${f.name}/${x.name}`);
      if (paths.length) await this.sb.storage.from('snapshots').remove(paths);
    }
  }

  async restoreIfNeeded(st) {
    if (!st.snapshot_id || st.snapshot_id === this.cfg.cloud.appliedSnapshot) return;
    if (st.snapshot_by === this.deviceId && this.cfg.cloud.appliedSnapshot) return;
    this.log('Downloading your accounts and chats from the last host PC...');
    this.emit('handoff', 'restore');
    const chunks = [];
    for (let i = 0; i < (st.snapshot_parts || 1); i++) {
      const { data, error } = await this.sb.storage.from('snapshots').download(`${this.user.id}/${st.snapshot_id}/part-${i}`);
      if (error) throw new Error('Download failed: ' + error.message);
      chunks.push(Buffer.from(await data.arrayBuffer()));
    }
    const raw = zlib.gunzipSync(this.decrypt(Buffer.concat(chunks)));
    const hlen = raw.readUInt32BE(0);
    const header = JSON.parse(raw.subarray(4, 4 + hlen).toString('utf8'));
    let off = 4 + hlen;
    // replace local chats + engine data
    for (const dir of ['chats', 'engine']) {
      const bak = U.p(dir + '.before-restore');
      try { fs.rmSync(bak, { recursive: true, force: true }); } catch {}
      try { if (fs.existsSync(U.p(dir))) fs.renameSync(U.p(dir), bak); } catch {}
    }
    for (const f of header.files) {
      const dest = U.p(...f.p.split('/'));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, raw.subarray(off, off + f.n));
      off += f.n;
    }
    await this.hooks.applyState(header.state);
    this.cfg.cloud.appliedSnapshot = st.snapshot_id;
    this.cfg.save(true);
    this.log(`Restored ${header.files.length} files from the last host.`);
  }

  // ------------------------------------------------------------ verifying phones/PCs that connect directly
  async verifyToken(token) {
    if (!this.user || !token) return false;
    const hit = this.verified.get(token);
    if (hit && hit > Date.now()) return true;
    try {
      const r = await fetch(`${C.url}/auth/v1/user`, { headers: { apikey: C.key, Authorization: 'Bearer ' + token } });
      if (!r.ok) return false;
      const u = await r.json();
      if (u.id !== this.user.id) return false;
      this.verified.set(token, Date.now() + 10 * 60000);
      return true;
    } catch {
      return false;
    }
  }

  // ------------------------------------------------------------ relay (host side)
  ensureRelay() {
    if (this.role !== 'host' || !this.user) return;
    // A relay that dropped (expired sign-in, network blip) and didn't rejoin gets rebuilt
    if (this.relay && this.relay.state !== 'joined' && Date.now() - this.relayStarted > 30000) {
      this.log('Relay was disconnected; reconnecting.');
      this.stopRelay();
    }
    if (this.relay) return;
    this.relayStarted = Date.now();
    this.sb.auth.getSession().then(({ data }) => { if (data && data.session) this.sb.realtime.setAuth(data.session.access_token); }).catch(() => {});
    const ch = this.sb.channel('sb:' + this.user.id, { config: { private: true, broadcast: { self: false }, presence: { key: 'host-' + this.deviceId } } });
    const parts = new Map();
    ch.on('broadcast', { event: 'rpc' }, ({ payload }) => this.onRelayRpc(ch, payload, parts));
    ch.on('presence', { event: 'sync' }, () => {
      const st = ch.presenceState();
      this.relayViewers = Object.values(st).flat().filter((p) => p.role === 'viewer').length;
    });
    ch.subscribe(async (status) => {
      if (status === 'SUBSCRIBED') { await ch.track({ role: 'host', device: this.deviceId }); this.log('Relay ready: phones can reach this PC from anywhere.'); }
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        this.log('Relay connection problem (' + status + '), reconnecting.');
        if (this.relay === ch) { this.stopRelay(); setTimeout(() => this.ensureRelay(), 5000); }
      }
    });
    this.relay = ch;
  }
  stopRelay() {
    if (this.relay) { try { this.sb.removeChannel(this.relay); } catch {} }
    this.relay = null;
    this.relayViewers = 0;
  }
  relaySend(event, payload) {
    if (!this.relay) return;
    const txt = JSON.stringify(payload);
    if (txt.length <= RELAY_CHUNK) { this.relay.send({ type: 'broadcast', event, payload }); return; }
    const id = U.rand(8);
    const n = Math.ceil(txt.length / RELAY_CHUNK);
    for (let i = 0; i < n; i++) this.relay.send({ type: 'broadcast', event: event + '-part', payload: { cid: id, i, n, to: payload.to, s: txt.slice(i * RELAY_CHUNK, (i + 1) * RELAY_CHUNK) } });
  }
  async onRelayRpc(ch, m, parts) {
    if (m && m.cid) { // chunked request
      const p = parts.get(m.cid) || [];
      p[m.i] = m.s;
      parts.set(m.cid, p);
      if (p.filter((x) => x !== undefined).length < m.n) return;
      parts.delete(m.cid);
      m = JSON.parse(p.join(''));
    }
    if (!m || !m.id || !m.ch) return;
    const reply = (o) => this.relaySend('res', { to: m.from, id: m.id, ...o });
    try {
      const data = await this.hooks.handleRemote(m.ch, m.args || []);
      reply({ ok: true, data });
    } catch (e) {
      reply({ ok: false, error: e.message, screenshot: e.screenshot });
    }
  }
  relayEvent(ev, args) {
    if (!this.relay) return;
    if (ev === 'notify') { this.relay.send({ type: 'broadcast', event: 'notify', payload: args[0] }); return; }
    if (this.relayViewers > 0) this.relaySend('ev', { ev, args });
  }

  // Media for relay viewers: put the file in private storage and return a short-lived link
  async relayMedia(file, mediaId) {
    const key = `${this.user.id}/media/${mediaId}`;
    const { data: exists } = await this.sb.storage.from('relay').createSignedUrl(key, 3600);
    if (exists && exists.signedUrl) {
      const head = await fetch(exists.signedUrl, { method: 'HEAD' }).catch(() => null);
      if (head && head.ok) return exists.signedUrl;
    }
    const buf = fs.readFileSync(file.file);
    if (buf.length > 49 * 1024 * 1024) throw new Error('File too big to open away from home');
    const { error } = await this.sb.storage.from('relay').upload(key, buf, { contentType: file.mime, upsert: true });
    if (error) throw new Error(error.message);
    const { data } = await this.sb.storage.from('relay').createSignedUrl(key, 3600);
    return data.signedUrl;
  }
  async relayFetchUpload(storagePath) {
    if (!storagePath.startsWith(this.user.id + '/uploads/')) throw new Error('Bad upload');
    const { data, error } = await this.sb.storage.from('relay').download(storagePath);
    if (error) throw new Error(error.message);
    fs.mkdirSync(U.p('uploads'), { recursive: true });
    const dest = U.p('uploads', `${Date.now()}-${U.safeName(path.basename(storagePath))}`);
    fs.writeFileSync(dest, Buffer.from(await data.arrayBuffer()));
    this.sb.storage.from('relay').remove([storagePath]).catch(() => {});
    return dest;
  }
}

module.exports = { Cloud };
