// Local copy of every chat and message. This is what makes "keep deleted messages" and
// "edit history" work: we save messages the moment they arrive, and when a sender unsends or
// edits, we keep our saved original instead of throwing it away.
const fs = require('fs');
const { EventEmitter } = require('events');
const U = require('./util');

const MAX_PER_ROOM = 20000;

function stripReplyFallback(body) {
  const lines = String(body || '').split('\n');
  let i = 0;
  while (i < lines.length && lines[i].startsWith('>')) i++;
  if (i > 0 && lines[i] === '') i++;
  return i > 0 ? lines.slice(i).join('\n') : body;
}

class Store extends EventEmitter {
  constructor() {
    super();
    fs.mkdirSync(U.p('chats', 'msgs'), { recursive: true });
    this.roomsFile = U.p('chats', 'rooms.json');
    this.rooms = U.readJSON(this.roomsFile, {});
    this.msgs = {};
    this.idx = {};
    this.reactIdx = {};
    this.dirtyRooms = new Set();
    this.roomsDirty = false;
    this.timer = setInterval(() => this.flush(), 1500);
  }

  // Re-read everything from disk (after another PC's data has been restored here)
  reload() {
    this.rooms = U.readJSON(this.roomsFile, {});
    this.msgs = {};
    this.idx = {};
    this.reactIdx = {};
    this.dirtyRooms.clear();
    this.roomsDirty = false;
  }

  room(id) {
    if (!this.rooms[id]) {
      this.rooms[id] = {
        id, explicitName: '', avatar: null, members: {}, receipts: {}, typing: [], heroes: [],
        tags: [], note: '', ghost: null, hideTyping: null, pinned: false, archived: false,
        unread: 0, lastTs: 0, lastPreview: '', createdType: null, accountId: null, protocol: null,
        prevBatch: null, left: false,
      };
      this.roomsDirty = true;
    }
    return this.rooms[id];
  }

  messages(roomId) {
    if (!this.msgs[roomId]) {
      const list = U.readJSON(U.p('chats', 'msgs', U.safeName(roomId) + '.json'), []);
      this.msgs[roomId] = list;
      const idx = new Map();
      const ridx = new Map();
      for (const m of list) {
        idx.set(m.id, m);
        for (const [key, arr] of Object.entries(m.reactions || {})) for (const r of arr) ridx.set(r.id, { target: m.id, key });
      }
      this.idx[roomId] = idx;
      this.reactIdx[roomId] = ridx;
    }
    return this.msgs[roomId];
  }
  find(roomId, eventId) {
    this.messages(roomId);
    return this.idx[roomId].get(eventId);
  }
  touch(roomId) {
    this.dirtyRooms.add(roomId);
    this.roomsDirty = true;
  }

  flush() {
    if (this.roomsDirty) {
      this.roomsDirty = false;
      try { U.writeJSON(this.roomsFile, this.rooms); } catch {}
    }
    for (const id of this.dirtyRooms) {
      try { U.writeJSON(U.p('chats', 'msgs', U.safeName(id) + '.json'), this.msgs[id] || []); } catch {}
    }
    this.dirtyRooms.clear();
  }

  applyState(roomId, ev) {
    const r = this.room(roomId);
    const c = ev.content || {};
    switch (ev.type) {
      case 'm.room.name': r.explicitName = c.name || ''; break;
      case 'm.room.avatar': r.avatar = c.url || null; break;
      case 'm.room.create': r.createdType = c.type || null; break;
      case 'm.room.member':
        r.members[ev.state_key] = { name: c.displayname || (r.members[ev.state_key] || {}).name || null, avatar: c.avatar_url || null, membership: c.membership };
        break;
      case 'm.bridge':
      case 'uk.half-shot.bridge':
        r.protocol = (c.protocol && c.protocol.id) || r.protocol;
        break;
      default: return;
    }
    this.roomsDirty = true;
  }

  insert(roomId, msg) {
    const list = this.messages(roomId);
    if (this.idx[roomId].has(msg.id)) return false;
    if (!list.length || list[list.length - 1].ts <= msg.ts) list.push(msg);
    else {
      let i = list.length - 1;
      while (i > 0 && list[i - 1].ts > msg.ts) i--;
      list.splice(i, 0, msg);
    }
    if (list.length > MAX_PER_ROOM) {
      const gone = list.splice(0, list.length - MAX_PER_ROOM);
      for (const g of gone) this.idx[roomId].delete(g.id);
    }
    this.idx[roomId].set(msg.id, msg);
    this.touch(roomId);
    return true;
  }

  // Returns {kind, msg} or null
  applyTimeline(roomId, ev) {
    const c = ev.content || {};
    const rel = c['m.relates_to'] || {};

    if (ev.type === 'm.room.redaction') {
      const target = ev.redacts || c.redacts;
      const ridx = (this.messages(roomId), this.reactIdx[roomId]);
      if (ridx.has(target)) {
        const { target: mid, key } = ridx.get(target);
        const m = this.find(roomId, mid);
        if (m && m.reactions[key]) {
          m.reactions[key] = m.reactions[key].filter((x) => x.id !== target);
          if (!m.reactions[key].length) delete m.reactions[key];
        }
        ridx.delete(target);
        this.touch(roomId);
        return m ? { kind: 'update', msg: m } : null;
      }
      const m = this.find(roomId, target);
      if (m && !m.deleted) {
        m.deleted = true;
        m.deletedAt = ev.origin_server_ts;
        m.deletedBy = ev.sender;
        this.touch(roomId);
        return { kind: 'delete', msg: m };
      }
      return null;
    }

    if (ev.type === 'm.reaction') {
      if (!rel.event_id || !rel.key) return null;
      const m = this.find(roomId, rel.event_id);
      if (!m) return null;
      m.reactions = m.reactions || {};
      const arr = (m.reactions[rel.key] = m.reactions[rel.key] || []);
      if (!arr.some((x) => x.id === ev.event_id)) arr.push({ id: ev.event_id, sender: ev.sender });
      this.reactIdx[roomId].set(ev.event_id, { target: m.id, key: rel.key });
      this.touch(roomId);
      return { kind: 'update', msg: m };
    }

    if (ev.type !== 'm.room.message' && ev.type !== 'm.sticker') return null;

    // Edit
    if (rel.rel_type === 'm.replace' && rel.event_id) {
      const m = this.find(roomId, rel.event_id);
      const nc = c['m.new_content'] || c;
      if (!m) return null;
      if ((m.edits || []).some((e) => e.id === ev.event_id)) return null;
      m.edits = m.edits || [];
      m.edits.push({ id: ev.event_id, ts: ev.origin_server_ts, body: m.body });
      m.body = nc.body || '';
      m.html = nc.format === 'org.matrix.custom.html' ? nc.formatted_body : undefined;
      m.edited = true;
      this.touch(roomId);
      return { kind: 'edit', msg: m };
    }

    const redactedBecause = ev.unsigned && ev.unsigned.redacted_because;
    if (redactedBecause && !c.msgtype && !c.body) {
      // Already deleted before we ever saw it
      const existing = this.find(roomId, ev.event_id);
      if (existing) return null;
      const msg = { id: ev.event_id, sender: ev.sender, ts: ev.origin_server_ts, type: 'm.text', body: '', deleted: true, lost: true, reactions: {}, edits: [] };
      this.insert(roomId, msg);
      return { kind: 'new', msg };
    }

    const replyTo = rel['m.in_reply_to'] && rel['m.in_reply_to'].event_id;
    const msg = {
      id: ev.event_id,
      sender: ev.sender,
      ts: ev.origin_server_ts,
      type: ev.type === 'm.sticker' ? 'm.image' : c.msgtype || 'm.text',
      body: replyTo ? stripReplyFallback(c.body) : c.body || '',
      url: c.url || (c.file && c.file.url) || undefined,
      info: c.info ? { mimetype: c.info.mimetype, size: c.info.size, w: c.info.w, h: c.info.h, duration: c.info.duration } : undefined,
      filename: c.filename || undefined,
      replyTo: replyTo || undefined,
      reactions: {},
      edits: [],
      deleted: false,
    };
    if (c.format === 'org.matrix.custom.html' && !replyTo) msg.html = c.formatted_body;
    if (!this.insert(roomId, msg)) return null;
    return { kind: 'new', msg };
  }
}

module.exports = { Store };
