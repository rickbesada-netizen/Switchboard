// Talks to each mautrix bridge's provisioning API (bridgev2) to log accounts in and check status.
const U = require('./util');

class BridgeAPI {
  constructor(acc, cfg) {
    this.acc = acc;
    this.cfg = cfg;
    this.base = `http://127.0.0.1:${acc.port}/_matrix/provision/v3`;
  }
  async call(method, p, body, timeout = 60000) {
    const url = new URL(this.base + p);
    url.searchParams.set('user_id', this.cfg.mxid);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeout);
    try {
      const r = await fetch(url, {
        method,
        headers: { Authorization: 'Bearer ' + this.acc.secret, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || j.message || `Bridge error ${r.status}`);
      return j;
    } finally {
      clearTimeout(t);
    }
  }
  whoami() { return this.call('GET', '/whoami'); }
  flows() { return this.call('GET', '/login/flows'); }
  start(flowId) { return this.call('POST', `/login/start/${encodeURIComponent(flowId)}`, {}); }
  step(loginId, stepId, type, body, timeout) {
    return this.call('POST', `/login/step/${encodeURIComponent(loginId)}/${encodeURIComponent(stepId)}/${type}`, body || {}, timeout);
  }
  logout(loginId) { return this.call('POST', `/logout/${encodeURIComponent(loginId)}`, {}); }

  async waitReady(timeoutMs = 120000) {
    const end = Date.now() + timeoutMs;
    let last;
    while (Date.now() < end) {
      try { return await this.whoami(); } catch (e) { last = e; }
      await U.sleep(2000);
    }
    throw new Error('The bridge did not come online in time (' + (last && last.message) + '). Check its log in Accounts.');
  }
}

// Parse pasted cookies: JSON array export, JSON object, or "a=b; c=d" header text
function parseCookieText(text, defaultDomain) {
  const t = String(text || '').trim();
  if (!t) return [];
  try {
    const j = JSON.parse(t);
    const arr = Array.isArray(j) ? j : Object.entries(j).map(([name, value]) => ({ name, value }));
    return arr.filter((c) => c && c.name).map((c) => ({ name: c.name, value: String(c.value), domain: c.domain || defaultDomain, path: c.path || '/' }));
  } catch {}
  return t.split(/;\s*|\n/).map((s) => s.trim()).filter((s) => s.includes('=')).map((s) => {
    const i = s.indexOf('=');
    return { name: s.slice(0, i).trim(), value: s.slice(i + 1).trim(), domain: defaultDomain, path: '/' };
  });
}

// Build the bridge's cookie-step answer from a list of browser cookies
function fillCookieFields(step, cookies) {
  const fields = (step && step.fields) || [];
  const body = {};
  const missing = [];
  for (const f of fields) {
    const srcs = (f.sources || []).filter((s) => s.type === 'cookie' || !s.type);
    let val;
    for (const s of srcs) {
      const dom = String(s.cookie_domain || '').replace(/^\./, '');
      const hit = cookies.find((c) => c.name === s.name && (!dom || String(c.domain || '').replace(/^\./, '').endsWith(dom))) || cookies.find((c) => c.name === s.name);
      if (hit) { val = hit.value; break; }
    }
    if (!val && !srcs.length) {
      const hit = cookies.find((c) => c.name === f.id);
      if (hit) val = hit.value;
    }
    if (val) body[f.id] = val;
    else if (f.required !== false) missing.push((srcs[0] && srcs[0].name) || f.id);
  }
  return { body, missing };
}

module.exports = { BridgeAPI, parseCookieText, fillCookieFields };
