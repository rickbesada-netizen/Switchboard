// Helpers for cookie-based logins (Messenger / Instagram).

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

module.exports = { parseCookieText, fillCookieFields };
