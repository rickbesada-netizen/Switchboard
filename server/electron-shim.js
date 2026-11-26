// Stands in for Electron when Switchboard runs on a server with no screen. The rest of the app
// (engines, chat store, Switchboard account, relay, scheduled posts) runs exactly as on a PC.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const HOME = process.env.SB_HOME || path.join(os.homedir(), '.switchboard');
fs.mkdirSync(HOME, { recursive: true });
const PKG = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
const NO_SCREEN = 'This needs a screen, so it can\'t be done on the Switchboard server.';

const appEvents = new EventEmitter();
const app = {
  isPackaged: false,
  getPath: () => HOME,
  getVersion: () => PKG.version,
  requestSingleInstanceLock: () => true,
  setAppUserModelId() {},
  setLoginItemSettings() {},
  whenReady: () => Promise.resolve(),
  on: (ev, fn) => { appEvents.on(ev, fn); return app; },
  quit: () => shutdown(0),
};
let quitting = false;
function shutdown(code) {
  if (quitting) return;
  quitting = true;
  try { appEvents.emit('before-quit', { preventDefault() {} }); } catch {}
  setTimeout(() => process.exit(code), 3000).unref();
}
process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));

// The main window: there isn't one, so it reports itself as closed and everything skips it
class BrowserWindow extends EventEmitter {
  constructor(opts = {}) {
    super();
    if (!(opts.webPreferences && opts.webPreferences.preload)) {
      throw new Error('Logging in with a browser window isn\'t possible on the Switchboard server. Paste the account\'s cookies instead, or on your laptop press "Run accounts on this PC", add the account there, and the server takes it back afterwards.');
    }
    this.webContents = { send() {}, setWindowOpenHandler() {} };
  }
  isDestroyed() { return true; }
  isVisible() { return false; }
  isFocused() { return false; }
  isMinimized() { return false; }
  loadFile() {} loadURL() {} show() {} hide() {} focus() {} restore() {} close() {}
}

// Cookie jars for each account (what the login windows would have kept on a PC)
const sessions = {};
function fromPartition(name) {
  if (sessions[name]) return sessions[name];
  const dir = path.join(HOME, 'data', 'cookies');
  const file = path.join(dir, name.replace(/[^a-z0-9_-]/gi, '_') + '.json');
  let list = [];
  try { list = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  const save = () => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, JSON.stringify(list)); };
  const same = (a, b) => a.name === b.name && String(a.domain || '') === String(b.domain || '') && (a.path || '/') === (b.path || '/');
  const ses = {
    cookies: {
      get: async (f = {}) => list.filter((c) => (!f.name || c.name === f.name) && (!f.domain || String(c.domain).replace(/^\./, '').endsWith(String(f.domain).replace(/^\./, '')))),
      set: async (c) => {
        let domain = c.domain;
        if (!domain && c.url) domain = new URL(c.url).hostname;
        const n = { name: c.name, value: c.value, domain, path: c.path || '/', secure: !!c.secure, httpOnly: !!c.httpOnly, expirationDate: c.expirationDate, sameSite: c.sameSite };
        list = list.filter((x) => !same(x, n));
        list.push(n);
        save();
      },
      remove: async (url, name) => { const h = new URL(url).hostname; list = list.filter((c) => !(c.name === name && h.endsWith(String(c.domain).replace(/^\./, '')))); save(); },
      flushStore: async () => {},
    },
    setProxy: async () => {},
    getUserAgent: () => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    setUserAgent() {},
    clearStorageData: async () => { list = []; save(); },
  };
  sessions[name] = ses;
  return ses;
}

// Encryption for the saved sign-in, with a key that only this server's Switchboard user can read
const KEYFILE = path.join(HOME, '.key');
function key() {
  try { return fs.readFileSync(KEYFILE); } catch {}
  const k = crypto.randomBytes(32);
  fs.writeFileSync(KEYFILE, k, { mode: 0o600 });
  return k;
}
const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString(s) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
    const ct = Buffer.concat([c.update(String(s), 'utf8'), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), ct]);
  },
  decryptString(buf) {
    const d = crypto.createDecipheriv('aes-256-gcm', key(), buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
  },
};

class Notification extends EventEmitter { static isSupported() { return false; } show() {} }
class Tray extends EventEmitter { setToolTip() {} setContextMenu() {} }
const noScreen = async () => { throw new Error(NO_SCREEN); };

module.exports = {
  app,
  BrowserWindow,
  ipcMain: { handle() {}, on() {} },
  dialog: { showOpenDialog: noScreen, showSaveDialog: noScreen, showMessageBox: noScreen },
  protocol: { registerSchemesAsPrivileged() {}, handle() {} },
  Notification,
  shell: { openExternal: async () => {}, openPath: noScreen },
  Tray,
  Menu: { buildFromTemplate: () => ({}) },
  nativeImage: { createFromPath: () => ({ resize() { return this; } }) },
  session: { fromPartition, defaultSession: fromPartition('default') },
  net: { fetch: (...a) => fetch(...a) },
  safeStorage,
  HOME,
};
