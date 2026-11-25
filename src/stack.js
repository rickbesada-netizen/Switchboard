// The "engine": a private Matrix server (Synapse) plus one mautrix bridge container per account,
// all running inside Docker Desktop. Runtime data lives in Docker named volumes (not Windows bind
// mounts) so SQLite locking is reliable.
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const YAML = require('yaml');
const U = require('./util');
const { NETWORKS } = require('./config');

const PROJECT = 'switchboard';
const SYNAPSE_VOL = 'sb-synapse';

function docker(args, { input, onLine, allowFail, timeout } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn('docker', args, { windowsHide: true });
    } catch (e) {
      return reject(e);
    }
    let out = '';
    let err = '';
    let timer = null;
    if (timeout) timer = setTimeout(() => { try { child.kill(); } catch {} }, timeout);
    const feed = (d) => {
      if (!onLine) return;
      String(d).split(/\r?\n/).map((l) => l.trim()).filter(Boolean).forEach(onLine);
    };
    child.stdout.on('data', (d) => { out += d; feed(d); });
    child.stderr.on('data', (d) => { err += d; feed(d); });
    child.on('error', (e) => { clearTimeout(timer); reject(e.code === 'ENOENT' ? new Error('DOCKER_MISSING') : e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 && !allowFail) reject(new Error((err || out).trim().split('\n').slice(-3).join(' ') || `docker exited with code ${code}`));
      else resolve({ code, out, err });
    });
    if (input != null) child.stdin.end(input);
    else child.stdin.end();
  });
}

class Stack extends EventEmitter {
  constructor(cfg) {
    super();
    this.cfg = cfg;
    this.status = 'stopped';
    this.composeFile = U.p('stack', 'compose.yml');
  }

  log(msg) {
    this.emit('log', msg);
  }
  setStatus(s, detail) {
    this.status = s;
    this.emit('status', { status: s, detail });
  }
  get img() {
    return this.cfg.settings.images;
  }
  vol(acc) {
    return `sb-bridge-${acc.id}`;
  }

  // ---- volume helpers (read/write files inside named volumes via a tiny helper container)
  async volRead(vol, file) {
    const r = await docker(['run', '--rm', '-v', `${vol}:/data`, this.img.helper, 'cat', `/data/${file}`], { allowFail: true });
    return r.code === 0 ? r.out : null;
  }
  async volWrite(vol, file, content) {
    const dir = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '';
    const cmd = (dir ? `mkdir -p '/data/${dir}' && ` : '') + `cat > '/data/${file}'`;
    await docker(['run', '--rm', '-i', '-v', `${vol}:/data`, this.img.helper, 'sh', '-c', cmd], { input: content });
  }

  async checkDocker() {
    try {
      await docker(['version', '--format', '{{.Server.Version}}'], { timeout: 20000 });
      return { ok: true };
    } catch (e) {
      if (e.message === 'DOCKER_MISSING') return { ok: false, reason: 'missing' };
      return { ok: false, reason: 'not-running', detail: e.message };
    }
  }

  async pull(image) {
    const have = await docker(['image', 'inspect', image], { allowFail: true });
    if (have.code === 0) return;
    this.log(`Downloading ${image} (first time only)...`);
    let last = 0;
    await docker(['pull', image], {
      onLine: (l) => {
        if (Date.now() - last > 2500) { last = Date.now(); this.log('  ' + l.slice(0, 120)); }
      },
    });
  }

  async ensureSynapse() {
    await this.pull(this.img.helper);
    await this.pull(this.img.synapse);
    await docker(['volume', 'create', SYNAPSE_VOL]);
    const existing = await this.volRead(SYNAPSE_VOL, 'homeserver.yaml');
    if (existing) return;
    this.log('Creating your private message server...');
    await docker([
      'run', '--rm', '-v', `${SYNAPSE_VOL}:/data`,
      '-e', `SYNAPSE_SERVER_NAME=${this.cfg.settings.serverName}`,
      '-e', 'SYNAPSE_REPORT_STATS=no',
      this.img.synapse, 'generate',
    ], { onLine: (l) => this.log('  ' + l) });
  }

  // Create/refresh one bridge's config + registration inside its volume
  async bootstrapBridge(acc) {
    const net = NETWORKS[acc.network];
    const image = this.img[net.imageKey];
    const vol = this.vol(acc);
    const sn = this.cfg.settings.serverName;
    await this.pull(image);
    await docker(['volume', 'create', vol]);

    let text = await this.volRead(vol, 'config.yaml');
    if (!text) {
      this.log(`Preparing ${net.label} bridge for "${acc.label}"...`);
      await docker(['run', '--rm', '-v', `${vol}:/data`, image], { allowFail: true, timeout: 120000 });
      text = await this.volRead(vol, 'config.yaml');
      if (!text) throw new Error(`The ${net.label} bridge did not create its config file. Check the image name in Settings.`);
    }

    const doc = YAML.parseDocument(text);
    const set = (path, v) => doc.setIn(path, v);
    set(['homeserver', 'address'], 'http://synapse:8008');
    set(['homeserver', 'domain'], sn);
    set(['appservice', 'address'], `http://bridge-${acc.id}:${acc.port}`);
    set(['appservice', 'hostname'], '0.0.0.0');
    set(['appservice', 'port'], acc.port);
    set(['appservice', 'id'], acc.asId);
    set(['appservice', 'bot', 'username'], `sb${acc.id}bot`);
    set(['appservice', 'bot', 'displayname'], `${net.label} bridge (${acc.label})`);
    set(['appservice', 'username_template'], `sb${acc.id}_{{.}}`);
    set(['database', 'type'], 'sqlite3-fk-wal');
    set(['database', 'uri'], 'file:/data/mautrix.db?_txlock=immediate');
    set(['bridge', 'permissions'], doc.createNode({ '*': 'relay', [sn]: 'user', [this.cfg.mxid]: 'admin' }));
    set(['provisioning', 'shared_secret'], acc.secret);
    set(['backfill', 'enabled'], true);
    set(['backfill', 'max_initial_messages'], 100);
    set(['backfill', 'unread_hours_threshold'], 24);
    // Top-level proxy section (bridgev2). null = direct connection.
    set(['proxy', 'url'], acc.proxy || null);
    // Never tell the remote side we're online because we typed
    if (doc.hasIn(['network', 'send_presence_on_typing'])) set(['network', 'send_presence_on_typing'], false);
    await this.volWrite(vol, 'config.yaml', doc.toString());

    const reg = await this.volRead(vol, 'registration.yaml');
    if (!reg) {
      await docker(['run', '--rm', '-v', `${vol}:/data`, image], { allowFail: true, timeout: 120000 });
      if (!(await this.volRead(vol, 'registration.yaml'))) throw new Error(`The ${net.label} bridge did not create its registration file.`);
    }
    acc.needsBootstrap = false;
    this.cfg.save();
  }

  async syncRegistrations() {
    for (const acc of this.cfg.accounts) {
      const reg = await this.volRead(this.vol(acc), 'registration.yaml');
      if (!reg) throw new Error(`Missing registration for ${acc.label}`);
      await this.volWrite(SYNAPSE_VOL, `appservices/${acc.asId}.yaml`, reg);
    }
    const hsText = await this.volRead(SYNAPSE_VOL, 'homeserver.yaml');
    const hs = YAML.parseDocument(hsText);
    hs.set('app_service_config_files', hs.createNode(this.cfg.accounts.map((a) => `/data/appservices/${a.asId}.yaml`)));
    hs.set('max_upload_size', '200M');
    hs.set('suppress_key_server_warning', true);
    hs.set('presence', hs.createNode({ enabled: false }));
    hs.set('rc_message', hs.createNode({ per_second: 30, burst_count: 100 }));
    hs.set('redaction_retention_period', '365d');
    await this.volWrite(SYNAPSE_VOL, 'homeserver.yaml', hs.toString());
  }

  writeCompose() {
    const services = {
      synapse: {
        image: this.img.synapse,
        restart: 'unless-stopped',
        volumes: [`${SYNAPSE_VOL}:/data`],
        ports: ['127.0.0.1:8008:8008'],
      },
    };
    const volumes = { [SYNAPSE_VOL]: { external: true, name: SYNAPSE_VOL } };
    for (const acc of this.cfg.accounts) {
      const net = NETWORKS[acc.network];
      services[`bridge-${acc.id}`] = {
        image: this.img[net.imageKey],
        restart: 'unless-stopped',
        depends_on: ['synapse'],
        volumes: [`${this.vol(acc)}:/data`],
        ports: [`127.0.0.1:${acc.port}:${acc.port}`],
      };
      volumes[this.vol(acc)] = { external: true, name: this.vol(acc) };
    }
    fs.mkdirSync(U.p('stack'), { recursive: true });
    fs.writeFileSync(this.composeFile, YAML.stringify({ name: PROJECT, services, volumes }));
  }

  compose(args, opts) {
    return docker(['compose', '-p', PROJECT, '-f', this.composeFile, ...args], opts);
  }

  async waitSynapse(timeoutMs = 120000) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      try {
        const r = await fetch('http://127.0.0.1:8008/health');
        if (r.ok) return;
      } catch {}
      await U.sleep(1500);
    }
    throw new Error('Message server did not start in time. Open Docker Desktop and check the "switchboard" containers.');
  }

  async ensureUser() {
    const r = await this.compose(['exec', '-T', 'synapse', 'register_new_matrix_user', '-u', this.cfg.matrix.user, '-p', this.cfg.matrix.password, '-a', '-c', '/data/homeserver.yaml', 'http://localhost:8008'], { allowFail: true });
    const txt = (r.out + r.err).toLowerCase();
    if (r.code !== 0 && !txt.includes('taken') && !txt.includes('in use')) throw new Error('Could not create your inbox user: ' + (r.err || r.out).trim());
  }

  // Full start: safe to call every launch
  async start() {
    this.setStatus('starting');
    try {
      const d = await this.checkDocker();
      if (!d.ok) {
        this.setStatus(d.reason === 'missing' ? 'docker-missing' : 'docker-stopped', d.detail);
        return false;
      }
      await this.ensureSynapse();
      for (const acc of this.cfg.accounts) {
        if (acc.needsBootstrap) await this.bootstrapBridge(acc);
        else await this.pull(this.img[NETWORKS[acc.network].imageKey]);
      }
      await this.syncRegistrations();
      this.writeCompose();
      this.log('Starting engine...');
      await this.compose(['up', '-d', '--remove-orphans'], { onLine: (l) => this.log('  ' + l) });
      await this.waitSynapse();
      await this.ensureUser();
      this.setStatus('running');
      this.log('Engine running.');
      return true;
    } catch (e) {
      this.setStatus('error', e.message);
      this.log('Error: ' + e.message);
      throw e;
    }
  }

  // After adding/removing/changing accounts
  async applyAccounts(changedAcc) {
    if (changedAcc) await this.bootstrapBridge(changedAcc);
    await this.syncRegistrations();
    this.writeCompose();
    await this.compose(['up', '-d', '--remove-orphans'], { onLine: (l) => this.log('  ' + l) });
    this.log('Reloading message server...');
    await this.compose(['restart', 'synapse']);
    if (changedAcc) await this.compose(['restart', `bridge-${changedAcc.id}`], { allowFail: true });
    await this.waitSynapse();
  }

  async removeAccountData(acc) {
    await this.compose(['rm', '-sf', `bridge-${acc.id}`], { allowFail: true });
    await docker(['volume', 'rm', '-f', this.vol(acc)], { allowFail: true });
  }

  async stop() {
    await this.compose(['stop'], { allowFail: true });
    this.setStatus('stopped');
  }

  async logs(service, lines = 200) {
    const r = await this.compose(['logs', '--no-color', '--tail', String(lines), service], { allowFail: true });
    return (r.out + r.err).trim();
  }
}

module.exports = { Stack, docker };
