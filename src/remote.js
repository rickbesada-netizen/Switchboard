// Phone access: serves the Switchboard interface to paired phones over HTTP + WebSocket.
// All accounts keep running on the PC; the phone is a live window onto them (chats, folders,
// ghost read, posting, notifications). Each phone gets its own token (revocable).
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const U = require('./util');

// Things that only make sense on the PC itself
const BLOCKED = new Set([
  'openExternal', 'openPath', 'dataFolder', 'sendFiles', 'pickMedia', 'saveMedia', 'exportChat',
  'openAccountBrowser', 'loginAccount', 'loginAnswer', 'addAccount', 'removeAccount', 'updateAccount',
  'logoutAccount', 'restartEngines', 'setHiddenPin', 'saveSettings', 'installUpdate', 'checkUpdates',
  'remoteInfo', 'remoteEnable', 'remoteNewPairing', 'remoteRevoke', 'tricksterProfiles', 'boot',
  'cloudSignIn', 'cloudCreateAccount', 'cloudSignOut', 'cloudSetPriorities', 'cloudRemoveDevice', 'cloudMakeHost', 'viewerSession',
]);
// Events the phone doesn't need
const QUIET_EVENTS = new Set(['log', 'login-step', 'login-ask', 'update']);

const STATIC = {
  '/styles.css': ['renderer/styles.css', 'text/css'],
  '/app.js': ['renderer/app.js', 'application/javascript'],
  '/remote-shim.js': ['renderer/remote-shim.js', 'application/javascript'],
  '/vendor/supabase.js': ['renderer/vendor/supabase.js', 'application/javascript'],
  '/assets/icon.png': ['assets/icon.png', 'image/png'],
  '/icon.png': ['assets/icon.png', 'image/png'],
};

function lanAddresses(port) {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const tailscale = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a.address) || /tailscale/i.test(name);
      out.push({ url: `http://${a.address}:${port}`, kind: tailscale ? 'tailscale' : 'lan', iface: name });
    }
  }
  // Tailscale first (works anywhere), then home network
  return out.sort((x, y) => (x.kind === 'tailscale' ? -1 : 0) - (y.kind === 'tailscale' ? -1 : 0));
}

class Remote {
  constructor({ cfg, handlers, mediaFile, log, root, onChange, cloud }) {
    this.cloud = cloud;
    this.onChange = onChange || (() => {});
    this.cfg = cfg;
    this.handlers = handlers;
    this.mediaFile = mediaFile;
    this.log = log;
    this.root = root;
    this.server = null;
    this.wss = null;
    this.clients = new Set();
    if (!cfg.remote) cfg.remote = { devices: [] };
    if (!cfg.remote.devices) cfg.remote.devices = [];
  }
  get port() {
    return Number(this.cfg.settings.remotePort) || 47800;
  }
  get running() {
    return !!this.server;
  }

  // Signed-in Switchboard devices send their account token; QR-paired phones send a device token
  async authorize(token, name) {
    if (!token) return null;
    if (token.startsWith('eyJ') && this.cloud) {
      if (!(await this.cloud.verifyToken(token))) return null;
      return { id: 'account:' + (name || 'device'), name: name || 'Signed-in device', account: true };
    }
    return this.device(token);
  }
  device(token) {
    if (!token) return null;
    const d = this.cfg.remote.devices.find((x) => x.token === token);
    if (!d) return null;
    if (d.pending && Date.now() - d.createdAt > 30 * 60000) return null; // unused pairing codes expire
    return d;
  }
  touch(d, name) {
    if (d.account) return;
    const first = d.pending;
    d.pending = false;
    d.lastSeen = Date.now();
    if (name && (first || !d.name || d.name === 'New phone')) d.name = String(name).slice(0, 60);
    this.cfg.save();
    if (first) this.log(`Phone paired: ${d.name}`);
    setTimeout(() => this.onChange(), 50);
  }

  newPairing() {
    // drop stale unused codes
    this.cfg.remote.devices = this.cfg.remote.devices.filter((d) => !(d.pending && Date.now() - d.createdAt > 30 * 60000));
    const d = { id: U.rand(10), token: crypto.randomBytes(24).toString('hex'), name: 'New phone', createdAt: Date.now(), pending: true };
    this.cfg.remote.devices.push(d);
    this.cfg.save(true);
    return {
      payload: { app: 'switchboard', v: 1, name: os.hostname(), urls: lanAddresses(this.port).map((a) => a.url), token: d.token },
      deviceId: d.id,
    };
  }
  revoke(id) {
    const d = this.cfg.remote.devices.find((x) => x.id === id);
    this.cfg.remote.devices = this.cfg.remote.devices.filter((x) => x.id !== id);
    this.cfg.save(true);
    if (d) for (const c of this.clients) if (c.device === d) c.close(4001, 'revoked');
    this.onChange();
  }
  info() {
    return {
      enabled: !!this.cfg.settings.phoneAccess,
      running: this.running,
      port: this.port,
      addresses: lanAddresses(this.port),
      devices: this.cfg.remote.devices.filter((d) => !d.pending).map(({ token, ...d }) => ({ ...d, online: [...this.clients].some((c) => c.device && c.device.id === d.id) })),
    };
  }

  broadcast(ev, args) {
    if (!this.clients.size || QUIET_EVENTS.has(ev)) return;
    const msg = JSON.stringify({ ev, args });
    for (const c of this.clients) {
      if (c.readyState !== 1) continue;
      // the phone's background service only needs notifications; the app view needs everything else
      if (c.notifyOnly !== (ev === 'notify')) continue;
      c.send(msg);
    }
  }

  start() {
    if (this.server) return;
    this.server = http.createServer((req, res) => this.onHttp(req, res).catch((e) => {
      try { res.writeHead(500); res.end(e.message); } catch {}
    }));
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
    this.server.on('upgrade', (req, socket, head) => {
      const u = new URL(req.url, 'http://x');
      if (u.pathname !== '/ws') return socket.destroy();
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onSocket(ws, u));
    });
    this.server.on('error', (e) => { this.log('Phone access error: ' + e.message); this.stop(); });
    this.server.listen(this.port, '0.0.0.0', () => this.log(`Phone access on port ${this.port}`));
    this.pinger = setInterval(() => { for (const c of this.clients) { try { c.ping(); } catch {} } }, 25000);
  }
  stop() {
    clearInterval(this.pinger);
    for (const c of this.clients) { try { c.close(); } catch {} }
    this.clients.clear();
    try { this.wss && this.wss.close(); } catch {}
    try { this.server && this.server.close(); } catch {}
    this.server = null;
    this.wss = null;
  }

  async onSocket(ws, u) {
    const early = []; // messages that arrive while the sign-in token is being checked
    const onEarly = (raw) => early.push(raw);
    ws.on('message', onEarly);
    const d = await this.authorize(u.searchParams.get('t'), u.searchParams.get('device'));
    ws.off('message', onEarly);
    if (!d) { ws.close(4001, 'not paired'); return; }
    this.touch(d, u.searchParams.get('device'));
    ws.device = d;
    ws.notifyOnly = u.searchParams.get('notify') === '1';
    this.clients.add(ws);
    ws.on('close', () => { this.clients.delete(ws); this.onChange(); });
    const onMsg = async (raw) => {
      let m;
      try { m = JSON.parse(String(raw)); } catch { return; }
      if (!m || !m.id || !m.ch) return;
      const reply = (o) => { if (ws.readyState === 1) ws.send(JSON.stringify({ id: m.id, ...o })); };
      try { reply({ ok: true, data: await this.run(m.ch, m.args || []) }); } catch (e) { reply({ ok: false, error: e.message, screenshot: e.screenshot }); }
    };
    ws.on('message', onMsg);
    for (const raw of early) onMsg(raw);
  }

  // Runs an action for a phone / other PC (direct or via the relay)
  async run(ch, args) {
    if (BLOCKED.has(ch)) throw new Error('Do this on the PC that runs your accounts.');
    const fn = this.handlers.get(ch);
    if (!fn) throw new Error('Unknown action');
    return fn(...args);
  }

  async onHttp(req, res) {
    const u = new URL(req.url, 'http://x');
    const p = u.pathname;
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };
    const send = (code, type, body, extra = {}) => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-cache', ...cors, ...extra }); res.end(body); };
    if (req.method === 'OPTIONS') { res.writeHead(204, { ...cors, 'Access-Control-Max-Age': '86400' }); return res.end(); }

    if (p === '/ping') {
      const d = await this.authorize(u.searchParams.get('t'));
      return send(200, 'application/json', JSON.stringify({ app: 'switchboard', name: os.hostname(), paired: !!d }));
    }
    if (p === '/' || p === '/index.html') {
      let html = fs.readFileSync(path.join(this.root, 'renderer', 'index.html'), 'utf8');
      html = html.replace('src="vendor/supabase.js"', 'src="/vendor/supabase.js"').replace('src="remote-shim.js"', 'src="/remote-shim.js"').replace('src="app.js"', 'src="/app.js"')
        .replace(/\.\.\/assets\//g, '/assets/')
        
        .replace('href="styles.css"', 'href="/styles.css"');
      return send(200, 'text/html; charset=utf-8', html);
    }
    if (STATIC[p]) {
      const [rel, type] = STATIC[p];
      return send(200, type, fs.readFileSync(path.join(this.root, rel)));
    }

    const d = await this.authorize(u.searchParams.get('t') || req.headers['x-sb-token']);
    if (!d) return send(401, 'text/plain', 'Not paired');

    if (p.startsWith('/media/')) {
      const [, , server, id] = p.split('/');
      const f = this.mediaFile(`mxc://${server}/${id}`);
      if (!f) return send(404, 'text/plain', 'Not found');
      const size = fs.statSync(f.file).size;
      const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
      if (range) {
        const start = range[1] ? Number(range[1]) : 0;
        const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
        res.writeHead(206, { ...cors, 'Content-Type': f.mime, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 });
        return fs.createReadStream(f.file, { start, end }).pipe(res);
      }
      res.writeHead(200, { ...cors, 'Content-Type': f.mime, 'Content-Length': size, 'Accept-Ranges': 'bytes', 'Cache-Control': 'max-age=31536000', 'Content-Disposition': `inline; filename="${encodeURIComponent(f.name)}"` });
      return fs.createReadStream(f.file).pipe(res);
    }
    if (p === '/upload' && req.method === 'POST') {
      const name = U.safeName(u.searchParams.get('name') || 'file').slice(-80);
      fs.mkdirSync(U.p('uploads'), { recursive: true });
      const file = U.p('uploads', `${Date.now()}-${U.rand(6)}-${name}`);
      let bytes = 0;
      await new Promise((resolve, reject) => {
        const out = fs.createWriteStream(file);
        req.on('data', (c) => { bytes += c.length; if (bytes > 500 * 1024 * 1024) { req.destroy(); reject(new Error('File too big')); } });
        req.pipe(out);
        out.on('finish', resolve);
        out.on('error', reject);
        req.on('error', reject);
      });
      return send(200, 'application/json', JSON.stringify({ path: file }));
    }
    return send(404, 'text/plain', 'Not found');
  }
}

module.exports = { Remote, lanAddresses };
