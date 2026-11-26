const { contextBridge, ipcRenderer, webUtils } = require('electron');

const EVENTS = ['log', 'stack-status', 'sync-status', 'room', 'msg', 'state', 'accounts', 'schedule', 'login-step', 'login-ask', 'open-room', 'ig-log', 'update', 'remote-info', 'msg-failed', 'cloud'];
const mode = new URLSearchParams(location.search).get('mode') || '';

async function invoke(ch, ...args) {
  const r = await ipcRenderer.invoke(ch, ...args);
  if (!r.ok) {
    const e = new Error(r.error);
    e.screenshot = r.screenshot;
    e.code = r.code;
    throw e;
  }
  return r.data;
}
const on = (ch, fn) => { if (EVENTS.includes(ch)) ipcRenderer.on(ch, (_e, ...a) => fn(...a)); };

// Things that always run on THIS PC (account sign-in, which PC is host, updates)
contextBridge.exposeInMainWorld('sbNative', { call: invoke, on, mode, platform: 'desktop' });

// On the host PC the window talks to this PC directly. On a viewer PC, remote-shim.js connects
// to the host PC instead (window.sb is left undefined so the shim takes over).
if (mode !== 'viewer' && mode !== 'deciding') {
  contextBridge.exposeInMainWorld('sb', {
    call: invoke,
    on,
    filePath: (file) => (webUtils && webUtils.getPathForFile ? webUtils.getPathForFile(file) : file.path),
  });
}
