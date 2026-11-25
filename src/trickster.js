// Trickster integration through its local automation API (ixBrowser-style, port 53200 by default).
// Used to pull an account's login cookies from its Trickster profile and to post to Instagram
// from that profile, so every account keeps its own fingerprint and proxy.
const { chromium } = require('playwright-core');

async function call(cfg, p, body) {
  const base = (cfg.settings.tricksterApi || 'http://127.0.0.1:53200').replace(/\/$/, '');
  let r;
  try {
    r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  } catch {
    throw new Error('Could not reach Trickster. Open Trickster first (its local API must be on ' + base + ').');
  }
  const j = await r.json().catch(() => ({}));
  if (j && j.error && j.error.code && j.error.code !== 0) {
    const e = new Error(j.error.message || 'Trickster error ' + j.error.code);
    e.code = j.error.code;
    throw e;
  }
  return j && j.data !== undefined ? j.data : j;
}

async function listProfiles(cfg) {
  const d = await call(cfg, '/api/v2/profile-list', { profile_id: 0, name: '', group_id: 0, tag_id: 0, page: 1, limit: 1000 });
  const arr = Array.isArray(d) ? d : d.data || d.list || d.profiles || [];
  return arr.map((p) => ({ id: p.profile_id ?? p.id, name: p.name || p.profile_name || `Profile ${p.profile_id ?? p.id}`, proxy: p.proxy_ip || p.proxy || '' }));
}

function cdpFrom(d) {
  if (!d) return null;
  if (d.ws) return d.ws;
  if (d.debugging_address) return 'http://' + d.debugging_address.replace(/^https?:\/\//, '');
  if (d.webSocketDebuggerUrl) return d.webSocketDebuggerUrl;
  return null;
}

async function openProfile(cfg, id) {
  try {
    const d = await call(cfg, '/api/v2/profile-open', { profile_id: Number(id), args: [], load_extensions: true, load_profile_info_page: false, cookies_backup: true });
    const cdp = cdpFrom(d);
    if (!cdp) throw new Error('Trickster did not return a debugging address for this profile.');
    return { cdp, openedNow: true };
  } catch (e) {
    // Already open? Look it up in the opened list
    try {
      const list = await call(cfg, '/api/v2/profile-opened-list', {});
      const arr = Array.isArray(list) ? list : list.data || [];
      const hit = arr.find((p) => String(p.profile_id ?? p.id) === String(id));
      const cdp = cdpFrom(hit);
      if (cdp) return { cdp, openedNow: false };
    } catch {}
    throw e;
  }
}

async function closeProfile(cfg, id) {
  return call(cfg, '/api/v2/profile-close', { profile_id: Number(id) });
}

async function connect(cfg, id) {
  const { cdp, openedNow } = await openProfile(cfg, id);
  let browser;
  for (let i = 0; i < 10; i++) {
    try { browser = await chromium.connectOverCDP(cdp, { timeout: 15000 }); break; } catch (e) {
      if (i === 9) throw e;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  const context = browser.contexts()[0] || (await browser.newContext());
  return { browser, context, openedNow };
}

async function getCookies(cfg, id) {
  const { browser, context, openedNow } = await connect(cfg, id);
  try {
    return await context.cookies();
  } finally {
    if (openedNow && cfg.settings.closeTricksterAfter) {
      await closeProfile(cfg, id).catch(() => {});
      await browser.close().catch(() => {});
    }
  }
}

module.exports = { listProfiles, openProfile, closeProfile, connect, getCookies };
