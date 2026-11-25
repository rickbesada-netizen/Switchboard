const U = require('./util');

const NETWORKS = {
  whatsapp: { label: 'WhatsApp', short: 'wa', color: '#25D366', imageKey: 'whatsapp', login: 'qr' },
  messenger: { label: 'Facebook / Messenger', short: 'fb', color: '#0084FF', imageKey: 'messenger', login: 'cookies', flow: 'facebook', cookieSite: 'https://www.facebook.com', loginUrl: 'https://www.facebook.com/login', loginCookie: 'c_user' },
  instagram: { label: 'Instagram', short: 'ig', color: '#E1306C', imageKey: 'instagram', login: 'cookies', flow: 'instagram', cookieSite: 'https://www.instagram.com', loginUrl: 'https://www.instagram.com/accounts/login/', loginCookie: 'sessionid' },
};

const DEFAULTS = {
  setupDone: false,
  settings: {
    ghostRead: true,
    hideTyping: true,
    keepDeleted: true,
    notifications: true,
    muteHidden: true,
    messengerEncryptedHistory: true,
    hiddenPinHash: null,
    minimizeToTray: true,
    tricksterEnabled: false,
    tricksterApi: 'http://127.0.0.1:53200',
    closeTricksterAfter: true,
    serverName: 'switchboard.local',
    backfillMessages: 200,
  },
  matrix: { user: 'me', password: null, token: null, deviceId: null, since: null },
  accounts: [],
  counters: {},
  tags: [
    { id: 'personal', name: 'Personal', color: '#38bdf8' },
    { id: 'business', name: 'Business', color: '#34d399' },
    { id: 'church', name: 'Church', color: '#fbbf24' },
    { id: 'urgent', name: 'Urgent', color: '#ff5c7c' },
  ],
  quickReplies: [
    { id: 'thanks', shortcut: 'thanks', text: 'Thanks for your message! I will get back to you shortly.' },
    { id: 'rates', shortcut: 'rates', text: 'Happy to help. Could you send me a few details about what you need and I will send through pricing.' },
  ],
  autoReplies: [],
  schedule: [],
};

function merge(def, val) {
  if (Array.isArray(def)) return Array.isArray(val) ? val : def;
  if (def && typeof def === 'object') {
    const out = {};
    for (const k of Object.keys(def)) out[k] = merge(def[k], val ? val[k] : undefined);
    if (val && typeof val === 'object') for (const k of Object.keys(val)) if (!(k in out)) out[k] = val[k];
    return out;
  }
  return val === undefined ? def : val;
}

class Config {
  constructor() {
    this.file = U.p('config.json');
    const raw = U.readJSON(this.file, {});
    Object.assign(this, merge(JSON.parse(JSON.stringify(DEFAULTS)), raw));
    if (!this.matrix.password) this.matrix.password = U.rand(28);
    this._t = null;
  }
  data() {
    const { file, _t, ...rest } = this;
    return rest;
  }
  save(now = false) {
    clearTimeout(this._t);
    const doIt = () => U.writeJSON(this.file, this.data());
    if (now) doIt();
    else this._t = setTimeout(doIt, 400);
  }
  get mxid() {
    return `@${this.matrix.user}:${this.settings.serverName}`;
  }
  account(id) {
    return this.accounts.find((a) => a.id === id);
  }
  newAccountId(network) {
    const s = NETWORKS[network].short;
    this.counters[s] = (this.counters[s] || 0) + 1;
    return s + this.counters[s];
  }
}

module.exports = { Config, NETWORKS };
