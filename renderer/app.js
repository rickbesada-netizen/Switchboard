/* Switchboard renderer (desktop window, and phones via the PC's phone access) */
const REMOTE = !!window.SB_REMOTE;
const S = {
  st: null,
  view: 'inbox',
  panel: null,
  filter: { network: null, accountId: null, tag: null, chip: 'all', q: '' },
  rooms: new Map(),
  current: null,
  msgs: [],
  replyTo: null,
  editing: null,
  logs: [],
  igLog: [],
  stack: { status: 'stopped' },
  drawer: false,
  searchHits: [],
  igFiles: [],
  qrIndex: 0,
};
const $ = (s) => document.querySelector(s);
const call = (...a) => window.sb.call(...a);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const NETS = () => (S.st ? S.st.networks : {});
const netLabel = (n) => (NETS()[n] || {}).label || n || '';

function mxc(u, thumb) {
  if (!u || !String(u).startsWith('mxc://')) return null;
  const [s, id] = u.slice(6).split('/');
  if (REMOTE) return window.sbMediaUrl ? window.sbMediaUrl(u, thumb) : `/media/${encodeURIComponent(s)}/${encodeURIComponent(id)}?t=${encodeURIComponent(window.SB_TOKEN)}`;
  return `sbmedia://media/${encodeURIComponent(s)}/${encodeURIComponent(id)}${thumb ? '?thumb=1' : ''}`;
}
function linkify(t) {
  return esc(t).replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"])/g, '<a href="$1" target="_blank">$1</a>');
}
function initials(n) {
  const p = String(n || '?').replace(/[^\p{L}\p{N}\s]/gu, ' ').trim().split(/\s+/).filter(Boolean);
  if (!p.length) return '?';
  return ((p[0] || '?')[0] + (p[1] ? p[1][0] : '')).toUpperCase();
}
function hue(s) {
  let h = 0;
  for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}
function avatarHtml(name, url, net, size = 44) {
  const img = url ? `<img src="${mxc(url, true)}" alt="">` : esc(initials(name));
  const badge = net ? `<span class="badge net-${net}"></span>` : '';
  return `<div class="avatar" style="width:${size}px;height:${size}px;background:hsl(${hue(name)},45%,32%);font-size:${Math.round(size / 2.8)}px">${img}${badge}</div>`;
}
function timeShort(ts) {
  if (!ts) return '';
  const d = new Date(ts); const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  if (now - d < 6 * 864e5) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
}
function toast(t, err) {
  const el = $('#toast');
  el.textContent = t;
  el.className = err ? 'err' : '';
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), err ? 6000 : 2600);
}
function modal(html) {
  $('#modalCard').innerHTML = html;
  $('#modal').classList.remove('hidden');
}
function closeModal() {
  $('#modal').classList.add('hidden');
  $('#modalCard').innerHTML = '';
}
function tagById(id) {
  return (S.st.tags || []).find((t) => t.id === id);
}
function account(id) {
  return (S.st.accounts || []).find((a) => a.id === id);
}

// ------------------------------------------------------------------ rail
function renderRail() {
  const rooms = [...S.rooms.values()].filter((r) => !r.archived && !r.stash);
  const cnt = (f) => rooms.filter(f).reduce((n, r) => n + (r.unread ? 1 : 0), 0);
  const items = [
    { k: 'inbox', ico: '💬', lbl: 'All chats', c: cnt(() => true) },
    ...Object.entries(NETS()).map(([id, n]) => ({ k: 'net:' + id, ico: `<span class="netdot net-${id}"></span>`, lbl: n.label, c: cnt((r) => r.network === id) })),
    { k: 'post', ico: '📸', lbl: 'Post' },
    { k: 'scheduled', ico: '⏱', lbl: 'Scheduled', c: (S.st.schedule || []).filter((s) => s.status === 'pending').length },
    { k: 'automation', ico: '⚡', lbl: 'Automation' },
    { k: 'accounts', ico: '🔗', lbl: 'Accounts' },
    { k: 'settings', ico: '⚙', lbl: 'Settings' },
  ];
  const cur = railKey();
  $('#railMain').innerHTML = items.map((i) => `<button class="rail-item ${cur === i.k ? 'on' : ''}" data-k="${i.k}"><span class="ico">${i.ico}</span><span class="lbl">${esc(i.lbl)}</span>${i.c ? `<span class="cnt">${i.c}</span>` : ''}</button>`).join('');
  $('#railAccounts').innerHTML = (S.st.accounts || []).map((a) => {
    const c = cnt((r) => r.accountId === a.id);
    return `<button class="rail-item ${cur === 'acc:' + a.id ? 'on' : ''}" data-k="acc:${a.id}"><span class="ico"><span class="netdot net-${a.network}"></span></span><span class="lbl">${esc(a.label)}</span>${c ? `<span class="cnt">${c}</span>` : ''}</button>`;
  }).join('') || '<div class="small" style="padding:4px 10px">None yet</div>';
  const hiddenUnread = [...S.rooms.values()].filter((r) => r.stash && r.unread).length;
  $('#railTags').innerHTML = (S.st.tags || []).map((t) => {
    const c = cnt((r) => (r.tags || []).includes(t.id));
    return `<button class="rail-item ${cur === 'tag:' + t.id ? 'on' : ''}" data-k="tag:${t.id}" data-drop="${t.id}"><span class="ico"><span class="netdot" style="background:${esc(t.color)}"></span></span><span class="lbl">${esc(t.name)}</span>${c ? `<span class="cnt">${c}</span>` : ''}</button>`;
  }).join('') + `<button class="rail-item ${cur === 'tag:__none' ? 'on' : ''}" data-k="tag:__none"><span class="ico">○</span><span class="lbl">No folder</span>${cnt((r) => !(r.tags || []).length) ? `<span class="cnt">${cnt((r) => !(r.tags || []).length)}</span>` : ''}</button>`
    + `<button class="rail-item ${cur === 'tag:__hidden' ? 'on' : ''}" data-k="tag:__hidden" data-drop="__hidden"><span class="ico">🔒</span><span class="lbl">Hidden</span>${hiddenUnread && S.hiddenUnlocked ? `<span class="cnt">${hiddenUnread}</span>` : ''}</button>`;
  const st = S.stack.status;
  const accs = S.st.accounts || [];
  const bad = accs.filter((a) => a.status && a.status.logins && a.status.logins.some((l) => /BAD_CREDENTIALS|UNKNOWN_ERROR/.test(l.state))).length;
  const txt = st !== 'running' ? 'Starting...' : bad ? `${bad} account${bad > 1 ? 's' : ''} need attention` : accs.length ? 'All accounts running' : 'Ready';
  const e = $('#engineStatus');
  e.className = 'engine ' + (st === 'running' && bad ? 'error' : st);
  e.querySelector('.txt').textContent = txt;
}
function railKey() {
  if (S.view !== 'inbox') return S.view;
  const f = S.filter;
  if (f.network) return 'net:' + f.network;
  if (f.accountId) return 'acc:' + f.accountId;
  if (f.tag) return 'tag:' + f.tag;
  return 'inbox';
}
$('#rail').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-k]');
  if (b) {
    const k = b.dataset.k;
    if (k === 'tag:__hidden' && !(await unlockHidden())) return;
    if (k === 'inbox' || k.includes(':')) {
      S.filter.network = S.filter.accountId = S.filter.tag = null;
      S.filter.subNet = S.filter.subTag = null;
      if (k.startsWith('net:')) S.filter.network = k.slice(4);
      if (k.startsWith('acc:')) S.filter.accountId = k.slice(4);
      if (k.startsWith('tag:')) S.filter.tag = k.slice(4);
      showView('inbox');
    } else showView(k);
  }
  if (e.target.closest('#engineStatus')) showView('engine');
});

async function unlockHidden() {
  if (S.hiddenUnlocked || !S.st.settings.hiddenPinSet) { S.hiddenUnlocked = true; return true; }
  return new Promise((resolve) => {
    modal(`<h2>Hidden chats</h2><p class="small">Enter your passcode to open hidden chats.</p><input id="hPin" type="password" inputmode="numeric" style="width:100%" autofocus>
      <div class="modal-foot"><button class="ghost-btn" id="hCancel">Cancel</button><button class="primary" id="hOk">Open</button></div>`);
    const go = async () => {
      if (await call('checkHiddenPin', $('#hPin').value)) { S.hiddenUnlocked = true; closeModal(); resolve(true); }
      else { toast('Wrong passcode', true); $('#hPin').value = ''; }
    };
    $('#hOk').onclick = go;
    $('#hPin').onkeydown = (ev) => { if (ev.key === 'Enter') go(); };
    $('#hCancel').onclick = () => { closeModal(); resolve(false); };
    setTimeout(() => $('#hPin') && $('#hPin').focus(), 50);
  });
}
async function addToFolder(roomId, folder) {
  const r = S.rooms.get(roomId);
  if (!r) return;
  if (folder === '__hidden') { await call('roomSettings', roomId, { stash: true }); toast('Chat hidden'); return; }
  if ((r.tags || []).includes(folder)) return;
  await call('roomSettings', roomId, { tags: [...(r.tags || []), folder] });
  toast('Added to ' + ((tagById(folder) || {}).name || 'folder'));
}
$('#rail').addEventListener('dragover', (e) => { const t = e.target.closest('[data-drop]'); if (t) { e.preventDefault(); t.classList.add('on'); } });
$('#rail').addEventListener('dragleave', (e) => { const t = e.target.closest('[data-drop]'); if (t && railKey() !== t.dataset.k) t.classList.remove('on'); });
$('#rail').addEventListener('drop', (e) => {
  const t = e.target.closest('[data-drop]');
  if (!t) return;
  e.preventDefault();
  const id = e.dataTransfer.getData('text/room');
  if (id) addToFolder(id, t.dataset.drop).then(renderRail);
});

$('#menuBtn').addEventListener('click', () => document.body.classList.toggle('menu-open'));
$('#menuShade').addEventListener('click', () => document.body.classList.remove('menu-open'));
function showView(v) {
  S.view = v;
  document.body.classList.remove('menu-open');
  if (v !== 'inbox') document.body.classList.remove('chat-open');
  if (v === 'settings') { S.remoteFetched = false; S.cloud = null; }
  const titles = { inbox: 'Chats', post: 'Post', scheduled: 'Scheduled', automation: 'Automation', accounts: 'Accounts', settings: 'Settings', engine: 'Engine' };
  if ($('#mobileTitle')) $('#mobileTitle').textContent = titles[v] || 'Switchboard';
  $('#inboxView').classList.toggle('hidden', v !== 'inbox');
  $('#panelView').classList.toggle('hidden', v === 'inbox');
  if (v === 'inbox') renderRooms();
  else renderPanel();
  renderRail();
}

// ------------------------------------------------------------------ room list
function visibleRooms() {
  const f = S.filter;
  const q = f.q.trim().toLowerCase();
  return [...S.rooms.values()].filter((r) => {
    if (f.tag === '__hidden' ? !r.stash : r.stash) return false;
    if (f.chip === 'archived' ? !r.archived : r.archived) return false;
    if (f.chip === 'unread' && !r.unread) return false;
    if (f.chip === 'pinned' && !r.pinned) return false;
    if (f.network && r.network !== f.network) return false;
    if (f.accountId && r.accountId !== f.accountId) return false;
    if (f.tag === '__none' && (r.tags || []).length) return false;
    if (f.tag && f.tag !== '__none' && f.tag !== '__hidden' && !(r.tags || []).includes(f.tag)) return false;
    if (f.subNet && r.network !== f.subNet) return false;
    if (f.subTag === '__none' && (r.tags || []).length) return false;
    if (f.subTag && f.subTag !== '__none' && !(r.tags || []).includes(f.subTag)) return false;
    if (q && !(r.name.toLowerCase().includes(q) || (r.lastPreview || '').toLowerCase().includes(q) || (r.note || '').toLowerCase().includes(q))) return false;
    return true;
  }).sort((a, b) => (b.pinned - a.pinned) || (b.lastTs - a.lastTs));
}
function renderSubChips() {
  const f = S.filter;
  const el = $('#subChips');
  let chips = [];
  if (f.tag) {
    // inside a folder: split by app
    const nets = [...new Set([...S.rooms.values()].map((r) => r.network).filter(Boolean))];
    if (nets.length > 1) chips = [['net', '', 'All apps'], ...nets.map((n) => ['net', n, netLabel(n)])];
  } else if ((S.st.tags || []).length) {
    // inside an app / account / everything: split by folder
    chips = [['tag', '', 'All folders'], ...(S.st.tags || []).map((t) => ['tag', t.id, t.name]), ['tag', '__none', 'No folder']];
  }
  if (!chips.length) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  el.innerHTML = chips.map(([kind, v, label]) => {
    const on = kind === 'net' ? (f.subNet || '') === v : (f.subTag || '') === v;
    return `<button class="chip sub ${on ? 'on' : ''}" data-sub="${kind}" data-v="${esc(v)}">${esc(label)}</button>`;
  }).join('');
}
let roomsRaf = 0;
function renderRooms() {
  cancelAnimationFrame(roomsRaf);
  roomsRaf = requestAnimationFrame(() => {
    renderSubChips();
    const list = visibleRooms();
    let html = list.map((r) => {
      const acc = account(r.accountId);
      const tags = (r.tags || []).map(tagById).filter(Boolean).map((t) => `<span class="tagpill" style="background:${esc(t.color)}">${esc(t.name)}</span>`).join('');
      const prev = r.typing && r.typing.length ? `<span class="prev typing">typing...</span>` : `<span class="prev">${esc(r.lastPreview)}</span>`;
      return `<div class="room ${r.id === S.current ? 'on' : ''} ${r.unread ? 'has-unread' : ''}" data-room="${esc(r.id)}" draggable="true">
        ${avatarHtml(r.name, r.avatar, r.network)}
        <div class="meta">
          <div class="top"><span class="name">${r.pinned ? '<span class="pin">📌</span> ' : ''}${esc(r.name)}</span><span class="time">${timeShort(r.lastTs)}</span></div>
          <div class="bottom">${prev}${r.unread ? `<span class="unread">${r.unread}</span>` : ''}</div>
          <div class="bottom"><span class="acct">${esc(acc ? acc.label : '')}</span>${tags}</div>
        </div></div>`;
    }).join('');
    if (!list.length) {
      const noAcc = !(S.st.accounts || []).length;
      html = `<div class="empty" style="padding:40px 20px"><div><p>${noAcc ? 'No accounts connected yet.' : 'No chats here.'}</p>${noAcc ? '<button class="primary" data-goto="accounts">Connect an account</button>' : ''}</div></div>`;
    }
    if (S.searchHits.length) {
      html += `<div class="rail-sep" style="padding:12px">Messages</div>` + S.searchHits.map((h) => `<div class="room" data-room="${esc(h.roomId)}" data-jump="${esc(h.id)}"><div class="meta"><div class="top"><span class="name">${esc(h.roomName)}</span><span class="time">${timeShort(h.ts)}</span></div><div class="bottom"><span class="prev">${esc(h.senderName)}: ${esc(h.body)}</span></div></div></div>`).join('');
    }
    $('#rooms').innerHTML = html;
  });
}
$('#rooms').addEventListener('click', (e) => {
  const g = e.target.closest('[data-goto]');
  if (g) return showView(g.dataset.goto);
  const r = e.target.closest('[data-room]');
  if (r) openRoom(r.dataset.room, r.dataset.jump);
});
$('#rooms').addEventListener('dragstart', (e) => {
  const r = e.target.closest('[data-room]');
  if (r) { e.dataTransfer.setData('text/room', r.dataset.room); e.dataTransfer.effectAllowed = 'copy'; }
});
// Right-click menu: folders, pin, archive, hide
$('#rooms').addEventListener('contextmenu', (e) => {
  const el = e.target.closest('[data-room]');
  if (!el) return;
  e.preventDefault();
  const room = S.rooms.get(el.dataset.room);
  if (!room) return;
  const menu = $('#ctxMenu');
  menu.innerHTML = `<div class="ctx-title">Folders</div>
    ${(S.st.tags || []).map((t) => `<label class="ctx-item"><input type="checkbox" data-ctxtag="${esc(t.id)}" ${(room.tags || []).includes(t.id) ? 'checked' : ''}><span class="netdot" style="background:${esc(t.color)}"></span>${esc(t.name)}</label>`).join('')}
    <div class="ctx-sep"></div>
    <div class="ctx-item" data-ctx="pin">${room.pinned ? 'Unpin' : 'Pin'}</div>
    <div class="ctx-item" data-ctx="archive">${room.archived ? 'Unarchive' : 'Archive'}</div>
    <div class="ctx-item" data-ctx="unread">Mark unread</div>
    <div class="ctx-item" data-ctx="stash">${room.stash ? 'Unhide' : 'Hide chat 🔒'}</div>`;
  menu.dataset.room = room.id;
  menu.classList.remove('hidden');
  const x = Math.min(e.clientX, window.innerWidth - 230), y = Math.min(e.clientY, window.innerHeight - menu.offsetHeight - 10);
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
});
document.addEventListener('click', (e) => { if (!e.target.closest('#ctxMenu')) $('#ctxMenu').classList.add('hidden'); });
$('#ctxMenu').addEventListener('change', async (e) => {
  const id = $('#ctxMenu').dataset.room;
  const room = S.rooms.get(id);
  const t = e.target.dataset.ctxtag;
  if (!room || !t) return;
  const tags = e.target.checked ? [...new Set([...(room.tags || []), t])] : (room.tags || []).filter((x) => x !== t);
  await call('roomSettings', id, { tags });
});
$('#ctxMenu').addEventListener('click', async (e) => {
  const a = e.target.closest('[data-ctx]');
  if (!a) return;
  const id = $('#ctxMenu').dataset.room;
  const room = S.rooms.get(id);
  $('#ctxMenu').classList.add('hidden');
  if (!room) return;
  if (a.dataset.ctx === 'pin') await call('roomSettings', id, { pinned: !room.pinned });
  if (a.dataset.ctx === 'archive') await call('roomSettings', id, { archived: !room.archived });
  if (a.dataset.ctx === 'unread') await call('markUnread', id);
  if (a.dataset.ctx === 'stash') { await call('roomSettings', id, { stash: !room.stash }); toast(room.stash ? 'Chat moved back to the inbox' : 'Chat hidden. Find it under Folders → Hidden'); }
});
$('#subChips').addEventListener('click', (e) => {
  const b = e.target.closest('[data-sub]');
  if (!b) return;
  if (b.dataset.sub === 'net') S.filter.subNet = b.dataset.v || null;
  else S.filter.subTag = b.dataset.v || null;
  renderRooms();
});
$('#filterChips').addEventListener('click', (e) => {
  const b = e.target.closest('[data-f]');
  if (!b) return;
  S.filter.chip = b.dataset.f;
  document.querySelectorAll('#filterChips .chip').forEach((c) => c.classList.toggle('on', c === b));
  renderRooms();
});
let searchT;
$('#search').addEventListener('input', (e) => {
  S.filter.q = e.target.value;
  renderRooms();
  clearTimeout(searchT);
  searchT = setTimeout(async () => {
    const q = S.filter.q.trim();
    S.searchHits = q.length >= 3 ? await call('search', q).catch(() => []) : [];
    renderRooms();
  }, 350);
});

// ------------------------------------------------------------------ chat
function closeChatMobile() {
  document.body.classList.remove('chat-open');
  S.drawer = false;
  renderDrawer();
  call('focusRoom', null).catch(() => {});
  S.current = null;
  renderRooms();
}
async function openRoom(id, jumpTo) {
  if (S.view !== 'inbox') showView('inbox');
  S.current = id;
  document.body.classList.add('chat-open');
  S.replyTo = null;
  S.editing = null;
  renderReply();
  $('#chatEmpty').classList.add('hidden');
  $('#chatBox').classList.remove('hidden');
  renderHead();
  renderDrawer();
  renderRooms();
  call('focusRoom', id);
  S.msgs = await call('messages', id);
  renderMessages(true);
  if (jumpTo) jump(jumpTo);
  $('#input').focus();
}
function curRoom() {
  return S.rooms.get(S.current);
}
function renderHead() {
  const r = curRoom();
  if (!r) return;
  const acc = account(r.accountId);
  $('#chatHead').innerHTML = `<button class="icon-btn mobile-only" id="backBtn">←</button>${avatarHtml(r.name, r.avatar, r.network, 38)}
    <div class="title"><b>${esc(r.name)}</b><span>${esc(netLabel(r.network))}${acc ? ' · ' + esc(acc.label) : ''}${r.isGroup ? ' · group' : ''}</span></div>
    <button class="toggle ${r.ghostEffective ? 'on' : ''}" id="ghostTgl" title="Ghost read: read without sending 'Seen'">👻<span class="tl"> Ghost ${r.ghostEffective ? 'on' : 'off'}</span></button>
    <button class="toggle ${r.hideTypingEffective ? 'on' : ''}" id="typTgl" title="Hide that you're typing">⌨<span class="tl"> ${r.hideTypingEffective ? 'Typing hidden' : 'Typing shown'}</span></button>
    <button class="icon-btn" id="drawerBtn" title="Chat info">ⓘ</button>`;
}
$('#chatHead').addEventListener('click', async (e) => {
  const r = curRoom();
  if (!r) return;
  if (e.target.closest('#ghostTgl')) {
    await call('roomSettings', r.id, { ghost: !r.ghostEffective });
    toast(!r.ghostEffective ? 'Ghost read on for this chat' : 'Ghost read off: they will see when you read');
  }
  if (e.target.closest('#typTgl')) await call('roomSettings', r.id, { hideTyping: !r.hideTypingEffective });
  if (e.target.closest('#drawerBtn')) { S.drawer = !S.drawer; renderDrawer(); }
  if (e.target.closest('#backBtn')) closeChatMobile();
});

function mediaHtml(m) {
  const full = mxc(m.url);
  const thumb = mxc(m.url, true);
  if (!full) return linkify(m.body);
  const cap = m.body && m.body !== m.filename && !/\.[a-z0-9]{2,5}$/i.test(m.body) ? `<div class="body" style="margin-top:6px">${linkify(m.body)}</div>` : '';
  if (m.type === 'm.image') return `<img class="media" src="${thumb}" data-full="${full}" alt="">${cap}`;
  if (m.type === 'm.video') return `<video class="media" controls preload="metadata" src="${full}"></video>${cap}`;
  if (m.type === 'm.audio') return `<audio controls preload="none" src="${full}"></audio>`;
  return `<div class="file" data-save="${esc(m.url)}" data-name="${esc(m.filename || m.body)}">📄 ${esc(m.filename || m.body || 'File')}</div>${cap}`;
}
function msgHtml(m, prev, r) {
  const showWho = !m.mine && r && r.isGroup && (!prev || prev.sender !== m.sender || m.ts - prev.ts > 300000);
  let body;
  if (m.lost) body = '<i class="small">Deleted before Switchboard saw it</i>';
  else if (['m.image', 'm.video', 'm.audio', 'm.file'].includes(m.type)) body = mediaHtml(m);
  else if (m.type === 'm.emote') body = `<i>* ${esc(m.senderName)} ${linkify(m.body)}</i>`;
  else body = `<span class="body">${linkify(m.body)}</span>`;
  let quote = '';
  if (m.replyTo) {
    const q = S.msgs.find((x) => x.id === m.replyTo);
    quote = `<div class="quote" data-jump="${esc(m.replyTo)}">${q ? `<b>${esc(q.senderName)}</b> ${esc((q.body || '').slice(0, 120))}` : 'Replying to an earlier message'}</div>`;
  }
  const flags = [];
  if (m.deleted) flags.push(`<span class="flag del">${m.mine ? 'You unsent this' : 'Deleted by sender'}</span>`);
  if (m.failed) flags.push(`<span class="flag del" title="${esc(m.failed)}">Not delivered</span>`);
  if (m.edited) flags.push(`<span class="flag edit" data-hist="${esc(m.id)}">edited</span>`);
  const seen = m.mine && r && r.seenTs && r.seenTs >= m.ts ? '<span class="seen">✓✓ Seen</span>' : '';
  const reacts = Object.entries(m.reactions || {}).map(([k, arr]) => `<span class="react ${arr.some((x) => x.sender === S.st.me) ? 'me' : ''}" title="${esc(arr.map((x) => x.sender.split(':')[0].slice(1)).join(', '))}">${esc(k)} ${arr.length > 1 ? arr.length : ''}</span>`).join('');
  const canEdit = m.mine && !m.deleted && (m.type === 'm.text' || !m.type) && m.sender === S.st.me;
  const actions = `<div class="actions">
    <button data-act="reply" title="Reply">↩</button>
    <button data-act="react" data-key="👍">👍</button><button data-act="react" data-key="❤️">❤️</button><button data-act="react" data-key="😂">😂</button>
    <button data-act="copy" title="Copy">⧉</button>
    ${canEdit ? '<button data-act="edit" title="Edit">✎</button>' : ''}
    ${m.mine && !m.deleted && m.sender === S.st.me ? '<button data-act="delete" title="Unsend">🗑</button>' : ''}
  </div>`;
  return `<div class="msg ${m.mine ? 'mine' : ''} ${m.deleted ? 'deleted' : ''}" data-id="${esc(m.id)}">
    ${showWho ? `<div class="who">${esc(m.senderName)}</div>` : ''}
    ${actions}
    <div class="bubble">${quote}${body}</div>
    ${reacts ? `<div class="reacts">${reacts}</div>` : ''}
    <div class="foot"><span>${new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>${flags.join('')}${seen}</div>
  </div>`;
}
function renderMessages(forceBottom) {
  const box = $('#messages');
  const r = curRoom();
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 140;
  let html = r && r.canLoadOlder ? '<button class="ghost-btn loadmore" id="loadOlder">Load older messages</button>' : '';
  let lastDay = '';
  let prev = null;
  for (const m of S.msgs) {
    const day = new Date(m.ts).toDateString();
    if (day !== lastDay) { html += `<div class="daysep">${new Date(m.ts).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</div>`; lastDay = day; prev = null; }
    html += msgHtml(m, prev, r);
    prev = m;
  }
  if (!S.msgs.length) html += '<div class="daysep">No messages saved yet</div>';
  box.innerHTML = html;
  if (forceBottom || nearBottom) box.scrollTop = box.scrollHeight;
  renderTyping();
}
function renderTyping() {
  const r = curRoom();
  $('#typingLine').textContent = r && r.typing && r.typing.length ? `${r.typing.join(', ')} ${r.typing.length > 1 ? 'are' : 'is'} typing...` : '';
}
function jump(id) {
  const el = document.querySelector(`.msg[data-id="${CSS.escape(id)}"]`);
  if (!el) return toast('That message is not loaded');
  el.scrollIntoView({ block: 'center' });
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 1600);
}
$('#messages').addEventListener('click', async (e) => {
  const r = curRoom();
  if (e.target.id === 'loadOlder') {
    e.target.disabled = true;
    const box = $('#messages');
    const h = box.scrollHeight;
    const res = await call('loadOlder', r.id).catch((er) => toast(er.message, true));
    if (res) {
      S.msgs = res.messages.slice(-Math.max(400, S.msgs.length + 50));
      r.canLoadOlder = res.canLoadOlder;
      renderMessages();
      box.scrollTop = box.scrollHeight - h;
    }
    return;
  }
  const img = e.target.closest('img.media');
  if (img) {
    const full = img.dataset.full;
    const show = (u) => { $('#lightbox').innerHTML = `<img src="${u}">`; $('#lightbox').classList.remove('hidden'); };
    if (full.startsWith('sbrelay:') && window.sbResolveMedia) window.sbResolveMedia(full.slice(8)).then(show).catch(() => show(img.src));
    else show(full);
    return;
  }
  const fileEl = e.target.closest('[data-save]');
  if (fileEl) {
    if (REMOTE) { (window.sbResolveMedia ? window.sbResolveMedia(fileEl.dataset.save) : Promise.resolve(mxc(fileEl.dataset.save))).then((u) => window.open(u, '_blank')).catch((er) => toast(er.message, true)); return; }
    call('saveMedia', fileEl.dataset.save, fileEl.dataset.name).catch((er) => toast(er.message, true));
    return;
  }
  const j = e.target.closest('[data-jump]');
  if (j) return jump(j.dataset.jump);
  const h = e.target.closest('[data-hist]');
  if (h) return showHistory(h.dataset.hist);
  const a = e.target.closest('[data-act]');
  if (!a) return;
  const id = a.closest('.msg').dataset.id;
  const m = S.msgs.find((x) => x.id === id);
  if (!m) return;
  try {
    if (a.dataset.act === 'reply') { S.replyTo = m; S.editing = null; renderReply(); $('#input').focus(); }
    if (a.dataset.act === 'react') await call('react', r.id, m.id, a.dataset.key);
    if (a.dataset.act === 'copy') { await navigator.clipboard.writeText(m.body || ''); toast('Copied'); }
    if (a.dataset.act === 'edit') { S.editing = m; S.replyTo = null; $('#input').value = m.body; renderReply(); autosize(); $('#input').focus(); }
    if (a.dataset.act === 'delete') { if (confirm('Unsend this message for everyone?')) await call('redact', r.id, m.id); }
  } catch (er) { toast(er.message, true); }
});
$('#lightbox').addEventListener('click', () => $('#lightbox').classList.add('hidden'));
function showHistory(id) {
  const m = S.msgs.find((x) => x.id === id);
  if (!m) return;
  const items = [...(m.edits || []).map((e, i) => ({ body: e.body, ts: i === 0 ? m.ts : m.edits[i - 1].ts, label: i === 0 ? 'Original' : 'Version ' + (i + 1) })), { body: m.body, ts: (m.edits || []).slice(-1)[0]?.ts, label: 'Current' }];
  modal(`<h2>Edit history</h2><p class="small">Every version this message has had.</p>${items.map((x) => `<div class="hist"><small>${esc(x.label)}${x.ts ? ' · ' + new Date(x.ts).toLocaleString() : ''}</small>${esc(x.body)}</div>`).join('')}<div class="modal-foot"><button class="primary" data-close>Close</button></div>`);
}
function renderReply() {
  const bar = $('#replyBar');
  const m = S.replyTo || S.editing;
  if (!m) { bar.classList.add('hidden'); $('#sendBtn').textContent = 'Send'; return; }
  bar.classList.remove('hidden');
  bar.innerHTML = `<b>${S.editing ? 'Editing' : 'Replying to ' + esc(m.senderName)}</b><span>${esc(m.body)}</span><button class="icon-btn" id="cancelReply" style="width:26px;height:26px">×</button>`;
  $('#sendBtn').textContent = S.editing ? 'Save' : 'Send';
}
$('#replyBar').addEventListener('click', (e) => {
  if (e.target.id === 'cancelReply') { if (S.editing) $('#input').value = ''; S.replyTo = S.editing = null; renderReply(); }
});

// composer
function autosize() {
  const t = $('#input');
  t.style.height = 'auto';
  t.style.height = Math.min(160, t.scrollHeight) + 'px';
}
function qrMatches() {
  const v = $('#input').value;
  if (!v.startsWith('/')) return [];
  const q = v.slice(1).toLowerCase();
  return (S.st.quickReplies || []).filter((x) => x.shortcut.toLowerCase().startsWith(q) || x.text.toLowerCase().includes(q)).slice(0, 8);
}
function renderQuick() {
  const list = qrMatches();
  const pop = $('#qrPop');
  if (!list.length) return pop.classList.add('hidden');
  S.qrIndex = Math.min(S.qrIndex, list.length - 1);
  pop.innerHTML = list.map((x, i) => `<div class="qr-item ${i === S.qrIndex ? 'on' : ''}" data-i="${i}"><b>/${esc(x.shortcut)}</b><span>${esc(x.text.slice(0, 90))}</span></div>`).join('');
  pop.classList.remove('hidden');
}
function pickQuick(i) {
  const x = qrMatches()[i];
  if (!x) return;
  $('#input').value = x.text;
  $('#qrPop').classList.add('hidden');
  autosize();
}
$('#qrPop').addEventListener('mousedown', (e) => { const it = e.target.closest('[data-i]'); if (it) { e.preventDefault(); pickQuick(+it.dataset.i); } });
$('#input').addEventListener('input', () => {
  autosize();
  S.qrIndex = 0;
  renderQuick();
  if (S.current && $('#input').value && !$('#input').value.startsWith('/')) call('typing', S.current).catch(() => {});
});
$('#input').addEventListener('keydown', (e) => {
  const pop = !$('#qrPop').classList.contains('hidden');
  if (pop && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); S.qrIndex += e.key === 'ArrowDown' ? 1 : -1; S.qrIndex = Math.max(0, S.qrIndex); renderQuick(); return; }
  if (pop && (e.key === 'Tab' || e.key === 'Enter')) { e.preventDefault(); pickQuick(S.qrIndex); return; }
  if (e.key === 'Escape') { $('#qrPop').classList.add('hidden'); if (S.replyTo || S.editing) { S.replyTo = S.editing = null; renderReply(); } }
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendNow(); }
});
$('#sendBtn').addEventListener('click', sendNow);
async function sendNow() {
  const t = $('#input');
  const text = t.value.trim();
  if (!text || !S.current) return;
  const room = S.current;
  try {
    if (S.editing) await call('edit', room, S.editing.id, text);
    else await call('send', room, text, S.replyTo && S.replyTo.id);
    t.value = '';
    S.replyTo = S.editing = null;
    renderReply();
    autosize();
  } catch (e) { toast('Not sent: ' + e.message, true); }
}
$('#attachBtn').addEventListener('click', async () => {
  if (!S.current) return;
  if (REMOTE) {
    const room = S.current;
    const paths = await window.sbPickFiles('', true).catch((e) => { toast(e.message, true); return []; });
    if (paths.length) { toast('Sending...'); try { await call('sendFilePaths', room, paths); toast('Sent'); } catch (e) { toast(e.message, true); } }
    return;
  }
  try { const n = await call('sendFiles', S.current); if (n) toast(`Sent ${n} file${n > 1 ? 's' : ''}`); } catch (e) { toast(e.message, true); }
});
$('#chat').addEventListener('dragover', (e) => e.preventDefault());
$('#chat').addEventListener('drop', async (e) => {
  e.preventDefault();
  if (!S.current) return;
  const paths = REMOTE ? await Promise.all([...e.dataTransfer.files].map((f) => window.sbUpload(f))) : [...e.dataTransfer.files].map((f) => window.sb.filePath(f)).filter(Boolean);
  if (!paths.length) return;
  toast('Sending...');
  try { await call('sendFilePaths', S.current, paths); toast('Sent'); } catch (er) { toast(er.message, true); }
});
function localDT(ts) {
  const d = new Date(ts - new Date().getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 16);
}
$('#scheduleBtn').addEventListener('click', () => {
  if (!S.current) return;
  const text = $('#input').value.trim();
  modal(`<h2>Send later</h2><p class="small">Switchboard must be running (it can sit in the tray) at the scheduled time.</p>
    <div class="field"><span>Message</span><textarea id="schText" rows="4">${esc(text)}</textarea></div>
    <div class="field"><span>When</span><input type="datetime-local" id="schAt" value="${localDT(Date.now() + 3600000)}"></div>
    <div class="modal-foot"><button class="ghost-btn" data-close>Cancel</button><button class="primary" id="schSave">Schedule</button></div>`);
  $('#schSave').onclick = async () => {
    const at = new Date($('#schAt').value).getTime();
    const t = $('#schText').value.trim();
    if (!t || !at) return toast('Add a message and time', true);
    const r = curRoom();
    await call('scheduleAdd', { kind: 'message', roomId: S.current, roomName: r ? r.name : '', text: t, at });
    $('#input').value = '';
    closeModal();
    toast('Scheduled for ' + new Date(at).toLocaleString());
  };
});

// drawer
function renderDrawer() {
  const d = $('#drawer');
  const r = curRoom();
  if (!S.drawer || !r || S.view !== 'inbox') return d.classList.add('hidden');
  d.classList.remove('hidden');
  const acc = account(r.accountId);
  const tri = (v) => (v === null || v === undefined ? 'default' : v ? 'on' : 'off');
  d.innerHTML = `
    <div style="display:flex;gap:12px;align-items:center">${avatarHtml(r.name, r.avatar, r.network, 52)}<div><h3>${esc(r.name)}</h3><div class="small">${esc(netLabel(r.network))}${acc ? ' · ' + esc(acc.label) : ''}</div></div></div>
    <div class="sect"><label>Privacy for this chat</label>
      <div class="row"><span class="grow">Ghost read</span><select id="dGhost"><option value="default">Default (${S.st.settings.ghostRead ? 'on' : 'off'})</option><option value="on">On</option><option value="off">Off</option></select></div>
      <div class="row"><span class="grow">Hide typing</span><select id="dTyping"><option value="default">Default (${S.st.settings.hideTyping ? 'on' : 'off'})</option><option value="on">On</option><option value="off">Off</option></select></div>
      <div class="btns" style="margin-top:8px"><button class="ghost-btn" id="dMarkRead">Mark as read on ${esc(netLabel(r.network))}</button></div>
      <div class="small" style="margin-top:6px">With ghost read on, they only see "Seen" when you press this or reply.</div>
    </div>
    <div class="sect"><label>Organise</label>
      <div class="btns"><button class="ghost-btn" id="dStash">${r.stash ? 'Unhide' : 'Hide chat 🔒'}</button><button class="ghost-btn" id="dPin">${r.pinned ? 'Unpin' : 'Pin'}</button><button class="ghost-btn" id="dArch">${r.archived ? 'Unarchive' : 'Archive'}</button><button class="ghost-btn" id="dUnread">Mark unread</button></div>
    </div>
    <div class="sect"><label>Folders</label><div class="tagsel" id="dTags">${(S.st.tags || []).map((t) => `<button data-tag="${esc(t.id)}" class="${(r.tags || []).includes(t.id) ? 'on' : ''}" style="${(r.tags || []).includes(t.id) ? `background:${esc(t.color)};border-color:${esc(t.color)}` : ''}">${esc(t.name)}</button>`).join('')}</div></div>
    <div class="sect"><label>Notes (only you see these)</label><textarea id="dNote" placeholder="e.g. client since March, prefers voice notes">${esc(r.note)}</textarea></div>
    <div class="sect"><label>Export chat</label><div class="btns"><button class="ghost-btn" data-exp="txt">Text</button><button class="ghost-btn" data-exp="csv">CSV</button><button class="ghost-btn" data-exp="json">JSON</button></div></div>`;
  $('#dGhost').value = tri(r.ghost);
  $('#dTyping').value = tri(r.hideTyping);
}
const triVal = (v) => (v === 'default' ? null : v === 'on');
$('#drawer').addEventListener('change', async (e) => {
  const r = curRoom();
  if (e.target.id === 'dGhost') await call('roomSettings', r.id, { ghost: triVal(e.target.value) });
  if (e.target.id === 'dTyping') await call('roomSettings', r.id, { hideTyping: triVal(e.target.value) });
});
$('#drawer').addEventListener('focusout', async (e) => {
  if (e.target.id === 'dNote') { await call('roomSettings', S.current, { note: e.target.value }); toast('Note saved'); }
});
$('#drawer').addEventListener('click', async (e) => {
  const r = curRoom();
  if (!r) return;
  try {
    if (e.target.id === 'dMarkRead') { await call('markReadOnPlatform', r.id); toast('Marked as read on ' + netLabel(r.network)); }
    if (e.target.id === 'dPin') await call('roomSettings', r.id, { pinned: !r.pinned });
    if (e.target.id === 'dStash') { await call('roomSettings', r.id, { stash: !r.stash }); toast(r.stash ? 'Chat moved back to the inbox' : 'Chat hidden. Find it under Folders → Hidden'); }
    if (e.target.id === 'dArch') await call('roomSettings', r.id, { archived: !r.archived });
    if (e.target.id === 'dUnread') { await call('markUnread', r.id); S.current = null; $('#chatBox').classList.add('hidden'); $('#chatEmpty').classList.remove('hidden'); call('focusRoom', null); S.drawer = false; renderDrawer(); }
    const tb = e.target.closest('[data-tag]');
    if (tb) {
      const t = tb.dataset.tag;
      const tags = (r.tags || []).includes(t) ? r.tags.filter((x) => x !== t) : [...(r.tags || []), t];
      await call('roomSettings', r.id, { tags });
    }
    const ex = e.target.closest('[data-exp]');
    if (ex && REMOTE) return toast('Export chats from Switchboard on your PC', true);
    if (ex && (await call('exportChat', r.id, ex.dataset.exp))) toast('Exported');
  } catch (er) { toast(er.message, true); }
});

// ------------------------------------------------------------------ panels
function renderPanel() {
  const p = $('#panel');
  if (S.view === 'settings' && !REMOTE && !S.remoteFetched) { S.remoteFetched = true; S.remote = S.remote || {}; call('remoteInfo').then((r) => { S.remote = r; S.st.settings.phoneAccess = r.enabled; if (S.view === 'settings') renderPanel(); }).catch(() => {}); }
  const fn = { accounts: panelAccounts, post: panelPost, scheduled: panelScheduled, automation: panelAutomation, settings: panelSettings, engine: panelEngine }[S.view];
  p.innerHTML = fn ? fn() : '';
  if (S.view === 'post') renderIgFiles();
  if (S.view === 'engine' || S.view === 'settings') { const lb = $('#logbox'); if (lb) lb.scrollTop = lb.scrollHeight; }
}

function panelEngine() {
  const accs = S.st.accounts || [];
  return `<h1>Engine</h1><div class="sub">Switchboard runs a small built-in engine for each account. Nothing else needs to be installed.</div>
    <div class="card"><h3>Accounts</h3>
      ${accs.length ? accs.map((a) => `<div class="acc">${avatarHtml(a.label, null, a.network, 32)}<div class="info"><b>${esc(a.label)}</b><div>${a.status && a.status.online ? accState(a) : '<span class="state wait">starting</span>'}</div></div><div class="btns"><button class="ghost-btn" data-logs="${a.id}">Log</button></div></div>`).join('') : '<div class="small">No accounts yet. <a href="#" data-view="accounts">Add one</a>.</div>'}
      <div class="btns" style="margin-top:12px"><button class="ghost-btn" id="bootBtn">Restart engines</button><button class="ghost-btn" id="srvLog">App log</button></div>
    </div>
    <div class="card"><h3>Activity</h3><div class="logbox" id="logbox">${esc(S.logs.slice(-400).join('\n')) || 'Nothing yet.'}</div></div>`;
}

function accState(a) {
  const s = a.status;
  if (!s) return '<span class="state wait">checking</span>';
  if (!s.online) return '<span class="state bad">bridge offline</span>';
  if (!s.logins.length) return '<span class="state wait">not logged in</span>';
  const l = s.logins[0];
  const ok = /CONNECTED|BACKFILLING/.test(l.state);
  const conn = /CONNECTING|UNKNOWN/.test(l.state);
  return `<span class="state ${ok ? 'ok' : conn ? 'wait' : 'bad'}">${esc(l.state.toLowerCase().replace(/_/g, ' '))}</span> <span class="small">${esc(l.name || '')}</span>`;
}
function panelAccounts() {
  const accs = S.st.accounts || [];
  if (REMOTE) {
    return `<h1>Accounts</h1><div class="sub">Accounts run on your PC. Add accounts and log them in there.</div>
      <div class="card">${accs.map((a) => `<div class="acc">${avatarHtml(a.label, null, a.network, 34)}<div class="info"><b>${esc(a.label)}</b><span class="small">${esc(netLabel(a.network))}</span><div>${accState(a)}</div></div></div>`).join('') || '<div class="small">No accounts yet.</div>'}</div>`;
  }
  return `<h1>Accounts</h1><div class="sub">Each account runs in its own built-in engine, with its own proxy, so client accounts never share an IP.</div>
    <div class="card"><h3>Connected</h3>
      ${accs.length ? accs.map((a) => `<div class="acc">${avatarHtml(a.label, null, a.network, 38)}
        <div class="info"><b>${esc(a.label)}</b><span class="small">${esc(netLabel(a.network))}${a.proxy ? ' · proxy ' + esc(a.proxy.replace(/\/\/[^@]*@/, '//***@')) : ' · no proxy'}${S.st.settings.tricksterEnabled && a.tricksterProfileId ? ' · Trickster #' + esc(a.tricksterProfileId) : ''}</span><div>${accState(a)}</div></div>
        <div class="btns"><button class="primary" data-login="${a.id}">${a.status && a.status.logins.length ? 'Re-login' : 'Log in'}</button>
        ${a.network !== 'whatsapp' ? `<button class="ghost-btn" data-browser="${a.id}" title="Browse ${esc(netLabel(a.network))} as this account, through its proxy">Open browser</button>` : ''}
        <button class="ghost-btn" data-edit="${a.id}">Edit</button><button class="ghost-btn" data-logs="${a.id}">Log</button>
        <button class="ghost-btn" data-logout="${a.id}">Log out</button><button class="danger-btn" data-remove="${a.id}">Remove</button></div></div>`).join('') : '<div class="small">No accounts yet.</div>'}
      <div class="btns" style="margin-top:12px"><button class="ghost-btn" id="refreshAcc">Refresh status</button></div>
    </div>
    <div class="card"><h3>Add an account</h3>
      <div class="grid2">
        <label class="field"><span>App</span><select id="aNet">${Object.entries(NETS()).map(([k, n]) => `<option value="${k}">${esc(n.label)}</option>`).join('')}</select></label>
        <label class="field"><span>Name (for you)</span><input id="aLabel" placeholder="e.g. Bella's Bakery IG"></label>
        <label class="field"><span>Proxy (optional)</span><input id="aProxy" placeholder="http://user:pass@host:port or socks5://..."></label>
        ${S.st.settings.tricksterEnabled ? `<label class="field"><span>Trickster profile (optional)</span>
          <div class="row" style="margin:0"><select id="aTrick" class="grow"><option value="">None - use Switchboard's own login window</option></select><button class="ghost-btn" id="loadTrick">Load</button></div></label>` : ''}
      </div>
      <div class="small" style="margin-bottom:12px">WhatsApp: you scan a QR code with your phone. Messenger / Instagram: a login window opens that runs through this account's proxy; log in normally and it closes by itself.${S.st.settings.tricksterEnabled ? ' If you pick a Trickster profile, the login is taken from that profile instead.' : ''} Use an http proxy for logins that need a username and password (Chrome can't log in to SOCKS5 proxies with a password).</div>
      <button class="primary" id="addAcc">Add and log in</button>
    </div>`;
}

const POST_KINDS = {
  igpost: { label: 'Instagram post', network: 'instagram', caption: true, media: 'required', note: 'Goes on the profile grid. "Post quietly" uses Instagram\'s own option to keep it out of followers\' feeds (some accounts don\'t have it yet).' },
  igstory: { label: 'Instagram story', network: 'instagram', caption: false, media: 'one', note: 'Stories always appear in the story bar for whoever is allowed to see them. Choose Close Friends to limit it to your Close Friends list. Instagram only allows story uploads from its phone site, so Switchboard uses that.' },
  fbpost: { label: 'Facebook post', network: 'messenger', caption: true, media: 'optional', note: 'Facebook has no "quiet" post. To keep a post low-key, set the audience: Only me keeps it on your profile for you alone, and Friends except hides it from the people you name. Page posts are always public.' },
  fbstory: { label: 'Facebook story', network: 'messenger', caption: false, media: 'one-photo', note: 'Facebook stories can\'t be silent either, but you can limit the audience (Friends, or Custom for chosen people). Facebook\'s website only takes photo stories.' },
};
const AUDIENCES = {
  igstory: [['everyone', 'Everyone (your story)'], ['close_friends', 'Close Friends only']],
  fbpost: [['default', 'Keep my usual audience'], ['public', 'Public'], ['friends', 'Friends'], ['friends_except', 'Friends except...'], ['specific', 'Specific friends...'], ['only_me', 'Only me']],
  fbstory: [['default', 'Keep my usual audience'], ['public', 'Public'], ['friends', 'Friends'], ['custom', 'Custom (chosen people)...']],
};
function postState() {
  S.post = S.post || { kind: 'igpost', accountId: '', pageUrl: '', audience: '', people: '', caption: '', quiet: true, allowNormal: false, at: '' };
  return S.post;
}
function readPostForm() {
  const P = postState();
  const v = (id) => (document.getElementById(id) ? document.getElementById(id).value : undefined);
  const c = (id) => (document.getElementById(id) ? document.getElementById(id).checked : undefined);
  if (v('pAcc') !== undefined) P.accountId = v('pAcc');
  if (v('pAs') !== undefined) P.pageUrl = v('pAs') === '__add' ? '' : v('pAs');
  if (v('pAud') !== undefined) P.audience = v('pAud');
  if (v('pPeople') !== undefined) P.people = v('pPeople');
  if (v('pCap') !== undefined) P.caption = v('pCap');
  if (c('pQuiet') !== undefined) P.quiet = c('pQuiet');
  if (c('pAllow') !== undefined) P.allowNormal = c('pAllow');
  if (v('pAt') !== undefined) P.at = v('pAt');
  return P;
}
function panelPost() {
  const P = postState();
  const K = POST_KINDS[P.kind];
  const accs = (S.st.accounts || []).filter((a) => a.network === K.network);
  if (!accs.some((a) => a.id === P.accountId)) P.accountId = accs[0] ? accs[0].id : '';
  const acc = account(P.accountId);
  const isFb = K.network === 'messenger';
  const pages = (acc && acc.pages) || [];
  if (P.pageUrl && !pages.some((p) => p.url === P.pageUrl)) P.pageUrl = '';
  const auds = AUDIENCES[P.kind];
  if (auds && !auds.some(([k]) => k === P.audience)) P.audience = auds[0][0];
  const onPage = isFb && P.pageUrl;
  const needPeople = ['friends_except', 'specific', 'custom'].includes(P.audience) && !onPage;
  return `<h1>Post</h1><div class="sub">Post to Instagram and Facebook, on profiles and Pages, with control over who sees it.</div>
    <div class="chips" style="margin-bottom:14px">${Object.entries(POST_KINDS).map(([k, v]) => `<button class="chip ${P.kind === k ? 'on' : ''}" data-kind="${k}">${esc(v.label)}</button>`).join('')}</div>
    <div class="notice info">${esc(K.note)}</div>
    ${!accs.length ? `<div class="notice">Add ${isFb ? 'a Facebook / Messenger' : 'an Instagram'} account in <a href="#" data-view="accounts">Accounts</a> and log it in first.</div>` : ''}
    <div class="card">
      <div class="grid2">
        <label class="field"><span>Account</span><select id="pAcc">${accs.map((a) => `<option value="${a.id}" ${a.id === P.accountId ? 'selected' : ''}>${esc(a.label)}${S.st.settings.tricksterEnabled && a.tricksterProfileId ? ' (via Trickster)' : ''}</option>`).join('')}</select></label>
        ${isFb ? `<label class="field"><span>Post as</span><select id="pAs"><option value="">My profile</option>${pages.map((p) => `<option value="${esc(p.url)}" ${p.url === P.pageUrl ? 'selected' : ''}>Page: ${esc(p.name)}</option>`).join('')}<option value="__add">+ Add a Page...</option></select></label>` : '<div></div>'}
      </div>
      <div id="addPageRow" class="hidden grid2" style="margin-bottom:10px">
        <label class="field"><span>Page name (for you)</span><input id="newPageName" placeholder="Bella's Bakery"></label>
        <label class="field"><span>Page link</span><div class="row" style="margin:0"><input id="newPageUrl" class="grow" placeholder="https://www.facebook.com/bellasbakery"><button class="ghost-btn" id="savePage">Add</button></div></label>
      </div>
      ${isFb && pages.length ? `<div class="small" style="margin:-4px 0 10px">${pages.map((p) => `<span class="thumbs"><span class="t">${esc(p.name)} <a href="#" data-delpage="${esc(p.url)}">remove</a></span></span>`).join(' ')}</div>` : ''}
      <div class="field"><span>${K.media === 'optional' ? 'Photos / video (optional)' : K.media === 'required' ? 'Photos / video (one, or several for a carousel)' : K.media === 'one-photo' ? 'One photo' : 'One photo or video'}</span>
        <div class="btns"><button class="ghost-btn" id="pPick">Choose files</button><button class="ghost-btn" id="pClear">Clear</button></div><div class="thumbs" id="pFiles"></div></div>
      ${K.caption ? `<label class="field"><span>${P.kind === 'fbpost' ? 'Text' : 'Caption'}</span><textarea id="pCap" rows="5" placeholder="${P.kind === 'fbpost' ? "What's on your mind?" : 'Write a caption...'}">${esc(P.caption)}</textarea></label>` : ''}
      ${P.kind === 'igpost' ? `
        <div class="row"><label class="switch"><input type="checkbox" id="pQuiet" ${P.quiet ? 'checked' : ''}><span></span></label><span class="grow">Post quietly to profile (keep it out of followers' feeds)</span></div>
        <div class="row"><label class="switch"><input type="checkbox" id="pAllow" ${P.allowNormal ? 'checked' : ''}><span></span></label><span class="grow">Post normally if this account doesn't have the quiet option</span></div>` : ''}
      ${auds && !onPage ? `<label class="field"><span>Who can see it</span><select id="pAud">${auds.map(([k, l]) => `<option value="${k}" ${k === P.audience ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>` : ''}
      ${onPage && auds ? `<div class="small" style="margin-bottom:10px">Posting as a Page: Page ${P.kind === 'fbstory' ? 'stories' : 'posts'} are public.</div>` : ''}
      ${needPeople ? `<label class="field"><span>Names (comma separated, exactly as they appear on Facebook)</span><input id="pPeople" value="${esc(P.people)}" placeholder="Jane Smith, Tom Lee"></label>` : ''}
      <label class="field" style="max-width:320px"><span>Schedule (optional)</span><input type="datetime-local" id="pAt" value="${esc(P.at)}"></label>
      <div class="btns" style="margin-top:6px"><button class="ghost-btn" id="pTest">Test (don't post)</button><button class="primary" id="pNow">Post now</button><button class="ghost-btn" id="pSched">Schedule</button></div>
    </div>
    <div class="card"><h3>Progress</h3><div class="logbox" id="igLog">${esc(S.igLog.join('\n')) || 'Nothing yet.'}</div></div>`;
}
function renderIgFiles() {
  const el = $('#pFiles');
  if (el) el.innerHTML = S.igFiles.map((f) => `<span class="t">${esc(f.split(/[\\/]/).pop())}</span>`).join('') || '<span class="small">No files chosen</span>';
}
function igJob(extra) {
  const P = readPostForm();
  const job = { kind: P.kind, accountId: P.accountId, files: S.igFiles, caption: POST_KINDS[P.kind].caption ? P.caption : '', ...extra };
  if (P.kind === 'igpost') { job.quiet = P.quiet; job.allowNormal = P.allowNormal; }
  if (POST_KINDS[P.kind].network === 'messenger') job.pageUrl = P.pageUrl || '';
  if (AUDIENCES[P.kind] && !job.pageUrl) job.audience = P.audience;
  if (['friends_except', 'specific', 'custom'].includes(job.audience)) job.people = (P.people || '').split(',').map((x) => x.trim()).filter(Boolean);
  return job;
}
function checkJob(job) {
  const K = POST_KINDS[job.kind];
  if (!job.accountId) return 'Pick an account first';
  if (K.media !== 'optional' && !job.files.length) return 'Choose a photo or video first';
  if ((K.media === 'one' || K.media === 'one-photo') && job.files.length > 1) return 'Stories take one file at a time';
  if (job.kind === 'fbpost' && !job.files.length && !(job.caption || '').trim()) return 'Write something or add a photo';
  if (job.people !== undefined && !job.people.length) return 'Add at least one name';
  return null;
}
async function runIg(job) {
  S.igLog = [];
  if ($('#igLog')) $('#igLog').textContent = '';
  try {
    const r = await call('socialPost', job);
    if (job.dryRun) {
      const f = r.found || {};
      const parts = Object.entries(f).map(([k, v]) => `${k === 'quiet' ? 'Post quietly option' : k === 'closeFriends' ? 'Close Friends option' : k === 'audience' ? 'Audience setting' : k === 'share' ? 'Share button' : k}: ${v ? 'found' : 'NOT found'}`);
      S.igLog.push('Test finished, nothing was posted. ' + parts.join(' · '));
      toast(Object.values(f).every(Boolean) ? 'Test passed: everything needed was found' : 'Test finished, but something was missing (see Progress)', !Object.values(f).every(Boolean));
    } else toast(job.quiet && r.quiet ? 'Posted quietly to profile' : 'Posted');
  } catch (e) {
    S.igLog.push('Error: ' + e.message + (e.screenshot ? '\nScreenshot: ' + e.screenshot : ''));
    toast(e.message, true);
  }
  if ($('#igLog')) $('#igLog').textContent = S.igLog.join('\n');
}

function panelScheduled() {
  const list = [...(S.st.schedule || [])].sort((a, b) => a.at - b.at);
  return `<h1>Scheduled</h1><div class="sub">Messages and Instagram posts waiting to go out. Keep Switchboard open or in the tray.</div>
    <div class="card"><table class="list"><tr><th>When</th><th>What</th><th>Where</th><th>Status</th><th></th></tr>
    ${list.map((s) => `<tr><td>${new Date(s.at).toLocaleString()}</td><td>${s.kind === 'message' ? '💬 ' + esc((s.text || '').slice(0, 80)) : `<b>${esc((POST_KINDS[s.kind] || {}).label || s.kind)}</b> ` + esc((s.caption || '').slice(0, 60) || (s.files || []).length + ' file(s)') + (s.quiet ? ' <span class="small">(quiet)</span>' : '') + (s.audience && s.audience !== 'default' && s.audience !== 'everyone' ? ` <span class="small">(${esc(s.audience.replace(/_/g, ' '))})</span>` : '')}</td>
      <td>${esc(s.kind === 'message' ? s.roomName || '' : ((account(s.accountId) || {}).label || '') + (s.pageUrl ? ' · Page' : ''))}</td>
      <td><span class="state ${s.status === 'done' ? 'ok' : s.status === 'failed' ? 'bad' : 'wait'}">${esc(s.status)}</span>${s.error ? `<div class="small">${esc(s.error)}</div>` : ''}</td>
      <td><button class="ghost-btn" data-unsched="${s.id}">Remove</button></td></tr>`).join('') || '<tr><td colspan="5" class="small">Nothing scheduled.</td></tr>'}
    </table><div class="btns" style="margin-top:12px"><button class="ghost-btn" id="clearDone">Clear finished</button></div></div>`;
}

function panelAutomation() {
  const accs = S.st.accounts || [];
  return `<h1>Automation</h1><div class="sub">Quick replies, auto-replies and folders for managing your inboxes.</div>
    <div class="card"><h3>Quick replies</h3><div class="small" style="margin-bottom:8px">Type <b>/</b> in any chat to use them.</div>
      <table class="list" id="qrTable"><tr><th style="width:160px">Shortcut</th><th>Text</th><th></th></tr>
      ${(S.st.quickReplies || []).map((q, i) => `<tr data-i="${i}"><td><input data-k="shortcut" value="${esc(q.shortcut)}" style="width:100%"></td><td><textarea data-k="text" rows="2" style="width:100%">${esc(q.text)}</textarea></td><td><button class="danger-btn" data-delqr="${i}">×</button></td></tr>`).join('')}
      </table><div class="btns" style="margin-top:10px"><button class="ghost-btn" id="addQr">Add</button><button class="primary" id="saveQr">Save quick replies</button></div></div>

    <div class="card"><h3>Auto-replies</h3><div class="small" style="margin-bottom:8px">Replies automatically in one-to-one chats. Sending a reply also marks the chat as read on that app.</div>
      ${(S.st.autoReplies || []).map((r, i) => `<div class="card" data-ar="${i}" style="background:var(--bg3)">
        <div class="row"><label class="switch"><input type="checkbox" data-k="enabled" ${r.enabled ? 'checked' : ''}><span></span></label><input data-k="name" class="grow" value="${esc(r.name || '')}" placeholder="Rule name"><button class="danger-btn" data-delar="${i}">Delete</button></div>
        <div class="grid2" style="margin-top:8px">
          <label class="field"><span>Only when the message contains (comma separated, empty = any message)</span><input data-k="keywords" value="${esc(r.keywords || '')}"></label>
          <label class="field"><span>Don't repeat in the same chat for (minutes)</span><input data-k="cooldownMin" type="number" min="1" value="${esc(r.cooldownMin || 60)}"></label>
        </div>
        <label class="field"><span>Reply</span><textarea data-k="text" rows="2">${esc(r.text || '')}</textarea></label>
        <div class="row"><label class="switch"><input type="checkbox" data-k="hoursOn" ${r.hours && r.hours.on ? 'checked' : ''}><span></span></label><span>Only between</span><input type="time" data-k="hoursFrom" value="${esc((r.hours && r.hours.from) || '17:00')}"><span>and</span><input type="time" data-k="hoursTo" value="${esc((r.hours && r.hours.to) || '09:00')}"></div>
        <div class="small" style="margin-top:6px">Accounts (none ticked = all):</div>
        <div class="tagsel">${accs.map((a) => `<label class="small" style="display:flex;gap:4px;align-items:center;margin-right:10px"><input type="checkbox" data-acc="${a.id}" ${(r.accountIds || []).includes(a.id) ? 'checked' : ''}> ${esc(a.label)}</label>`).join('')}</div>
      </div>`).join('') || '<div class="small">No auto-replies.</div>'}
      <div class="btns" style="margin-top:10px"><button class="ghost-btn" id="addAr">Add rule</button><button class="primary" id="saveAr">Save auto-replies</button></div></div>

    <div class="card"><h3>Folders</h3><div class="small" style="margin-bottom:8px">Sort chats from any app into folders such as Personal, Business or Church. A chat can be in more than one folder. Add chats by right-clicking them, dragging them onto a folder, or from the chat's info panel. To file new chats from an account automatically, use Accounts → Edit.</div><table class="list" id="tagTable"><tr><th>Name</th><th style="width:90px">Colour</th><th></th></tr>
      ${(S.st.tags || []).map((t, i) => `<tr data-i="${i}"><td><input data-k="name" value="${esc(t.name)}" style="width:100%"></td><td><input data-k="color" type="color" value="${esc(t.color)}" style="padding:2px;height:34px;width:60px"></td><td><button class="danger-btn" data-deltag="${i}">×</button></td></tr>`).join('')}
      </table><div class="btns" style="margin-top:10px"><button class="ghost-btn" id="addTag">Add folder</button><button class="primary" id="saveTag">Save folders</button></div></div>`;
}
function readQr() {
  return [...document.querySelectorAll('#qrTable tr[data-i]')].map((tr, i) => ({ id: (S.st.quickReplies[i] || {}).id || Math.random().toString(36).slice(2), shortcut: tr.querySelector('[data-k=shortcut]').value.trim().replace(/^\//, ''), text: tr.querySelector('[data-k=text]').value })).filter((q) => q.shortcut && q.text);
}
function readAr() {
  return [...document.querySelectorAll('[data-ar]')].map((el, i) => {
    const g = (k) => el.querySelector(`[data-k=${k}]`);
    return {
      id: (S.st.autoReplies[i] || {}).id || Math.random().toString(36).slice(2),
      name: g('name').value, enabled: g('enabled').checked, keywords: g('keywords').value, cooldownMin: Number(g('cooldownMin').value) || 60,
      text: g('text').value, hours: { on: g('hoursOn').checked, from: g('hoursFrom').value, to: g('hoursTo').value },
      accountIds: [...el.querySelectorAll('[data-acc]:checked')].map((c) => c.dataset.acc),
    };
  });
}
function readTags() {
  return [...document.querySelectorAll('#tagTable tr[data-i]')].map((tr, i) => ({ id: (S.st.tags[i] || {}).id || Math.random().toString(36).slice(2), name: tr.querySelector('[data-k=name]').value.trim(), color: tr.querySelector('[data-k=color]').value })).filter((t) => t.name);
}

function updateText(u) {
  if (!u) return '';
  return { checking: 'Checking for updates...', latest: 'You have the latest version.', downloading: `Downloading update ${u.version || ''}${u.percent ? ' (' + u.percent + '%)' : ''}...`, ready: `Version ${u.version} is ready to install.`, error: 'Could not check for updates: ' + (u.error || ''), dev: 'Updates are turned off when running from source.', idle: '' }[u.state] || '';
}
function panelAbout() {
  const i = S.appInfo || {};
  const u = S.update || i.update || {};
  return `<div class="card"><h3>About and updates</h3>
    <div class="row"><span class="grow">Switchboard <b>${esc(i.version || '')}</b>${REMOTE ? ' (on your PC)' : ''}<div class="small">${esc(updateText(u))}</div></span>
    ${REMOTE && !NATIVE ? '' : (u.state === 'ready' ? '<button class="primary" id="installUpd">Restart and update</button>' : '<button class="ghost-btn" id="checkUpd">Check for updates</button>')}</div>
    ${REMOTE ? '' : '<div class="small">Switchboard checks for updates on its own every few hours and downloads them in the background.</div>'}</div>`;
}
function panelPhone() {
  const r = S.remote || {};
  const devs = r.devices || [];
  return `<div class="card"><h3>Phone</h3>
    <div class="small" style="margin-bottom:10px">Use all your accounts from the Switchboard Android app. Your accounts keep running on this PC; the phone connects to it. On the same Wi-Fi it works straight away. Away from home, install <a href="#" data-ext="https://tailscale.com/download">Tailscale</a> (free) on this PC and your phone and sign in to both with the same account.</div>
    <div class="row"><label class="switch"><input type="checkbox" id="phoneToggle" ${S.st.settings.phoneAccess ? 'checked' : ''}><span></span></label><span class="grow">Allow phone access${r.running ? ` <span class="small">(on port ${r.port})</span>` : ''}</span></div>
    <div class="row"><label class="switch"><input type="checkbox" data-set="phoneNotifications" ${S.st.settings.phoneNotifications !== false ? 'checked' : ''}><span></span></label><span class="grow">Send notifications to my phone when I'm not at the PC</span></div>
    <div class="btns" style="margin:10px 0"><button class="primary" id="pairPhone">Pair a phone</button><button class="ghost-btn" data-ext="https://github.com/rickbesada-netizen/Switchboard/releases/latest/download/Switchboard.apk">Get the Android app</button></div>
    ${devs.length ? `<table class="list"><tr><th>Paired phones</th><th>Last seen</th><th></th></tr>${devs.map((d) => `<tr><td>${esc(d.name)} ${d.online ? '<span class="state ok">connected</span>' : ''}</td><td class="small">${d.lastSeen ? new Date(d.lastSeen).toLocaleString() : '-'}</td><td><button class="danger-btn" data-revoke="${esc(d.id)}">Remove</button></td></tr>`).join('')}</table>` : '<div class="small">No phones paired yet.</div>'}
  </div>`;
}
// ---- Switchboard account (sign in on every device; which PC runs the accounts)
const NATIVE = window.sbNative || null;
async function loadAccount() {
  try {
    if (NATIVE) {
      S.cloud = await NATIVE.call('cloudStatus');
      S.cloudDevices = S.cloud.signedIn ? await NATIVE.call('cloudDevices') : [];
    } else if (window.sbAccount) {
      S.cloud = { signedIn: true, email: await window.sbAccount.email(), role: 'phone' };
      S.cloudDevices = await window.sbAccount.devices();
    }
  } catch (e) { S.cloud = S.cloud || {}; S.cloudErr = e.message; }
  if (S.view === 'settings') renderPanel();
}
function panelAccount() {
  const c = S.cloud;
  if (!c) { loadAccount(); return `<div class="card"><h3>Switchboard account</h3><div class="small">Loading...</div></div>`; }
  if (!c.signedIn) {
    if (!NATIVE) return '';
    return `<div class="card"><h3>Switchboard account</h3>
      <div class="small" style="margin-bottom:10px">Sign in on each of your PCs and on the Android app. Your best PC that's switched on runs your accounts; the others (and your phone) show everything from it, from anywhere. When you sign in on another PC, it receives your accounts and chats from the current one, encrypted with your password.</div>
      <div class="grid2"><label class="field"><span>Email</span><input id="acEmail" type="email" value="${esc(c.email || '')}"></label><label class="field"><span>Password</span><input id="acPass" type="password"></label></div>
      <div class="btns"><button class="primary" id="acSignIn">Sign in</button><button class="ghost-btn" id="acCreate">Create my account</button></div>
      <div class="small" style="margin-top:8px">Only one account can ever be created, so it's yours alone. Keep the password safe: it also unlocks your encrypted backups.</div></div>`;
  }
  const devs = S.cloudDevices || [];
  const pcs = devs.filter((d) => d.kind === 'pc');
  const phones = devs.filter((d) => d.kind === 'phone');
  const roleText = { host: 'This PC runs your accounts (host).', viewer: 'Another PC runs your accounts. This PC shows them from there.', phone: '' }[c.role] || '';
  return `<div class="card"><h3>Switchboard account</h3>
    <div class="row"><span class="grow">Signed in as <b>${esc(c.email || '')}</b><div class="small">${esc(roleText)}</div></span>
      ${NATIVE && c.role === 'viewer' ? '<button class="primary" id="acMakeHost">Run accounts on this PC</button>' : ''}
      <button class="ghost-btn" id="acSignOut">Sign out</button></div>
    ${pcs.length ? `<div class="small" style="margin:12px 0 4px">PCs, best first. The highest switched-on PC runs your accounts and takes over automatically when it comes online.</div>
      <div>${pcs.map((d, i) => `<div class="dev-row"><span class="grow"><b>${esc(d.name)}${d.me ? ' (this PC)' : ''}</b><span class="small">${d.host ? '<span class="state ok">running your accounts</span>' : d.online ? '<span class="state wait">on</span>' : '<span class="state">offline</span>'} · last seen ${new Date(d.last_seen).toLocaleString()}</span></span>
        ${NATIVE ? `<button class="icon-btn mini" data-prio="${i}" data-dir="-1" ${i === 0 ? 'disabled' : ''}>↑</button><button class="icon-btn mini" data-prio="${i}" data-dir="1" ${i === pcs.length - 1 ? 'disabled' : ''}>↓</button>${d.me ? '' : `<button class="danger-btn" data-rmdev="${esc(d.id)}">Remove</button>`}` : ''}</div>`).join('')}</div>` : ''}
    ${phones.length ? `<div class="small" style="margin:12px 0 4px">Phones</div>${phones.map((d) => `<div class="dev-row"><span class="grow"><b>${esc(d.name)}${d.me ? ' (this phone)' : ''}</b><span class="small">last seen ${new Date(d.last_seen).toLocaleString()}</span></span>${NATIVE ? `<button class="danger-btn" data-rmdev="${esc(d.id)}">Remove</button>` : ''}</div>`).join('')}` : ''}
  </div>`;
}
function panelSettings() {
  const s = S.st.settings;
  if (REMOTE) return `<h1>Settings</h1><div class="sub">Other settings are changed on the PC that runs your accounts.</div>${panelAccount()}${panelAbout()}`;
  const sw = (k, label, sub) => `<div class="row"><label class="switch"><input type="checkbox" data-set="${k}" ${s[k] ? 'checked' : ''}><span></span></label><div class="grow">${label}${sub ? `<div class="small">${sub}</div>` : ''}</div></div>`;
  return `<h1>Settings</h1><div class="sub">Defaults apply to every chat unless you change a chat in its info panel.</div>
    <div class="card"><h3>Privacy</h3>
      ${sw('ghostRead', 'Ghost read', 'Read messages without sending "Seen". Chats stay unread on the other app until you reply or press Mark as read.')}
      ${sw('hideTyping', 'Hide typing', 'Never show "typing..." to the other person.')}
      ${sw('keepDeleted', 'Keep deleted messages', 'When someone unsends a message, keep your saved copy (shown with a red "Deleted by sender" label).')}
    </div>
    ${panelAccount()}
    ${panelAbout()}
    ${panelPhone()}
    <div class="card"><h3>App</h3>
      ${sw('startWithWindows', 'Start Switchboard when Windows starts', 'Opens quietly in the tray so your accounts are always connected.')}
      ${sw('notifications', 'Desktop notifications')}
      ${sw('minimizeToTray', 'Keep running in the tray when the window is closed', 'Needed for scheduled items, auto-replies and catching deleted messages.')}
    </div>
    <div class="card"><h3>Trickster (optional)</h3>
      ${sw('tricksterEnabled', 'Connect to Trickster', 'Off: Switchboard uses its own login window and browser for each account. On: you can link an account to a Trickster profile, and its login and Instagram posting run inside that profile.')}
      <label class="field"><span>Trickster local API address</span><input data-set="tricksterApi" value="${esc(s.tricksterApi)}"></label>
      ${sw('closeTricksterAfter', 'Close the Trickster profile afterwards if Switchboard opened it')}
    </div>
    <div class="card"><h3>Hidden chats</h3>
      <div class="small" style="margin-bottom:8px">Hidden chats only appear under Folders → Hidden. They don't count as unread anywhere else.</div>
      ${sw('muteHidden', 'Mute notifications from hidden chats')}
      <div class="row"><input id="hidePinNew" type="password" inputmode="numeric" placeholder="${s.hiddenPinSet ? 'Passcode is set. Type a new one to change it' : 'Optional passcode to open Hidden'}" class="grow"><button class="ghost-btn" id="savePin">Set passcode</button>${s.hiddenPinSet ? '<button class="danger-btn" id="clearPin">Remove</button>' : ''}</div>
    </div>
    <div class="card"><h3>Messenger</h3>
      ${sw('messengerEncryptedHistory', 'Load encrypted chat history', 'Most Messenger chats are end-to-end encrypted. To load their history, Switchboard asks for your 6-digit Messenger backup PIN when you log in. Without it, only older non-encrypted chats show until a new message arrives. Changing this restarts Messenger accounts.')}
    </div>
    <div class="card"><h3>History</h3>
      <label class="field"><span>Messages to load per chat when an account is first connected</span><input data-set="backfillMessages" type="number" min="0" max="2000" value="${esc(s.backfillMessages || 200)}"></label>
    </div>
    <div class="btns"><button class="primary" id="saveSettings">Save settings</button><button class="ghost-btn" id="openData">Open data folder</button><button class="ghost-btn" data-view="engine">Engine and logs</button></div>`;
}

// panel events
$('#panel').addEventListener('change', async (e) => {
  if (e.target.id === 'phoneToggle') {
    S.remote = await call('remoteEnable', e.target.checked);
    S.st.settings.phoneAccess = e.target.checked;
    toast(e.target.checked ? 'Phone access on. Windows may ask to allow Switchboard on your network: click Allow.' : 'Phone access off');
    renderPanel();
    return;
  }
  if (S.view !== 'post') return;
  if (e.target.id === 'pAs' && e.target.value === '__add') { $('#addPageRow').classList.remove('hidden'); return; }
  if (['pAcc', 'pAs', 'pAud'].includes(e.target.id)) { readPostForm(); renderPanel(); }
});
$('#panel').addEventListener('click', async (e) => {
  const t = e.target;
  const v = t.closest('[data-view]');
  if (v) { e.preventDefault(); return showView(v.dataset.view); }
  const ext = t.closest('[data-ext]');
  if (ext) return call('openExternal', ext.dataset.ext);
  try {
    // engine
    if (t.id === 'bootBtn') { t.disabled = true; await call('restartEngines'); toast('Engines restarted'); t.disabled = false; }
    if (t.id === 'srvLog') logModal('App log', await call('stackLogs'));
    // accounts
    if (t.id === 'loadTrick') {
      const list = await call('tricksterProfiles');
      $('#aTrick').innerHTML = '<option value="">None</option>' + list.map((p) => `<option value="${esc(p.id)}">#${esc(p.id)} ${esc(p.name)}</option>`).join('');
      toast(`Loaded ${list.length} Trickster profiles`);
    }
    if (t.id === 'addAcc') {
      const payload = { network: $('#aNet').value, label: $('#aLabel').value.trim(), proxy: $('#aProxy').value.trim(), tricksterProfileId: ($('#aTrick') && $('#aTrick').value) || null };
      t.disabled = true;
      modal(`<h2>Setting up the bridge</h2><p class="small">Downloading and configuring. The first one can take a few minutes.</p><div class="logbox" id="mLog"></div><div class="modal-foot"><button class="ghost-btn" data-close>Close</button></div>`);
      S.modalLog = true;
      let acc;
      try { acc = await call('addAccount', payload); } finally { S.modalLog = false; t.disabled = false; }
      await refreshState();
      loginFlow(acc.id);
    }
    if (t.dataset.login) loginFlow(t.dataset.login);
    if (t.dataset.logout && confirm('Log this account out of the bridge?')) { await call('logoutAccount', t.dataset.logout); toast('Logged out'); }
    if (t.dataset.remove && confirm('Remove this account and its bridge? Saved chats stay in Switchboard.')) { toast('Removing...'); await call('removeAccount', t.dataset.remove); await refreshState(); toast('Removed'); }
    if (t.dataset.logs) logModal('Account log', await call('accountLogs', t.dataset.logs));
    if (t.dataset.edit) editAccount(t.dataset.edit);
    if (t.dataset.browser) await call('openAccountBrowser', t.dataset.browser);
    if (t.id === 'refreshAcc') { S.st.accounts = await call('refreshAccounts'); renderPanel(); }
    // post
    if (t.dataset.kind) { readPostForm(); postState().kind = t.dataset.kind; renderPanel(); }
    if (t.id === 'pPick') {
      readPostForm();
      const picked = REMOTE ? await window.sbPickFiles('image/*,video/*', true) : await call('pickMedia');
      S.igFiles = [...S.igFiles, ...picked];
      renderIgFiles();
    }
    if (t.id === 'pClear') { S.igFiles = []; renderIgFiles(); }
    if (t.id === 'savePage') {
      const P = readPostForm();
      const url = $('#newPageUrl').value.trim();
      if (!/^https?:\/\/(www\.|m\.|web\.)?facebook\.com\//i.test(url)) return toast('Paste the Page link, e.g. https://www.facebook.com/yourpage', true);
      const acc = account(P.accountId);
      const pages = [...((acc && acc.pages) || []), { name: $('#newPageName').value.trim() || url.replace(/^.*facebook\.com\//, ''), url }];
      const saved = await call('savePages', P.accountId, pages);
      acc.pages = saved;
      P.pageUrl = url;
      renderPanel();
      toast('Page added');
    }
    if (t.dataset.delpage) {
      e.preventDefault();
      const P = readPostForm();
      const acc = account(P.accountId);
      acc.pages = await call('savePages', P.accountId, (acc.pages || []).filter((p) => p.url !== t.dataset.delpage));
      renderPanel();
    }
    if (t.id === 'pTest' || t.id === 'pNow') {
      const job = igJob(t.id === 'pTest' ? { dryRun: true } : {});
      const err = checkJob(job);
      if (err) return toast(err, true);
      runIg(job);
    }
    if (t.id === 'pSched') {
      const job = igJob();
      const err = checkJob(job);
      if (err) return toast(err, true);
      const at = new Date(readPostForm().at).getTime();
      if (!at || at < Date.now()) return toast('Pick a time in the future', true);
      await call('scheduleAdd', { ...job, at });
      toast('Scheduled for ' + new Date(at).toLocaleString());
    }
    // schedule
    if (t.dataset.unsched) await call('scheduleRemove', t.dataset.unsched);
    if (t.id === 'clearDone') await call('scheduleClearDone');
    // automation
    if (t.id === 'addQr') { S.st.quickReplies = [...readQr(), { id: Math.random().toString(36).slice(2), shortcut: 'new', text: 'New quick reply' }]; renderPanel(); }
    if (t.dataset.delqr !== undefined) { const l = readQr(); l.splice(+t.dataset.delqr, 1); S.st.quickReplies = l; renderPanel(); }
    if (t.id === 'saveQr') { S.st.quickReplies = await call('saveList', 'quickReplies', readQr()); toast('Saved'); }
    if (t.id === 'addAr') { S.st.autoReplies = [...readAr(), { id: Math.random().toString(36).slice(2), name: 'After hours', enabled: false, keywords: '', cooldownMin: 240, text: "Thanks for your message! We're away right now and will reply first thing tomorrow.", hours: { on: true, from: '17:00', to: '09:00' }, accountIds: [] }]; renderPanel(); }
    if (t.dataset.delar !== undefined) { const l = readAr(); l.splice(+t.dataset.delar, 1); S.st.autoReplies = l; renderPanel(); }
    if (t.id === 'saveAr') { S.st.autoReplies = await call('saveList', 'autoReplies', readAr()); toast('Saved'); }
    if (t.id === 'addTag') { S.st.tags = [...readTags(), { id: Math.random().toString(36).slice(2), name: 'New folder', color: '#7c5cff' }]; renderPanel(); }
    if (t.dataset.deltag !== undefined) { const l = readTags(); l.splice(+t.dataset.deltag, 1); S.st.tags = l; renderPanel(); }
    if (t.id === 'saveTag') { S.st.tags = await call('saveList', 'tags', readTags()); toast('Saved'); renderRail(); renderRooms(); }
    // settings
    if (t.id === 'saveSettings') {
      const patch = {};
      document.querySelectorAll('[data-set]').forEach((el) => { patch[el.dataset.set] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value.trim(); });
      S.st.settings = await call('saveSettings', patch);
      toast('Settings saved');
      renderPanel();
    }
    if (t.id === 'openData') call('dataFolder');
    if (t.id === 'checkUpd') { S.update = await (NATIVE ? NATIVE.call('checkUpdates') : call('checkUpdates')); renderPanel(); }
    if (t.id === 'installUpd') { toast('Restarting to update...'); await (NATIVE ? NATIVE.call('installUpdate') : call('installUpdate')); }
    if (t.id === 'pairPhone') showPairing();
    if (t.id === 'acSignIn' || t.id === 'acCreate') {
      const email = $('#acEmail').value.trim();
      const pass = $('#acPass').value;
      if (!email || !pass) return toast('Enter your email and password', true);
      t.disabled = true;
      toast(t.id === 'acCreate' ? 'Creating your account...' : 'Signing in...');
      try { S.cloud = await NATIVE.call(t.id === 'acCreate' ? 'cloudCreateAccount' : 'cloudSignIn', email, pass); toast('Signed in'); } finally { t.disabled = false; }
      S.cloud = null;
      loadAccount();
    }
    if (t.id === 'acSignOut') {
      if (!confirm('Sign out of Switchboard on this device?')) return;
      if (NATIVE) { toast('Signing out...'); await NATIVE.call('cloudSignOut'); S.cloud = null; loadAccount(); }
      else if (window.sbAccount) await window.sbAccount.signOut();
    }
    if (t.id === 'acMakeHost') { await NATIVE.call('cloudMakeHost'); toast('Asked the current PC to hand over. This takes about a minute.'); }
    if (t.dataset.prio !== undefined) {
      const pcs = (S.cloudDevices || []).filter((d) => d.kind === 'pc');
      const i = +t.dataset.prio; const j = i + +t.dataset.dir;
      [pcs[i], pcs[j]] = [pcs[j], pcs[i]];
      S.cloudDevices = [...(await NATIVE.call('cloudSetPriorities', pcs.map((d) => d.id)))];
      renderPanel();
    }
    if (t.dataset.rmdev) { if (confirm('Remove this device from your account?')) { S.cloudDevices = await NATIVE.call('cloudRemoveDevice', t.dataset.rmdev); renderPanel(); } }
    if (t.dataset.revoke) { S.remote = await call('remoteRevoke', t.dataset.revoke); renderPanel(); toast('Phone removed'); }
    if (t.id === 'savePin') {
      const v = $('#hidePinNew').value.trim();
      if (v.length < 4) return toast('Use at least 4 characters', true);
      S.st.settings = await call('setHiddenPin', v);
      S.hiddenUnlocked = false;
      toast('Passcode set');
      renderPanel();
    }
    if (t.id === 'clearPin') { S.st.settings = await call('setHiddenPin', ''); toast('Passcode removed'); renderPanel(); }
  } catch (er) {
    if (S.modalLog === false && !$('#modal').classList.contains('hidden') && $('#mLog')) $('#mLog').textContent += '\nError: ' + er.message;
    toast(er.message, true);
  }
});

async function showPairing() {
  try {
    const p = await call('remoteNewPairing');
    S.remote = await call('remoteInfo');
    const addrs = (S.remote.addresses || []).map((a) => `${a.url}${a.kind === 'tailscale' ? ' (Tailscale, works anywhere)' : ' (home Wi-Fi)'}`).join('<br>');
    modal(`<h2>Pair your phone</h2>
      <ol class="small" style="line-height:1.8;padding-left:18px;margin:6px 0 10px">
        <li>Install the Switchboard app on your Android phone (<a href="#" data-ext="https://github.com/rickbesada-netizen/Switchboard/releases/latest/download/Switchboard.apk">download</a>).</li>
        <li>Open it and tap <b>Scan QR code</b>, then point it at this code.</li></ol>
      <img class="qrbox" src="${p.qr}" style="margin:0 auto">
      <p class="small" style="margin-top:10px">Phone not on the same Wi-Fi as this PC? Use Tailscale (see Settings → Phone). Addresses:<br>${addrs || 'No network found'}</p>
      <p class="small">This code works once and expires in 30 minutes.</p>
      <div class="modal-foot"><button class="primary" data-close>Done</button></div>`);
  } catch (e) { toast(e.message, true); }
}
function renderUpdatePill() {
  const el = $('#updatePill');
  const u = S.update || {};
  if ((REMOTE && !NATIVE) || !['downloading', 'ready'].includes(u.state)) return el.classList.add('hidden');
  el.classList.remove('hidden');
  el.classList.toggle('ready', u.state === 'ready');
  el.textContent = u.state === 'ready' ? `⬆ Update ${u.version} ready · Restart` : `⬇ Downloading update${u.percent ? ' ' + u.percent + '%' : ''}...`;
}
$('#updatePill').addEventListener('click', async () => {
  if ((S.update || {}).state === 'ready') { toast('Restarting to update...'); await (NATIVE ? NATIVE.call('installUpdate') : call('installUpdate')).catch((e) => toast(e.message, true)); }
  else showView('settings');
});
window.sb.on('remote-info', (r) => { S.remote = r; S.st.settings.phoneAccess = r.enabled; if (S.view === 'settings') renderPanel(); });
window.sb.on('update', (u) => { S.update = u; renderUpdatePill(); if (S.view === 'settings') renderPanel(); });
window.__sbReconnected = () => { refreshState().then(() => { if (S.current) call('messages', S.current).then((m) => { S.msgs = m; renderMessages(true); }); }); };

function logModal(title, text) {
  modal(`<h2>${esc(title)}</h2><div class="logbox" style="max-height:60vh">${esc(text || 'Empty')}</div><div class="modal-foot"><button class="primary" data-close>Close</button></div>`);
  const lb = document.querySelector('#modalCard .logbox');
  lb.scrollTop = lb.scrollHeight;
}
function editAccount(id) {
  const a = account(id);
  modal(`<h2>Edit ${esc(a.label)}</h2>
    <label class="field"><span>Name</span><input id="eLabel" value="${esc(a.label)}"></label>
    <label class="field"><span>Proxy</span><input id="eProxy" value="${esc(a.proxy || '')}" placeholder="http://user:pass@host:port"></label>
    ${S.st.settings.tricksterEnabled ? `<label class="field"><span>Trickster profile ID (empty = Switchboard's own login)</span><input id="eTrick" value="${esc(a.tricksterProfileId || '')}"></label>` : ''}
    <div class="field"><span>Put new chats from this account in</span><div class="tagsel">${(S.st.tags || []).map((t) => `<label class="small" style="display:flex;gap:4px;align-items:center;margin-right:10px"><input type="checkbox" data-deffolder="${esc(t.id)}" ${(a.defaultFolders || []).includes(t.id) ? 'checked' : ''}> ${esc(t.name)}</label>`).join('')}</div>
      <label class="small" style="display:flex;gap:6px;align-items:center;margin-top:6px"><input type="checkbox" id="eApplyOld"> Also put this account's existing chats that have no folder there</label></div>
    <div class="small">Changing the proxy restarts this account's engine.</div>
    <div class="modal-foot"><button class="ghost-btn" data-close>Cancel</button><button class="primary" id="eSave">Save</button></div>`);
  $('#eSave').onclick = async () => {
    $('#eSave').disabled = true;
    try {
      await call('updateAccount', id, { label: $('#eLabel').value.trim(), proxy: $('#eProxy').value.trim(), ...($('#eTrick') ? { tricksterProfileId: $('#eTrick').value.trim() || null } : {}), defaultFolders: [...document.querySelectorAll('[data-deffolder]:checked')].map((c) => c.dataset.deffolder), applyFoldersToExisting: $('#eApplyOld').checked });
      closeModal(); await refreshState(); toast('Saved');
    } catch (e) { toast(e.message, true); $('#eSave').disabled = false; }
  };
}

// ------------------------------------------------------------------ login flow UI
let loginCtx = null;
function loginFlow(accId, opts) {
  const a = account(accId);
  loginCtx = { accId };
  modal(`<h2>Log in: ${esc(a ? a.label : '')}</h2><div id="lBody"><p><span class="spinner"></span> Starting...</p></div><div class="modal-foot" id="lFoot"><button class="ghost-btn" data-close>Close</button></div>`);
  call('loginAccount', accId, opts || {}).then(async () => {
    $('#lBody').innerHTML = '<p>✅ Logged in. Your chats will appear in the inbox over the next few minutes as history syncs.</p>';
    $('#lFoot').innerHTML = '<button class="primary" data-close>Done</button>';
    loginCtx = null;
    await refreshState();
  }).catch((e) => {
    if (!$('#lBody')) return;
    const net = a && a.network;
    $('#lBody').innerHTML = `<div class="notice">${esc(e.message)}</div>`;
    $('#lFoot').innerHTML = `${net !== 'whatsapp' ? '<button class="ghost-btn" id="lPaste">Paste cookies instead</button>' : ''}<button class="ghost-btn" id="lLog">Log</button><button class="primary" id="lRetry">Try again</button><button class="ghost-btn" data-close>Close</button>`;
    $('#lRetry').onclick = () => loginFlow(accId, opts);
    $('#lLog').onclick = async () => logModal('Account log', await call('accountLogs', accId));
    if ($('#lPaste')) $('#lPaste').onclick = () => pasteCookies(accId);
    loginCtx = null;
  });
}
function pasteCookies(accId) {
  const a = account(accId);
  const site = (NETS()[a.network] || {}).cookieSite;
  modal(`<h2>Paste cookies</h2><p class="small">Log in to ${esc(site)} in a browser, export cookies as JSON (a cookie-editor extension works), and paste below.</p>
    <textarea id="ckText" rows="8" style="width:100%" placeholder='[{"name":"sessionid","value":"..."}]  or  name=value; name2=value2'></textarea>
    <div class="modal-foot"><button class="ghost-btn" data-close>Cancel</button><button class="primary" id="ckGo">Log in</button></div>`);
  $('#ckGo').onclick = () => loginFlow(accId, { cookiesText: $('#ckText').value });
}
window.sb.on('login-step', (s) => {
  if (!loginCtx || s.accId !== loginCtx.accId || !$('#lBody')) return;
  const ins = s.instructions ? `<p class="small">${esc(s.instructions)}</p>` : '';
  if (s.qr) $('#lBody').innerHTML = `<p>Open WhatsApp on your phone → <b>Settings → Linked devices → Link a device</b>, then scan:</p><img class="qrimg" src="${s.qr}">${ins}<p class="small"><span class="spinner"></span> Waiting for scan... the code refreshes by itself.</p>`;
  else if (s.code) $('#lBody').innerHTML = `${ins}<div class="code">${esc(s.code)}</div><p class="small"><span class="spinner"></span> Waiting...</p>`;
  else if (s.text) $('#lBody').innerHTML = `<p><span class="spinner"></span> ${esc(s.text)}</p>`;
});
window.sb.on('login-ask', (q) => {
  const fields = q.fields || [];
  const box = $('#lBody') || $('#modalCard');
  box.innerHTML = `${q.instructions ? `<p class="small">${esc(q.instructions)}</p>` : ''}${fields.map((f) => f.type === 'cookies_paste'
    ? `<label class="field"><span>${esc(f.name)}</span><textarea data-f="${esc(f.id)}" rows="7"></textarea></label>`
    : `<label class="field"><span>${esc(f.name || f.id)}${f.description ? ` <span class="small">${esc(f.description)}</span>` : ''}${f.optional ? ' <span class="small">(optional, leave empty to skip)</span>' : ''}</span><input data-f="${esc(f.id)}" type="${f.type === 'password' ? 'password' : 'text'}" placeholder="${esc(f.placeholder || '')}"></label>`).join('')}
    <div class="modal-foot"><button class="ghost-btn" id="askCancel">Cancel</button><button class="primary" id="askOk">Continue</button></div>`;
  $('#askOk').onclick = () => {
    const ans = {};
    box.querySelectorAll('[data-f]').forEach((el) => { ans[el.dataset.f] = el.value; });
    box.innerHTML = '<p><span class="spinner"></span> Checking...</p>';
    call('loginAnswer', q.id, ans);
  };
  $('#askCancel').onclick = () => { call('loginAnswer', q.id, null); };
});

$('#modal').addEventListener('click', (e) => {
  if (e.target.closest('[data-close]')) closeModal();
});

// ------------------------------------------------------------------ events from main
async function refreshState() {
  S.st = await call('state');
  S.stack.status = S.st.stackStatus;
  S.rooms = new Map(S.st.rooms.map((r) => [r.id, r]));
  $('#ghostDefaultTxt').textContent = S.st.settings.ghostRead ? 'on' : 'off';
  renderRail();
  if (S.view === 'inbox') { renderRooms(); if (S.current) { renderHead(); renderDrawer(); } } else renderPanel();
}
window.sb.on('state', (st) => { S.st = st; S.rooms = new Map(st.rooms.map((r) => [r.id, r])); renderRail(); if (S.view === 'inbox') renderRooms(); });
window.sb.on('room', (r) => {
  if (r.hidden) S.rooms.delete(r.id);
  else S.rooms.set(r.id, r);
  if (r.id === S.current) { renderHead(); renderTyping(); if (!document.activeElement || document.activeElement.id !== 'dNote') renderDrawer(); }
  renderRooms();
  renderRail();
});
let msgRaf = 0;
window.sb.on('msg', (roomId, m, kind) => {
  if (roomId !== S.current) return;
  const i = S.msgs.findIndex((x) => x.id === m.id);
  if (i >= 0) S.msgs[i] = m;
  else {
    S.msgs.push(m);
    S.msgs.sort((a, b) => a.ts - b.ts);
    if (S.view === 'inbox' && document.hasFocus()) call('focusRoom', roomId);
  }
  cancelAnimationFrame(msgRaf);
  msgRaf = requestAnimationFrame(() => renderMessages(kind === 'new' && m.mine));
});
window.sb.on('accounts', (accs) => { if (!S.st) return; S.st.accounts = accs; renderRail(); if (S.view === 'accounts') renderPanel(); });
window.sb.on('schedule', (list) => { if (!S.st) return; S.st.schedule = list; renderRail(); if (S.view === 'scheduled') renderPanel(); });
window.sb.on('stack-status', (s) => {
  S.stack = s;
  if (!S.st) return;
  S.st.stackStatus = s.status;
  renderRail();
  if (['engine', 'accounts'].includes(S.view)) renderPanel();
});
window.sb.on('log', (line) => {
  S.logs.push(line);
  if (S.logs.length > 2000) S.logs.splice(0, 500);
  const lb = $('#logbox');
  if (lb && S.view === 'engine') { lb.textContent += (lb.textContent === 'Nothing yet.' ? '' : '\n') + line; lb.scrollTop = lb.scrollHeight; }
  const ml = $('#mLog');
  if (ml) { ml.textContent += line + '\n'; ml.scrollTop = ml.scrollHeight; }
});
window.sb.on('ig-log', (line) => {
  S.igLog.push(line);
  const el = $('#igLog');
  if (el) { el.textContent = S.igLog.join('\n'); el.scrollTop = el.scrollHeight; }
});
window.sb.on('open-room', (id) => openRoom(id));
window.sb.on('sync-status', (s) => {
  const e = $('#engineStatus');
  if (e && S.stack.status === 'running') e.title = s.online ? 'Connected' : 'Reconnecting: ' + (s.error || '');
});
window.addEventListener('focus', () => { if (S.current && S.view === 'inbox') call('focusRoom', S.current); });

(async function start() {
  await refreshState();
  try { S.appInfo = await (NATIVE ? NATIVE.call('appInfo') : call('appInfo')); S.update = S.appInfo.update; renderUpdatePill(); } catch {}
  if (NATIVE) NATIVE.on('update', (u) => { S.update = u; renderUpdatePill(); });
  const hm = /room=([^&]+)/.exec(location.hash);
  if (hm) { showView('inbox'); openRoom(decodeURIComponent(hm[1])); history.replaceState(null, '', location.pathname); return; }
  showView((S.st.accounts || []).length ? 'inbox' : 'accounts');
})();
