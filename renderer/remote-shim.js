// Connects this window to the PC that runs your accounts (the "host") when this device isn't it:
// the Android app, a second PC (viewer), or a browser opened on the host's address.
// - Signed in with a Switchboard account: finds the host through Supabase, then connects straight
//   to it on the home network / Tailscale, or through the private relay when away from home.
// - Older QR pairing (token in the address) still works when the page is served by the PC.
(function () {
  if (window.sb) return; // the host PC's own window talks to it directly

  const CFG = { url: 'https://jeovbbtpjpgdaruzauee.supabase.co', key: 'sb_publishable_nxOCxuA75XAi4x2IdQkRUg_xu0Njzml' };
  const native = window.sbNative || null; // desktop (viewer PC)
  const android = window.SBAndroid || null; // Android app
  window.SB_REMOTE = true;
  document.documentElement.classList.add('remote');

  const listeners = {};
  const pending = new Map();
  let nextId = 1;
  let queue = [];
  let transport = null; // { kind, send(msg) }
  let everConnected = false;
  let mediaBase = null;
  let token = '';
  const deviceName = android && android.deviceName ? android.deviceName() : native ? 'PC' : (navigator.userAgent.match(/\(([^;)]+;[^;)]+)/) || [, 'Browser'])[1];

  // ------------------------------------------------------------ UI bits
  function banner(text) {
    let b = document.getElementById('connBanner');
    if (!b) {
      b = document.createElement('div');
      b.id = 'connBanner';
      (document.body || document.documentElement).appendChild(b);
    }
    b.textContent = text || '';
    b.style.display = text ? 'block' : 'none';
  }
  function overlay(html) {
    let o = document.getElementById('sbOverlay');
    if (!html) { if (o) o.remove(); return null; }
    if (!o) {
      o = document.createElement('div');
      o.id = 'sbOverlay';
      document.body.appendChild(o);
    }
    o.innerHTML = `<div class="sbo-card"><img src="${document.querySelector('.brand img') ? document.querySelector('.brand img').src : ''}" alt="">${html}</div>`;
    return o;
  }
  const whenReady = (fn) => (document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', fn) : fn());

  // ------------------------------------------------------------ RPC plumbing shared by all transports
  function deliver(m) {
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.ok) p.resolve(m.data);
      else { const err = new Error(m.error || 'Error'); err.screenshot = m.screenshot; p.reject(err); }
    } else if (m.ev) {
      (listeners[m.ev] || []).forEach((fn) => { try { fn(...(m.args || [])); } catch (e) { console.error(e); } });
    }
  }
  function dropTransport(reason) {
    transport = null;
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error(reason || 'Connection to your PC was lost')); }
    pending.clear();
  }
  function connected(t) {
    transport = t;
    banner(null);
    overlay(null);
    const q = queue;
    queue = [];
    q.forEach((m) => t.send(m));
    if (everConnected && window.__sbReconnected) window.__sbReconnected();
    everConnected = true;
  }

  window.sb = {
    call: (ch, ...args) => new Promise((resolve, reject) => {
      const id = nextId++;
      const long = ch === 'socialPost' || ch === 'sendFilePaths';
      const timer = setTimeout(() => {
        if (!pending.has(id)) return;
        pending.delete(id);
        reject(new Error('Your PC did not answer in time'));
        // through the relay, no answer usually means the link went stale: reconnect
        if (!long && transport && transport.kind === 'relay') {
          if (relayChan) { try { SB.removeChannel(relayChan); } catch {} relayChan = null; }
          dropTransport();
          banner('Reconnecting to your PC...');
          setTimeout(() => { starting = false; start(); }, 1000);
        }
      }, long ? 600000 : transport && transport.kind === 'relay' ? 30000 : 90000);
      pending.set(id, { resolve, reject, timer });
      const msg = { id, ch, args };
      if (transport) transport.send(msg);
      else queue.push(msg);
    }),
    on: (ch, fn) => { (listeners[ch] = listeners[ch] || []).push(fn); },
    filePath: () => null,
  };

  // ------------------------------------------------------------ direct WebSocket to the PC
  function connectDirect(base, onFail) {
    const wsUrl = base.replace(/^http/, 'ws') + '/ws?t=' + encodeURIComponent(token) + '&device=' + encodeURIComponent(deviceName);
    const ws = new WebSocket(wsUrl);
    let opened = false;
    ws.onopen = () => {
      opened = true;
      mediaBase = base;
      connected({ kind: 'direct', send: (m) => ws.send(JSON.stringify(m)) });
    };
    ws.onmessage = (e) => { try { deliver(JSON.parse(e.data)); } catch {} };
    ws.onclose = (e) => {
      if (!opened) return onFail();
      dropTransport();
      if (e.code === 4001) { banner('This device is not allowed to connect. Sign in again.'); return; }
      banner('Reconnecting to your PC...');
      setTimeout(onFail, 2000);
    };
  }

  // ------------------------------------------------------------ relay through Supabase (from anywhere)
  let SB = null;
  let relayChan = null;
  const myId = 'v-' + Math.random().toString(36).slice(2, 10);
  function connectRelay(uid, onFail) {
    const parts = new Map();
    const reassemble = (p) => {
      const arr = parts.get(p.cid) || [];
      arr[p.i] = p.s;
      parts.set(p.cid, arr);
      if (arr.filter((x) => x !== undefined).length < p.n) return null;
      parts.delete(p.cid);
      return JSON.parse(arr.join(''));
    };
    const ch = SB.channel('sb:' + uid, { config: { private: true, broadcast: { self: false }, presence: { key: myId } } });
    ch.on('broadcast', { event: 'res' }, ({ payload }) => { if (payload.to === myId) deliver(payload); });
    ch.on('broadcast', { event: 'res-part' }, ({ payload }) => { if (payload.to === myId) { const m = reassemble(payload); if (m) deliver(m); } });
    ch.on('broadcast', { event: 'ev' }, ({ payload }) => deliver(payload));
    ch.on('broadcast', { event: 'ev-part' }, ({ payload }) => { const m = reassemble(payload); if (m) deliver(m); });
    let ok = false;
    ch.subscribe(async (status) => {
      if (status === 'SUBSCRIBED') {
        ok = true;
        await ch.track({ role: 'viewer' });
        mediaBase = null;
        connected({
          kind: 'relay',
          send: (m) => {
            const payload = { ...m, from: myId };
            const txt = JSON.stringify(payload);
            if (txt.length < 180000) { ch.send({ type: 'broadcast', event: 'rpc', payload }); return; }
            const cid = Math.random().toString(36).slice(2);
            const n = Math.ceil(txt.length / 180000);
            for (let i = 0; i < n; i++) ch.send({ type: 'broadcast', event: 'rpc', payload: { cid, i, n, s: txt.slice(i * 180000, (i + 1) * 180000) } });
          },
        });
        banner(null);
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        if (relayChan === ch) { relayChan = null; SB.removeChannel(ch); }
        dropTransport();
        if (ok) banner('Reconnecting to your PC...');
        setTimeout(onFail, 3000);
      }
    });
    relayChan = ch;
  }

  // ------------------------------------------------------------ media + uploads (work for both transports)
  const mediaCache = new Map();
  window.sbMediaUrl = (mxc) => {
    const [s, id] = mxc.slice(6).split('/');
    if (mediaBase) return `${mediaBase}/media/${encodeURIComponent(s)}/${encodeURIComponent(id)}?t=${encodeURIComponent(token)}`;
    if (legacyToken) return `/media/${encodeURIComponent(s)}/${encodeURIComponent(id)}?t=${encodeURIComponent(legacyToken)}`;
    return mediaCache.get(mxc) || 'sbrelay:' + mxc;
  };
  window.sbResolveMedia = async (mxc) => {
    const u = window.sbMediaUrl(mxc);
    if (!u.startsWith('sbrelay:')) return u;
    const url = await window.sb.call('relayMedia', mxc);
    mediaCache.set(mxc, url);
    return url;
  };
  // Away from home, images/videos are fetched through the relay as they appear on screen
  new MutationObserver((list) => {
    for (const m of list) {
      for (const node of m.addedNodes) {
        if (!node.querySelectorAll) continue;
        node.querySelectorAll('[src^="sbrelay:"]').forEach((el) => {
          const mxc = el.getAttribute('src').slice(8);
          el.removeAttribute('src');
          window.sbResolveMedia(mxc).then((u) => { el.src = u; }).catch(() => {});
        });
      }
    }
  }).observe(document.documentElement, { childList: true, subtree: true });

  window.sbUpload = async (file) => {
    if (mediaBase || legacyToken) {
      const base = mediaBase || '';
      const t = mediaBase ? token : legacyToken;
      const r = await fetch(base + '/upload?t=' + encodeURIComponent(t) + '&name=' + encodeURIComponent(file.name), { method: 'POST', body: file });
      if (!r.ok) throw new Error('Upload failed');
      return (await r.json()).path;
    }
    const { data: { user } } = await SB.auth.getUser();
    const key = `${user.id}/uploads/${Date.now()}-${file.name.replace(/[^\w.\-]/g, '_')}`;
    const { error } = await SB.storage.from('relay').upload(key, file, { contentType: file.type || 'application/octet-stream' });
    if (error) throw new Error('Upload failed: ' + error.message);
    return window.sb.call('relayFetchUpload', key);
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

  // ------------------------------------------------------------ older QR pairing (page served by the PC)
  const qs = new URLSearchParams(location.search);
  if (qs.get('t')) {
    localStorage.setItem('sbToken', qs.get('t'));
    history.replaceState(null, '', location.pathname + location.hash);
  }
  const legacyToken = location.protocol === 'http:' && !native ? localStorage.getItem('sbToken') : null;
  if (legacyToken) {
    window.SB_TOKEN = legacyToken;
    const ws = () => {
      const s = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws?t=' + encodeURIComponent(legacyToken) + '&device=' + encodeURIComponent(deviceName));
      s.onopen = () => connected({ kind: 'legacy', send: (m) => s.send(JSON.stringify(m)) });
      s.onmessage = (e) => { try { deliver(JSON.parse(e.data)); } catch {} };
      s.onclose = (e) => { dropTransport(); if (e.code === 4001) { banner('This phone is not paired any more.'); return; } banner('Reconnecting to your PC...'); setTimeout(ws, 2500); };
    };
    ws();
    return;
  }

  // ------------------------------------------------------------ Switchboard account
  if (!window.supabase) { banner('Switchboard could not load its sign-in module.'); return; }
  SB = window.supabase.createClient(CFG.url, CFG.key, { auth: { persistSession: true, autoRefreshToken: true, storageKey: 'sb-switchboard', detectSessionInUrl: false } });
  window.sbAccount = {
    client: SB,
    async email() { const { data } = await SB.auth.getUser(); return data.user ? data.user.email : null; },
    async signOut() {
      try { const id = localStorage.getItem('sbPhoneDevice'); if (id) await SB.from('devices').delete().eq('id', id); } catch {}
      localStorage.removeItem('sbPhoneDevice');
      await SB.auth.signOut();
      if (android && android.clearSession) android.clearSession();
      location.reload();
    },
    async devices() {
      const [{ data: devs }, { data: hs }] = await Promise.all([SB.from('devices').select('*').order('priority'), SB.from('host_state').select('*').maybeSingle()]);
      const now = Date.now();
      return (devs || []).map((d) => ({ ...d, online: now - new Date(d.last_seen).getTime() < 75000, host: !!(hs && hs.host_device === d.id && new Date(hs.lease_until).getTime() > now), me: d.id === localStorage.getItem('sbPhoneDevice') }));
    },
  };

  SB.auth.onAuthStateChange((ev, session) => {
    if (session) {
      token = session.access_token;
      if (android && android.saveSession) android.saveSession(JSON.stringify({ access_token: session.access_token, refresh_token: session.refresh_token, expires_at: session.expires_at, user_id: session.user.id, url: CFG.url, key: CFG.key }));
    }
  });

  function showLogin(message) {
    const o = overlay(`<h2>Sign in to Switchboard</h2>
      <p class="sbo-sub">${message || 'Use your Switchboard account. Your chats come from the PC that runs your accounts.'}</p>
      <input id="sboEmail" type="email" placeholder="Email" autocomplete="username">
      <input id="sboPass" type="password" placeholder="Password" autocomplete="current-password">
      <button id="sboGo" class="primary">Sign in</button>
      <p class="sbo-err" id="sboErr"></p>`);
    const go = async () => {
      const email = o.querySelector('#sboEmail').value.trim();
      const password = o.querySelector('#sboPass').value;
      o.querySelector('#sboErr').textContent = '';
      o.querySelector('#sboGo').disabled = true;
      const { error } = await SB.auth.signInWithPassword({ email, password });
      o.querySelector('#sboGo').disabled = false;
      if (error) { o.querySelector('#sboErr').textContent = error.message === 'Invalid login credentials' ? 'Wrong email or password. Create your account first in Switchboard on your PC (Settings → Account).' : error.message; return; }
      overlay(null);
      start();
    };
    o.querySelector('#sboGo').onclick = go;
    o.querySelector('#sboPass').onkeydown = (e) => { if (e.key === 'Enter') go(); };
  }

  async function registerPhone() {
    if (native) return;
    let id = localStorage.getItem('sbPhoneDevice');
    try {
      if (id) {
        const { data } = await SB.from('devices').update({ last_seen: new Date().toISOString() }).eq('id', id).select('id');
        if (data && data.length) return;
      }
      const { data } = await SB.from('devices').insert({ name: deviceName, kind: 'phone', priority: 1000 }).select().single();
      if (data) localStorage.setItem('sbPhoneDevice', data.id);
    } catch {}
  }

  async function ping(base) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2000);
    try {
      const r = await fetch(base + '/ping?t=' + encodeURIComponent(token), { signal: ctrl.signal, cache: 'no-store' });
      const j = await r.json();
      return j.app === 'switchboard' && j.paired;
    } catch { return false; } finally { clearTimeout(t); }
  }

  let starting = false;
  async function start() {
    if (starting) return;
    starting = true;
    try {
      let { data: { session } } = await SB.auth.getSession();
      if (!session && native) {
        const s = await native.call('viewerSession').catch(() => null);
        if (s) { await SB.auth.setSession(s); session = (await SB.auth.getSession()).data.session; }
      }
      if (!session) { whenReady(() => showLogin()); return; }
      token = session.access_token;
      registerPhone();
      const [{ data: hs }, { data: devs }] = await Promise.all([SB.from('host_state').select('*').maybeSingle(), SB.from('devices').select('*')]);
      const host = hs && (devs || []).find((d) => d.id === hs.host_device);
      const alive = host && hs.lease_until && new Date(hs.lease_until).getTime() > Date.now();
      if (!alive) {
        whenReady(() => overlay(`<h2>Your PC is offline</h2><p class="sbo-sub">None of your PCs is running Switchboard right now. Turn one on and this will connect by itself.</p><div class="spin"></div>`));
        setTimeout(() => { starting = false; start(); }, 10000);
        return;
      }
      banner(`Connecting to ${host.name}...`);
      for (const base of host.addresses || []) {
        if (await ping(base)) {
          connectDirect(base, () => { starting = false; start(); });
          return;
        }
      }
      connectRelay(session.user.id, () => { starting = false; start(); });
    } catch (e) {
      banner('Could not reach Switchboard online. Retrying...');
      setTimeout(() => { starting = false; start(); }, 8000);
      return;
    }
    starting = false;
  }

  if (native && native.mode === 'deciding') {
    whenReady(() => overlay('<h2>Starting Switchboard</h2><p class="sbo-sub">Checking which of your PCs should run your accounts...</p><div class="spin"></div>'));
    return;
  }
  whenReady(() => start());
})();
