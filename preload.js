const { contextBridge, ipcRenderer, webUtils } = require('electron');

const EVENTS = ['log', 'stack-status', 'sync-status', 'room', 'msg', 'state', 'accounts', 'schedule', 'login-step', 'login-ask', 'open-room', 'ig-log', 'update', 'remote-info', 'msg-failed'];

contextBridge.exposeInMainWorld('sb', {
  call: async (ch, ...args) => {
    const r = await ipcRenderer.invoke(ch, ...args);
    if (!r.ok) {
      const e = new Error(r.error);
      e.screenshot = r.screenshot;
      e.code = r.code;
      throw e;
    }
    return r.data;
  },
  on: (ch, fn) => {
    if (EVENTS.includes(ch)) ipcRenderer.on(ch, (_e, ...a) => fn(...a));
  },
  filePath: (file) => (webUtils && webUtils.getPathForFile ? webUtils.getPathForFile(file) : file.path),
});
