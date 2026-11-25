const { app, BrowserWindow, ipcMain, dialog, protocol, Notification, shell, Tray, Menu, nativeImage, session, net } = require('electron');
const { pathToFileURL } = require('url');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const U = require('./src/util');
const { Config, NETWORKS } = require('./src/config');
const { Store } = require('./src/store');
const { Engine } = require('./src/engine');
const { parseCookieText, fillCookieFields } = require('./src/bridges');
const trickster = require('./src/trickster');
const social = require('./src/social');
const { Remote } = require('./src/remote');
const os = require('os');

protocol.registerSchemesAsPrivileged([
  { scheme: 'sbmedia', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true } },
]);

if (!app.requestSingleInstanceLock()) app.quit();

let win = null;
let tray = null;
let quitting = false;
let cfg, store, engine, matrix; // matrix = engine (same interface as the old Matrix client)
let engineStatus = 'stopped';
const bridgeStates = {};
let focusedRoom = null;
const bootTime = Date.now();
const accStatus = {}; // accId -> {state, logins:[]}
const autoReplyLast = {};
const typingThrottle = {};
const pendingAsks = new Map();
let booting = null;

const ICON = path.join(__dirname, 'assets', 'icon.png');

const handlers = new Map(); // every action, shared by the desktop window and paired phones
let remote = null;
function send(ch, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(ch, ...args);
  if (remote) remote.broadcast(ch, args);
}
function log(msg) {
  send('log', msg);
  try { fs.appendFileSync(U.p('logs', 'switchboard.log'), `[${new Date().toISOString()}] ${msg}\n`); } catch {}
}

// ---------------------------------------------------------------- helpers
function accountFor(uid) {
  if (!uid) return null;
  return cfg.accounts.find((a) => uid.startsWith(`@sb${a.id}_`) || uid.startsWith(`@sb${a.id}bot:`)) || null;
}
function isBot(uid) {
  return /^@sb[a-z]+\d+bot:/.test(uid || '');
}
function isMe(uid) {
  if (uid === matrix.userId) return true;
  const acc = accountFor(uid);
  return !!(acc && (acc.selfGhosts || []).includes(uid));
}
function roomAccount(r) {
  if (r.accountId && cfg.account(r.accountId)) return cfg.account(r.accountId);
  for (const uid of Object.keys(r.members)) {
    const a = accountFor(uid);
    if (a && !isBot(uid)) { r.accountId = a.id; return a; }
  }
  return null;
}
function memberName(r, uid) {
  if (uid === matrix.userId) return 'You';
  const m = r.members[uid];
  if (m && m.name) return m.name;
  return uid.replace(/^@/, '').split(':')[0];
}
function others(r) {
  return Object.entries(r.members)
    .filter(([uid, m]) => m.membership === 'join' && !isMe(uid) && !isBot(uid) && uid !== matrix.userId)
    .map(([uid]) => uid);
}
function roomName(r) {
  if (r.explicitName) return r.explicitName;
  const o = others(r);
  if (o.length) return o.slice(0, 4).map((u) => memberName(r, u)).join(', ');
  return 'Chat';
}
function roomHidden(r) {
  if (r.left) return true;
  if (r.createdType === 'm.space') return true;
  const acc = roomAccount(r);
  if (!acc) return true;
  const ghosts = Object.keys(r.members).filter((u) => accountFor(u) && !isBot(u));
  return ghosts.length === 0; // management room (just you + bridge bot)
}
// bridge texts can be plain strings or localised objects
function txt(x) {
  if (!x) return '';
  if (typeof x === 'string') return x;
  return x.text || x.en || x.message || Object.values(x).find((v) => typeof v === 'string' && v !== x.key) || '';
}
function preview(m) {
  if (m.deleted && m.lost) return 'Deleted message';
  const t = { 'm.image': 'Photo', 'm.video': 'Video', 'm.audio': 'Voice message', 'm.file': 'File' }[m.type];
  return (t ? t + (m.body && m.type !== 'm.audio' && !/\.[a-z0-9]{2,4}$/i.test(m.body) ? ': ' + m.body : '') : m.body || '').slice(0, 140);
}
function ghostOn(r) {
  return r.ghost === null || r.ghost === undefined ? cfg.settings.ghostRead : r.ghost;
}
function typingHidden(r) {
  return r.hideTyping === null || r.hideTyping === undefined ? cfg.settings.hideTyping : r.hideTyping;
}
function summary(r) {
  const acc = roomAccount(r);
  const o = others(r);
  let seenTs = 0;
  for (const [uid, rec] of Object.entries(r.receipts || {})) if (!isMe(uid) && !isBot(uid) && uid !== matrix.userId) seenTs = Math.max(seenTs, rec.ts || 0);
  const avatarUid = !r.avatar && o.length === 1 ? o[0] : null;
  return {
    id: r.id,
    name: roomName(r),
    avatar: r.avatar || (avatarUid && r.members[avatarUid] && r.members[avatarUid].avatar) || null,
    accountId: acc && acc.id,
    accountLabel: acc && acc.label,
    network: acc && acc.network,
    unread: r.unread || 0,
    lastTs: r.lastTs || 0,
    lastPreview: r.lastPreview || '',
    tags: r.tags || [],
    note: r.note || '',
    ghost: r.ghost, ghostEffective: ghostOn(r),
    hideTyping: r.hideTyping, hideTypingEffective: typingHidden(r),
    pinned: !!r.pinned, archived: !!r.archived, stash: !!r.stash,
    typing: (r.typing || []).filter((u) => !isMe(u)).map((u) => memberName(r, u)),
    isGroup: o.length > 1,
    seenTs,
    hidden: roomHidden(r),
    canLoadOlder: !!r.prevBatch,
  };
}
function msgOut(r, m) {
  return { ...m, mine: isMe(m.sender), senderName: memberName(r, m.sender), senderAvatar: (r.members[m.sender] || {}).avatar || null };
}
function publicAccount(a) {
  const { secret, cookies, ...rest } = a;
  return { ...rest, hasCookies: !!(cookies && cookies.length), status: accStatus[a.id] || null };
}
function publicSettings() {
  const { hiddenPinHash, ...rest } = cfg.settings;
  return { ...rest, hiddenPinSet: !!hiddenPinHash };
}
function pinHash(pin) {
  return require('crypto').createHash('sha256').update('switchboard-hidden:' + pin).digest('hex');
}
function state() {
  return {
    settings: publicSettings(),
    setupDone: cfg.setupDone,
    stackStatus: engineStatus,
    networks: NETWORKS,
    accounts: cfg.accounts.map(publicAccount),
    rooms: Object.values(store.rooms).map(summary).filter((s) => !s.hidden),
    tags: cfg.tags,
    quickReplies: cfg.quickReplies,
    autoReplies: cfg.autoReplies,
    schedule: cfg.schedule,
    me: matrix ? matrix.userId : null,
  };
}
// New chats from an account go into that account's default folders
function applyDefaultFolders(r) {
  if (r.foldersInit) return;
  const acc = roomAccount(r);
  if (!acc) return;
  if ((acc.defaultFolders || []).length && !(r.tags || []).length) r.tags = [...acc.defaultFolders];
  r.foldersInit = true;
  store.roomsDirty = true;
}
function pushRoom(roomId) {
  const r = store.rooms[roomId];
  if (r) applyDefaultFolders(r);
  if (r) send('room', summary(r));
}

// ---------------------------------------------------------------- engine boot
// Each account runs in its own built-in engine process (no Docker, no server).
class BridgeAPI {
  constructor(acc) { this.acc = acc; }
  waitReady() { return engine.proc(this.acc.id).waitReady(90000); }
  flows() { return engine.call(this.acc.id, 'login_flows', {}, 30000); }
  start(flowId) { return engine.call(this.acc.id, 'login_start', { flow_id: flowId }, 120000); }
  step(loginId, stepId, type, body, timeout) { return engine.call(this.acc.id, 'login_step', { login_id: loginId, step_type: type, data: body || {} }, timeout || 120000); }
  whoami() { return engine.call(this.acc.id, 'whoami', {}, 20000); }
  logout(loginId) { return engine.call(this.acc.id, 'logout', { login_id: loginId }, 60000); }
}

async function boot() {
  if (booting) return booting;
  booting = (async () => {
    try {
      engineStatus = 'running';
      send('stack-status', { status: engineStatus });
      cfg.setupDone = true;
      cfg.save();
      engine.startAll();
      setTimeout(() => { for (const a of cfg.accounts) refreshAccount(a).catch(() => {}); }, 4000);
      return true;
    } finally {
      booting = null;
    }
  })();
  return booting;
}

function tailFile(file, maxBytes = 120000) {
  try {
    const st = fs.statSync(file);
    const fd = fs.openSync(file, 'r');
    const len = Math.min(st.size, maxBytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    fs.closeSync(fd);
    return buf.toString('utf8');
  } catch {
    return '';
  }
}

async function refreshAccount(acc) {
  try {
    const w = await new BridgeAPI(acc, cfg).whoami();
    const prev = (accStatus[acc.id] && accStatus[acc.id].logins) || [];
    const logins = (w.logins || []).map((l) => {
      const st = (bridgeStates[acc.id] || {})[l.id] || {};
      const old = prev.find((x) => x.id === l.id) || {};
      return {
        id: l.id,
        name: l.name || (l.profile && (l.profile.name || l.profile.username || l.profile.phone)) || l.id,
        state: st.state_event || old.state || 'CONNECTING',
        error: st.message || st.error || null,
      };
    });
    accStatus[acc.id] = { online: true, logins };
    const sn = cfg.settings.serverName;
    acc.selfGhosts = logins.map((l) => `@sb${acc.id}_${U.escapeLocalpart(l.id)}:${sn}`);
    cfg.save();
  } catch (e) {
    accStatus[acc.id] = { online: false, logins: [], error: e.message };
  }
  send('accounts', cfg.accounts.map(publicAccount));
}

// ---------------------------------------------------------------- incoming events
function onEvent(roomId, res, { live, catchup, since }) {
  const r = store.room(roomId);
  const m = res.msg;
  if (res.kind === 'new') {
    if (m.ts >= (r.lastTs || 0)) {
      r.lastTs = m.ts;
      r.lastPreview = (isMe(m.sender) ? 'You: ' : '') + preview(m);
    }
    const fresh = (live && m.ts > Date.now() - 10 * 60000) || (catchup && m.ts > (since || 0) - 60000);
    if (fresh && !isMe(m.sender) && !isBot(m.sender) && !roomHidden(r)) {
      if (focusedRoom !== roomId || !win || !win.isFocused()) r.unread = (r.unread || 0) + 1;
      if (live && focusedRoom === roomId && win && win.isVisible() && !ghostOn(r)) matrix.receipt(roomId, m.id).catch(() => {});
      if (live) notify(r, m);
      if (m.ts > bootTime - 60000) autoReply(r, m).catch((e) => log('Auto-reply failed: ' + e.message));
    }
    if (live && isMe(m.sender)) r.unread = 0;
  }
  store.roomsDirty = true;
  if (res.kind === 'delete' && !cfg.settings.keepDeleted) {
    m.body = ''; m.url = undefined; m.lost = true;
  }
  send('msg', roomId, msgOut(r, m), res.kind);
  pushRoom(roomId);
}

function notify(r, m) {
  if (r.stash && cfg.settings.muteHidden !== false) return;
  const acc = roomAccount(r);
  const title = `${roomName(r)}${acc ? ' · ' + NETWORKS[acc.network].label : ''}`;
  const body = (r.members[m.sender] && others(r).length > 1 ? memberName(r, m.sender) + ': ' : '') + preview(m);
  const pcActive = win && win.isVisible() && win.isFocused();
  if (remote && cfg.settings.phoneNotifications !== false && !pcActive) remote.broadcast('notify', [{ title, body, roomId: r.id }]);
  if (win && win.isFocused() && focusedRoom === r.id) return;
  if (!cfg.settings.notifications || !Notification.isSupported()) return;
  const n = new Notification({
    title,
    body,
    icon: ICON,
    silent: false,
  });
  n.on('click', () => { showWindow(); send('open-room', r.id); });
  n.show();
}

async function autoReply(r, m) {
  if (others(r).length > 1) return; // only one-to-one chats
  const acc = roomAccount(r);
  if (!acc) return;
  const text = (m.body || '').toLowerCase();
  for (const rule of cfg.autoReplies) {
    if (!rule.enabled) continue;
    if (rule.accountIds && rule.accountIds.length && !rule.accountIds.includes(acc.id)) continue;
    const kws = String(rule.keywords || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (kws.length && !kws.some((k) => text.includes(k))) continue;
    if (rule.hours && rule.hours.on) {
      const now = new Date();
      const mins = now.getHours() * 60 + now.getMinutes();
      const [fh, fm] = String(rule.hours.from || '17:00').split(':').map(Number);
      const [th, tm] = String(rule.hours.to || '09:00').split(':').map(Number);
      const from = fh * 60 + fm; const to = th * 60 + tm;
      const inside = from <= to ? mins >= from && mins < to : mins >= from || mins < to;
      if (!inside) continue;
    }
    const key = rule.id + '|' + r.id;
    const cool = (Number(rule.cooldownMin) || 60) * 60000;
    if (autoReplyLast[key] && Date.now() - autoReplyLast[key] < cool) continue;
    autoReplyLast[key] = Date.now();
    await U.sleep(1500 + Math.random() * 2500);
    await matrix.sendText(r.id, rule.text);
    log(`Auto-reply "${rule.name || rule.text.slice(0, 20)}" sent in ${roomName(r)}`);
    return;
  }
}

// ---------------------------------------------------------------- built-in account browser
// Every Messenger/Instagram account gets its own private browser session (its own cookies) that
// goes through that account's proxy. Used to log in without Trickster and to post to Instagram.
function proxyRule(p) {
  try {
    const u = new URL(p.includes('://') ? p : 'http://' + p);
    return `${u.protocol}//${u.hostname}:${u.port}`;
  } catch {
    return null;
  }
}
function accSession(acc) {
  const ses = session.fromPartition('persist:acc-' + acc.id);
  if (ses.__sbProxy !== (acc.proxy || '')) {
    const rule = acc.proxy ? proxyRule(acc.proxy) : null;
    ses.setProxy(rule ? { proxyRules: rule, proxyBypassRules: '<local>' } : { mode: 'direct' });
    ses.__sbProxy = acc.proxy || '';
    ses.__sbAcc = acc.id;
    ses.setUserAgent(ses.getUserAgent().replace(/\s?Electron\/\S+/, '').replace(/\s?switchboard\/\S+/i, ''));
  }
  return ses;
}
async function sessionCookies(acc) {
  const net = NETWORKS[acc.network];
  if (!net.cookieSite) return [];
  const host = new URL(net.cookieSite).hostname.replace(/^www\./, '');
  const all = await accSession(acc).cookies.get({});
  return all.filter((c) => String(c.domain).replace(/^\./, '').endsWith(host));
}
function openAccountBrowser(acc, url) {
  const w = new BrowserWindow({
    width: 1100, height: 850, title: `${acc.label} - ${NETWORKS[acc.network].label}`, icon: ICON, autoHideMenuBar: true,
    webPreferences: { session: accSession(acc), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  w.loadURL(url || NETWORKS[acc.network].cookieSite);
  return w;
}
// Opens a login window and resolves once the site has set the cookies the bridge needs
function loginWindow(acc, needed) {
  const net = NETWORKS[acc.network];
  return new Promise((resolve, reject) => {
    const w = openAccountBrowser(acc, net.loginUrl);
    let done = false;
    let loggedAt = 0;
    const want = [...new Set([net.loginCookie, ...(needed || [])].filter(Boolean))];
    const timer = setInterval(async () => {
      if (done) return;
      try {
        const ck = await sessionCookies(acc);
        const has = (n) => ck.some((c) => c.name === n && c.value);
        if (has(net.loginCookie) && !loggedAt) loggedAt = Date.now();
        // all needed cookies present, or logged in for 20s (some optional ones never appear)
        if (want.every(has) || (loggedAt && Date.now() - loggedAt > 20000)) {
          done = true;
          clearInterval(timer);
          await U.sleep(2500); // let the site finish setting its cookies
          const final = await sessionCookies(acc);
          w.close();
          resolve(final);
        }
      } catch {}
    }, 1500);
    w.on('closed', () => {
      clearInterval(timer);
      if (!done) { done = true; reject(new Error('The login window was closed before you finished logging in.')); }
    });
  });
}
app.on('login', (event, wc, details, authInfo, callback) => {
  if (!authInfo.isProxy || !wc) return;
  const accId = wc.session && wc.session.__sbAcc;
  const acc = accId && cfg.account(accId);
  if (!acc || !acc.proxy) return;
  try {
    const u = new URL(acc.proxy.includes('://') ? acc.proxy : 'http://' + acc.proxy);
    if (!u.username) return;
    event.preventDefault();
    callback(decodeURIComponent(u.username), decodeURIComponent(u.password));
  } catch {}
});
function useTrickster(acc) {
  return !!(cfg.settings.tricksterEnabled && acc.tricksterProfileId);
}
async function postAccount(acc) {
  // What the poster needs: Trickster profile if enabled, otherwise this account's own saved login
  return { ...acc, tricksterProfileId: useTrickster(acc) ? acc.tricksterProfileId : null, cookies: useTrickster(acc) ? acc.cookies : await sessionCookies(acc) };
}

// ---------------------------------------------------------------- logins
function ask(accId, fields, instructions, kind) {
  return new Promise((resolve, reject) => {
    const id = U.rand(10);
    pendingAsks.set(id, { resolve, reject });
    send('login-ask', { id, accId, fields, instructions, kind });
  });
}

async function cookiesForAccount(acc, opts, cookieStep) {
  const net = NETWORKS[acc.network];
  const domain = '.' + new URL(net.cookieSite).hostname.replace(/^www\./, '');
  if (opts && opts.cookiesText) return parseCookieText(opts.cookiesText, domain);
  if (useTrickster(acc)) {
    send('login-step', { accId: acc.id, type: 'info', text: 'Reading login cookies from the Trickster profile...' });
    const all = await trickster.getCookies(cfg, acc.tricksterProfileId);
    const mine = all.filter((c) => String(c.domain).replace(/^\./, '').endsWith(domain.slice(1)));
    if (!mine.length) throw new Error(`The Trickster profile has no ${net.label} cookies. Log in to ${net.cookieSite} in that profile first.`);
    return mine;
  }
  // Built-in login window (own session + this account's proxy)
  const needed = [];
  for (const f of (cookieStep && cookieStep.fields) || []) {
    if (f.required === false) continue;
    const src = (f.sources || []).find((x) => x.type === 'cookie');
    if (src) needed.push(src.name);
  }
  send('login-step', { accId: acc.id, type: 'info', text: `A ${net.label} login window has opened. Log in there (including any security code) and it will close by itself.` });
  return loginWindow(acc, needed);
}

async function runLogin(accId, opts = {}) {
  const acc = cfg.account(accId);
  if (!acc) throw new Error('Unknown account');
  const api = new BridgeAPI(acc, cfg);
  send('login-step', { accId, type: 'info', text: 'Waiting for the bridge to come online...' });
  await api.waitReady();
  const flows = (await api.flows()).flows || [];
  if (!flows.length) throw new Error('This bridge offers no login methods.');
  const net = NETWORKS[acc.network];
  let flow = flows.find((f) => f.id === opts.flowId);
  if (!flow && net.flow) flow = flows.find((f) => f.id === net.flow);
  if (!flow && net.login === 'qr') flow = flows.find((f) => /qr/i.test(f.id)) || flows[0];
  if (!flow) flow = flows.find((f) => /cookie|browser/i.test(f.id + ' ' + txt(f.name))) || flows[0];

  let step = await api.start(flow.id);
  const loginId = step.login_id;
  let cookies = null;
  for (let i = 0; i < 40; i++) {
    if (step.type === 'complete') {
      send('login-step', { accId, type: 'complete', text: 'Logged in!' });
      log(`${acc.label}: logged in`);
      await U.sleep(1500);
      await refreshAccount(acc);
      return { ok: true };
    }
    if (step.type === 'display_and_wait') {
      const d = step.display_and_wait || {};
      const payload = { accId, type: d.type || 'code', instructions: txt(step.instructions) };
      if (d.type === 'nothing') { send('login-step', { accId, type: 'info', text: txt(step.instructions) || 'Waiting...' }); step = await api.step(loginId, step.step_id, 'display_and_wait', {}, 300000); continue; }
      if (d.type === 'qr') payload.qr = await QRCode.toDataURL(d.data, { margin: 1, width: 320 });
      else payload.code = d.data;
      send('login-step', payload);
      step = await api.step(loginId, step.step_id, 'display_and_wait', {}, 300000);
      continue;
    }
    if (step.type === 'cookies') {
      if (!cookies) cookies = await cookiesForAccount(acc, opts, step.cookies);
      if (useTrickster(acc)) { acc.cookies = cookies; cfg.save(); }
      const { body, missing } = fillCookieFields(step.cookies, cookies);
      if (missing.length) throw new Error('Missing cookies: ' + missing.join(', ') + '. Make sure you are logged in, then try again.');
      send('login-step', { accId, type: 'info', text: 'Sending cookies to the bridge...' });
      step = await api.step(loginId, step.step_id, 'cookies', body, 120000);
      continue;
    }
    if (step.type === 'user_input') {
      const fields = (step.user_input && step.user_input.fields) || [];
      const ans = await ask(accId, fields.map((f) => ({ ...f, name: txt(f.name), description: txt(f.description) })), txt(step.instructions), 'input');
      step = await api.step(loginId, step.step_id, 'user_input', ans, 120000);
      continue;
    }
    if (step.type === 'client_http' || step.type === 'webauthn') throw new Error('This login method needs a phone/browser handshake Switchboard does not support. Try "Paste cookies instead".');
    throw new Error('Unexpected login step: ' + step.type);
  }
  throw new Error('Login did not finish.');
}

// ---------------------------------------------------------------- scheduler
async function runScheduled(item) {
  if (item.kind === 'message') {
    await matrix.sendText(item.roomId, item.text);
  } else if (social.KINDS[item.kind]) {
    const acc = cfg.account(item.accountId);
    if (!acc) throw new Error('Account no longer exists');
    await social.run(cfg, await postAccount(acc), item, (t) => log(`[Post ${acc.label}] ${t}`));
  }
}
function startScheduler() {
  let busy = false;
  setInterval(async () => {
    if (busy) return;
    const due = cfg.schedule.filter((s) => s.status === 'pending' && s.at <= Date.now());
    if (!due.length) return;
    busy = true;
    for (const item of due) {
      item.status = 'running';
      send('schedule', cfg.schedule);
      try {
        if (item.kind === 'message' && !matrix.initialDone) { item.status = 'pending'; continue; }
        await runScheduled(item);
        item.status = 'done';
        item.doneAt = Date.now();
      } catch (e) {
        item.status = 'failed';
        item.error = e.message;
        log('Scheduled item failed: ' + e.message);
      }
      cfg.save();
      send('schedule', cfg.schedule);
    }
    busy = false;
  }, 15000);
}

// ---------------------------------------------------------------- window / tray
function showWindow() {
  if (!win) createWindow();
  win.show();
  if (win.isMinimized()) win.restore();
  win.focus();
}
function createWindow(hidden) {
  win = new BrowserWindow({
    show: !hidden,
    width: 1360, height: 860, minWidth: 980, minHeight: 600,
    backgroundColor: '#0d0f14', title: 'Switchboard', icon: ICON,
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('close', (e) => {
    if (!quitting && cfg.settings.minimizeToTray) { e.preventDefault(); win.hide(); }
  });
  win.on('focus', () => {
    if (focusedRoom && store.rooms[focusedRoom]) { store.rooms[focusedRoom].unread = 0; pushRoom(focusedRoom); }
  });
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
}
function createTray() {
  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
  tray.setToolTip('Switchboard');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Switchboard', click: showWindow },
    { type: 'separator' },
    { label: 'Quit (stops receiving messages until reopened)', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', showWindow);
}

// ---------------------------------------------------------------- updates (GitHub releases)
let updateState = { state: 'idle' };
function setUpdate(st) {
  updateState = { ...updateState, ...st };
  send('update', updateState);
}
function setupUpdater() {
  if (!app.isPackaged) { updateState = { state: 'dev' }; return; }
  let autoUpdater;
  try { autoUpdater = require('electron-updater').autoUpdater; } catch (e) { log('Updater unavailable: ' + e.message); return; }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('checking-for-update', () => setUpdate({ state: 'checking' }));
  autoUpdater.on('update-available', (i) => { setUpdate({ state: 'downloading', version: i.version, percent: 0 }); log(`Update ${i.version} found, downloading`); });
  autoUpdater.on('update-not-available', () => setUpdate({ state: 'latest', checkedAt: Date.now() }));
  autoUpdater.on('download-progress', (p) => setUpdate({ state: 'downloading', percent: Math.round(p.percent || 0) }));
  autoUpdater.on('update-downloaded', (i) => {
    setUpdate({ state: 'ready', version: i.version });
    log(`Update ${i.version} ready. Restart Switchboard to install it.`);
    if (Notification.isSupported()) new Notification({ title: 'Switchboard update ready', body: `Version ${i.version} is ready. Click Restart to update in Switchboard.`, icon: ICON }).show();
  });
  autoUpdater.on('error', (e) => setUpdate({ state: 'error', error: String(e && e.message || e).split('\n')[0] }));
  global.__updater = autoUpdater;
  setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 15000);
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 3 * 3600 * 1000);
}
function applyLoginItem() {
  if (!app.isPackaged || process.platform !== 'win32') return;
  try { app.setLoginItemSettings({ openAtLogin: cfg.settings.startWithWindows !== false, args: ['--hidden'] }); } catch {}
}

// ---------------------------------------------------------------- IPC
function handle(ch, fn) {
  handlers.set(ch, fn);
  ipcMain.handle(ch, async (e, ...args) => {
    try { return { ok: true, data: await fn(...args) }; } catch (err) { return { ok: false, error: err.message, screenshot: err.screenshot, code: err.code }; }
  });
}

function setupIpc() {
  handle('state', () => state());
  handle('boot', () => boot());
  handle('appInfo', () => ({ version: app.getVersion(), packaged: app.isPackaged, update: updateState, hostname: os.hostname() }));
  handle('checkUpdates', async () => {
    if (!global.__updater) return { state: app.isPackaged ? 'error' : 'dev', error: 'Updates only work in the installed app' };
    await global.__updater.checkForUpdates();
    return updateState;
  });
  handle('installUpdate', async () => {
    if (!global.__updater || updateState.state !== 'ready') throw new Error('No update ready yet');
    quitting = true;
    store.flush();
    cfg.save(true);
    await engine.stopAll();
    global.__updater.quitAndInstall(true, true);
    return true;
  });
  handle('remoteInfo', () => remote.info());
  handle('remoteEnable', (on) => {
    cfg.settings.phoneAccess = !!on;
    cfg.save(true);
    if (on) remote.start(); else remote.stop();
    return remote.info();
  });
  handle('remoteNewPairing', async () => {
    if (!remote.running) { cfg.settings.phoneAccess = true; cfg.save(true); remote.start(); }
    const { payload } = remote.newPairing();
    if (win && !win.isDestroyed()) win.webContents.send('remote-info', remote.info());
    const text = JSON.stringify(payload);
    return { qr: await QRCode.toDataURL(text, { margin: 1, width: 360, errorCorrectionLevel: 'M' }), payload, text };
  });
  handle('remoteRevoke', (id) => { remote.revoke(id); return remote.info(); });
  handle('restartEngines', async () => { for (const a of cfg.accounts) await engine.restartAccount(a); return true; });
  handle('stackLogs', () => tailFile(U.p('logs', 'switchboard.log')));
  handle('openExternal', (url) => shell.openExternal(url));

  handle('messages', (roomId) => {
    const r = store.room(roomId);
    return store.messages(roomId).slice(-400).map((m) => msgOut(r, m));
  });
  handle('search', (q) => {
    const needle = String(q || '').toLowerCase();
    const hits = [];
    for (const r of Object.values(store.rooms)) {
      if (roomHidden(r)) continue;
      const msgs = store.messages(r.id);
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if ((m.body || '').toLowerCase().includes(needle)) {
          hits.push({ roomId: r.id, roomName: roomName(r), id: m.id, ts: m.ts, body: m.body.slice(0, 140), senderName: memberName(r, m.sender) });
          if (hits.length > 200) break;
        }
      }
    }
    return hits.sort((a, b) => b.ts - a.ts).slice(0, 60);
  });
  handle('loadOlder', async (roomId) => {
    const n = await matrix.loadOlder(roomId);
    const r = store.room(roomId);
    return { added: n, messages: store.messages(roomId).map((m) => msgOut(r, m)), canLoadOlder: !!r.prevBatch };
  });
  handle('focusRoom', (roomId) => {
    focusedRoom = roomId;
    const r = roomId && store.rooms[roomId];
    if (!r) return;
    r.unread = 0;
    store.roomsDirty = true;
    if (!ghostOn(r)) {
      const last = [...store.messages(roomId)].reverse().find((m) => !isMe(m.sender));
      if (last) matrix.receipt(roomId, last.id).catch(() => {});
    }
    pushRoom(roomId);
  });
  handle('markReadOnPlatform', async (roomId) => {
    const last = [...store.messages(roomId)].reverse().find((m) => !isMe(m.sender) && !m.id.startsWith('~'));
    if (last) await matrix.receipt(roomId, last.id);
    return true;
  });
  handle('markUnread', (roomId) => { const r = store.room(roomId); r.unread = Math.max(1, r.unread || 0); store.roomsDirty = true; pushRoom(roomId); });
  handle('send', (roomId, text, replyTo) => matrix.sendText(roomId, text, replyTo));
  handle('sendFiles', async (roomId) => {
    const res = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'] });
    if (res.canceled) return 0;
    for (const f of res.filePaths) await matrix.sendFile(roomId, f);
    return res.filePaths.length;
  });
  handle('sendFilePaths', async (roomId, paths) => { for (const f of paths) await matrix.sendFile(roomId, f); return paths.length; });
  handle('edit', (roomId, eventId, text) => matrix.edit(roomId, eventId, text));
  handle('react', (roomId, eventId, key) => matrix.react(roomId, eventId, key));
  handle('redact', (roomId, eventId) => matrix.redact(roomId, eventId));
  handle('typing', async (roomId) => {
    const r = store.rooms[roomId];
    if (!r || typingHidden(r)) return false;
    if (typingThrottle[roomId] && Date.now() - typingThrottle[roomId] < 4000) return true;
    typingThrottle[roomId] = Date.now();
    await matrix.typing(roomId, true);
    return true;
  });
  handle('roomSettings', (roomId, patch) => {
    const r = store.room(roomId);
    for (const k of ['ghost', 'hideTyping', 'tags', 'note', 'pinned', 'archived', 'stash']) if (k in patch) r[k] = patch[k];
    store.roomsDirty = true;
    pushRoom(roomId);
    return summary(r);
  });
  handle('saveMedia', async (mxc, name) => {
    const f = engine.mediaFile(mxc);
    if (!f) throw new Error('This file is not saved on this PC');
    const res = await dialog.showSaveDialog(win, { defaultPath: name || f.name });
    if (res.canceled) return false;
    fs.copyFileSync(f.file, res.filePath);
    return true;
  });
  handle('exportChat', async (roomId, format) => {
    const r = store.room(roomId);
    const msgs = store.messages(roomId);
    const name = U.safeName(roomName(r));
    const res = await dialog.showSaveDialog(win, { defaultPath: `${name}.${format}`, filters: [{ name: format.toUpperCase(), extensions: [format] }] });
    if (res.canceled) return false;
    let out;
    const rows = msgs.map((m) => ({ time: new Date(m.ts).toISOString(), sender: memberName(r, m.sender), type: m.type.replace('m.', ''), text: m.body, deleted: !!m.deleted, edited: !!m.edited, previous_versions: (m.edits || []).map((e) => e.body).join(' | ') }));
    if (format === 'json') out = JSON.stringify(rows, null, 2);
    else if (format === 'csv') {
      const esc = (v) => '"' + String(v).replace(/"/g, '""') + '"';
      out = 'time,sender,type,text,deleted,edited,previous_versions\n' + rows.map((x) => [x.time, x.sender, x.type, x.text, x.deleted, x.edited, x.previous_versions].map(esc).join(',')).join('\n');
    } else {
      out = rows.map((x) => `[${new Date(x.time).toLocaleString()}] ${x.sender}: ${x.text}${x.deleted ? '  (deleted by sender)' : ''}${x.edited ? '  (edited; was: ' + x.previous_versions + ')' : ''}`).join('\n');
    }
    fs.writeFileSync(res.filePath, out, 'utf8');
    return true;
  });

  // accounts
  handle('tricksterProfiles', () => trickster.listProfiles(cfg));
  handle('addAccount', async ({ network, label, proxy, tricksterProfileId }) => {
    if (!NETWORKS[network]) throw new Error('Unknown network');
    const id = cfg.newAccountId(network);
    const acc = {
      id, network, label: label || `${NETWORKS[network].label} ${id.replace(/\D/g, '')}`,
      proxy: (proxy || '').trim(), tricksterProfileId: tricksterProfileId || null,
      createdAt: Date.now(),
    };
    cfg.accounts.push(acc);
    cfg.save(true);
    if (engineStatus !== 'running') await boot();
    engine.startAccount(acc);
    send('accounts', cfg.accounts.map(publicAccount));
    return publicAccount(acc);
  });
  handle('updateAccount', async (id, patch) => {
    const acc = cfg.account(id);
    if (!acc) throw new Error('Unknown account');
    const proxyChanged = 'proxy' in patch && (patch.proxy || '').trim() !== acc.proxy;
    if ('label' in patch) acc.label = patch.label;
    if (Array.isArray(patch.defaultFolders)) {
      acc.defaultFolders = patch.defaultFolders;
      if (patch.applyFoldersToExisting && acc.defaultFolders.length) {
        for (const r of Object.values(store.rooms)) {
          if (roomAccount(r) === acc && !(r.tags || []).length) { r.tags = [...acc.defaultFolders]; pushRoom(r.id); }
        }
        store.roomsDirty = true;
      }
    }
    if ('tricksterProfileId' in patch) acc.tricksterProfileId = patch.tricksterProfileId || null;
    if (proxyChanged) acc.proxy = (patch.proxy || '').trim();
    cfg.save(true);
    if (proxyChanged) { log(`${acc.label}: proxy changed, restarting`); await engine.restartAccount(acc); }
    send('accounts', cfg.accounts.map(publicAccount));
    return publicAccount(acc);
  });
  handle('loginAccount', (id, opts) => runLogin(id, opts));
  handle('loginAnswer', (askId, answers) => {
    const p = pendingAsks.get(askId);
    if (!p) return false;
    pendingAsks.delete(askId);
    if (answers === null) p.reject(new Error('Cancelled'));
    else p.resolve(answers);
    return true;
  });
  handle('logoutAccount', async (id) => {
    const acc = cfg.account(id);
    const api = new BridgeAPI(acc, cfg);
    for (const l of (accStatus[id] && accStatus[id].logins) || []) await api.logout(l.id).catch(() => {});
    await refreshAccount(acc);
    return true;
  });
  handle('removeAccount', async (id) => {
    const acc = cfg.account(id);
    if (!acc) return true;
    const api = new BridgeAPI(acc, cfg);
    for (const l of (accStatus[id] && accStatus[id].logins) || []) await api.logout(l.id).catch(() => {});
    cfg.accounts = cfg.accounts.filter((a) => a.id !== id);
    cfg.save(true);
    try { await accSession(acc).clearStorageData(); } catch {}
    await engine.stopAccount(acc.id);
    try { fs.rmSync(U.p('engine', acc.id), { recursive: true, force: true }); } catch {}
    send('accounts', cfg.accounts.map(publicAccount));
    return true;
  });
  handle('refreshAccounts', async () => { for (const a of cfg.accounts) await refreshAccount(a); return cfg.accounts.map(publicAccount); });
  handle('accountLogs', (id) => tailFile(U.p('logs', `engine-${id}.log`)) || 'No log yet.');
  handle('openAccountBrowser', (id) => {
    const acc = cfg.account(id);
    if (!acc || !NETWORKS[acc.network].cookieSite) throw new Error('This account has no browser');
    openAccountBrowser(acc);
    return true;
  });
  handle('accountBrowserStatus', async (id) => {
    const acc = cfg.account(id);
    const net = acc && NETWORKS[acc.network];
    if (!net || !net.loginCookie) return null;
    const ck = await sessionCookies(acc);
    return ck.some((c) => c.name === net.loginCookie && c.value);
  });

  // settings & tools
  handle('setHiddenPin', (pin) => {
    cfg.settings.hiddenPinHash = pin ? pinHash(String(pin)) : null;
    cfg.save(true);
    return publicSettings();
  });
  handle('checkHiddenPin', (pin) => !cfg.settings.hiddenPinHash || pinHash(String(pin || '')) === cfg.settings.hiddenPinHash);
  handle('saveSettings', async (patch) => {
    delete patch.hiddenPinHash;
    delete patch.hiddenPinSet;
    const historyChanged = 'messengerEncryptedHistory' in patch && patch.messengerEncryptedHistory !== cfg.settings.messengerEncryptedHistory;
    Object.assign(cfg.settings, patch);
    if ('startWithWindows' in patch) applyLoginItem();
    if (historyChanged) for (const a of cfg.accounts) if (a.network === 'messenger') engine.restartAccount(a).catch(() => {});
    cfg.save(true);
    for (const r of Object.values(store.rooms)) pushRoom(r.id);
    return publicSettings();
  });
  handle('saveList', (key, list) => {
    if (!['tags', 'quickReplies', 'autoReplies'].includes(key)) throw new Error('bad key');
    cfg[key] = list;
    cfg.save(true);
    return cfg[key];
  });
  handle('scheduleAdd', (item) => {
    const it = { id: U.rand(10), status: 'pending', createdAt: Date.now(), ...item };
    cfg.schedule.push(it);
    cfg.save(true);
    send('schedule', cfg.schedule);
    return it;
  });
  handle('scheduleRemove', (id) => {
    cfg.schedule = cfg.schedule.filter((s) => s.id !== id);
    cfg.save(true);
    send('schedule', cfg.schedule);
    return true;
  });
  handle('scheduleClearDone', () => {
    cfg.schedule = cfg.schedule.filter((s) => s.status === 'pending' || s.status === 'running');
    cfg.save(true);
    send('schedule', cfg.schedule);
    return true;
  });
  handle('pickMedia', async () => {
    const res = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'], filters: [{ name: 'Photos and videos', extensions: ['jpg', 'jpeg', 'png', 'webp', 'heic', 'mp4', 'mov'] }] });
    return res.canceled ? [] : res.filePaths;
  });
  handle('socialPost', async (job) => {
    const acc = cfg.account(job.accountId);
    if (!acc) throw new Error('Pick an account');
    return social.run(cfg, await postAccount(acc), job, (t) => send('ig-log', t));
  });
  handle('savePages', (id, pages) => {
    const acc = cfg.account(id);
    if (!acc) throw new Error('Unknown account');
    acc.pages = (pages || []).filter((p) => p && p.url).map((p) => ({ name: String(p.name || p.url).trim(), url: String(p.url).trim() }));
    cfg.save(true);
    send('accounts', cfg.accounts.map(publicAccount));
    return acc.pages;
  });
  handle('openPath', (p) => shell.openPath(p));
  handle('dataFolder', () => shell.openPath(U.DATA));
}

// ---------------------------------------------------------------- app start
app.on('second-instance', () => showWindow());
app.on('before-quit', () => { quitting = true; try { remote && remote.stop(); } catch {} store && store.flush(); cfg && cfg.save(true); if (engine) for (const p of Object.values(engine.procs)) { p.stopping = true; try { p.child && p.child.stdin.write(JSON.stringify({ id: 0, cmd: 'quit' }) + '\n'); } catch {} } });
app.on('window-all-closed', () => { if (!cfg || !cfg.settings.minimizeToTray) app.quit(); });

app.whenReady().then(async () => {
  app.setAppUserModelId('com.switchboard.inbox');
  U.init(path.join(app.getPath('userData'), 'data'));
  fs.mkdirSync(U.p('logs'), { recursive: true });
  cfg = new Config();
  if (!cfg.foldersV2) {
    const want = [['personal', 'Personal', '#38bdf8'], ['business', 'Business', '#34d399'], ['church', 'Church', '#fbbf24']];
    for (const [id, name, color] of want) if (!cfg.tags.some((t) => t.name.toLowerCase() === name.toLowerCase())) cfg.tags.push({ id, name, color });
    cfg.foldersV2 = true;
    cfg.save(true);
  }
  store = new Store();
  engine = new Engine(cfg, store);
  matrix = engine;
  engine.on('account-status', (id, s) => {
    const acc = cfg.account(id);
    if (!acc) return;
    accStatus[id] = { ...(accStatus[id] || { logins: [] }), online: !!s.running };
    if (s.running) setTimeout(() => refreshAccount(acc).catch(() => {}), 1500);
    else { log(`${acc.label}: engine stopped (code ${s.code}), restarting`); send('accounts', cfg.accounts.map(publicAccount)); }
  });
  engine.on('account-error', (id, msg) => log(`${(cfg.account(id) || {}).label || id}: ${msg}`));
  engine.on('bridge-state', (id, st) => {
    const acc = cfg.account(id);
    if (!acc) return;
    const map = (bridgeStates[id] = bridgeStates[id] || {});
    const s = (accStatus[id] = accStatus[id] || { online: true, logins: [] });
    if (st.remote_id) {
      map[st.remote_id] = st;
      let l = s.logins.find((x) => x.id === st.remote_id);
      if (st.state_event === 'LOGGED_OUT') s.logins = s.logins.filter((x) => x.id !== st.remote_id);
      else {
        if (!l) { l = { id: st.remote_id }; s.logins.push(l); }
        l.name = st.remote_name || l.name || st.remote_id;
        l.state = st.state_event;
        l.error = st.message || st.error || null;
      }
      if (/BAD_CREDENTIALS|LOGGED_OUT/.test(st.state_event)) log(`${acc.label}: ${st.state_event.toLowerCase().replace(/_/g, ' ')}${st.message ? ' - ' + st.message : ''}`);
    }
    send('accounts', cfg.accounts.map(publicAccount));
  });
  engine.on('msg-status', (roomId, eventId, err) => {
    send('msg-failed', roomId, eventId, err);
    const r = store.rooms[roomId];
    const m = r && store.find(roomId, eventId);
    if (m) send('msg', roomId, msgOut(r, m), 'update');
  });
  matrix.on('event', onEvent);
  matrix.on('room', pushRoom);
  matrix.on('typing', pushRoom);
  matrix.on('receipt', pushRoom);
  matrix.on('ready', () => send('state', state()));
  matrix.on('online', (on, err) => send('sync-status', { online: on, error: err }));

  protocol.handle('sbmedia', async (req) => {
    const u = new URL(req.url); // sbmedia://media/<server>/<id>
    const parts = u.pathname.split('/').filter(Boolean);
    const f = engine.mediaFile(`mxc://${parts[0]}/${parts[1]}`);
    if (!f) return new Response('Not found', { status: 404 });
    const r = await net.fetch(pathToFileURL(f.file).toString());
    return new Response(r.body, { status: 200, headers: { 'Content-Type': f.mime, 'Cache-Control': 'max-age=31536000' } });
  });

  setupIpc();
  createWindow(process.argv.includes('--hidden'));
  createTray();
  applyLoginItem();
  setupUpdater();
  remote = new Remote({ cfg, handlers, mediaFile: (mxc) => engine.mediaFile(mxc), log, root: __dirname, onChange: () => { if (win && !win.isDestroyed()) win.webContents.send('remote-info', remote.info()); } });
  if (cfg.settings.phoneAccess) remote.start();
  startScheduler();
  setInterval(() => { for (const a of cfg.accounts) refreshAccount(a).catch(() => {}); }, 120000);

  boot().catch((e) => log('Start failed: ' + e.message));
});
