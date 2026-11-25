// Loaded only when Switchboard is opened from a phone (served by the PC). Replaces the desktop
// bridge (window.sb) with a WebSocket connection to the PC.
(function () {
  if (window.sb) return;
  const qs = new URLSearchParams(location.search);
  if (qs.get('t')) {
    localStorage.setItem('sbToken', qs.get('t'));
    if (qs.get('device')) localStorage.setItem('sbDevice', qs.get('device'));
    history.replaceState(null, '', location.pathname + location.hash);
  }
  const token = localStorage.getItem('sbToken') || '';
  const deviceName = localStorage.getItem('sbDevice') || (navigator.userAgent.match(/\(([^;)]+;[^;)]+)/) || [, 'Phone'])[1];
  window.SB_REMOTE = true;
  window.SB_TOKEN = token;
  document.documentElement.classList.add('remote');

  const listeners = {};
  const pending = new Map();
  let ws = null;
  let nextId = 1;
  let queue = [];
  let everConnected = false;

  function banner(text) {
    let b = document.getElementById('connBanner');
    if (!b) {
      b = document.createElement('div');
      b.id = 'connBanner';
      document.addEventListener('DOMContentLoaded', () => document.body.appendChild(b));
      if (document.body) document.body.appendChild(b);
    }
    b.textContent = text || '';
    b.style.display = text ? 'block' : 'none';
  }

  function connect() {
    const url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws?t=' + encodeURIComponent(token) + '&device=' + encodeURIComponent(deviceName);
    ws = new WebSocket(url);
    ws.onopen = () => {
      banner(null);
      const q = queue;
      queue = [];
      q.forEach((m) => ws.send(m));
      if (everConnected && window.__sbReconnected) window.__sbReconnected();
      everConnected = true;
    };
    ws.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id);
        pending.delete(m.id);
        if (m.ok) p.resolve(m.data);
        else { const err = new Error(m.error || 'Error'); err.screenshot = m.screenshot; p.reject(err); }
      } else if (m.ev) {
        (listeners[m.ev] || []).forEach((fn) => { try { fn(...(m.args || [])); } catch (err) { console.error(err); } });
      }
    };
    ws.onclose = (e) => {
      for (const p of pending.values()) p.reject(new Error('Connection to your PC was lost'));
      pending.clear();
      if (e.code === 4001) { banner('This phone is not paired any more. Pair it again from Switchboard on your PC (Settings → Phone).'); return; }
      banner('Reconnecting to your PC...');
      setTimeout(connect, 2500);
    };
  }

  window.sb = {
    call: (ch, ...args) => new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      const msg = JSON.stringify({ id, ch, args });
      if (ws && ws.readyState === 1) ws.send(msg);
      else queue.push(msg);
    }),
    on: (ch, fn) => { (listeners[ch] = listeners[ch] || []).push(fn); },
    filePath: () => null,
  };
  window.sbUpload = async (file) => {
    const r = await fetch('/upload?t=' + encodeURIComponent(token) + '&name=' + encodeURIComponent(file.name), { method: 'POST', body: file });
    if (!r.ok) throw new Error('Upload failed');
    return (await r.json()).path;
  };
  window.sbPickFiles = (accept, multiple = true) => new Promise((resolve) => {
    const i = document.createElement('input');
    i.type = 'file';
    if (accept) i.accept = accept;
    i.multiple = multiple;
    i.onchange = async () => {
      const paths = [];
      for (const f of i.files) paths.push(await window.sbUpload(f));
      resolve(paths);
    };
    i.click();
  });
  if (!token) banner('Not paired. Open Switchboard on your PC → Settings → Phone, and scan the QR code with the Switchboard app.');
  else connect();
})();
