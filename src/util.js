const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let DATA = null;

function init(dir) {
  DATA = dir;
  fs.mkdirSync(dir, { recursive: true });
}

function p(...parts) {
  return path.join(DATA, ...parts);
}

function readJSON(file, def) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return def;
  }
}

function writeJSON(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, file);
}

function rand(n = 32) {
  return crypto.randomBytes(n * 2).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, n);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function safeName(s) {
  return String(s).replace(/[^a-zA-Z0-9._-]/g, '_');
}

// Standard Matrix localpart escaping used by mautrix for ghost user IDs
function escapeLocalpart(s) {
  let out = '';
  for (const ch of String(s)) {
    if (/[a-z0-9._\-\/]/.test(ch)) out += ch;
    else if (/[A-Z]/.test(ch)) out += '_' + ch.toLowerCase();
    else if (ch === '_') out += '__';
    else out += [...Buffer.from(ch)].map((b) => '=' + b.toString(16).padStart(2, '0')).join('');
  }
  return out;
}

const MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska',
  mp3: 'audio/mpeg', ogg: 'audio/ogg', m4a: 'audio/mp4', wav: 'audio/wav', opus: 'audio/ogg',
  pdf: 'application/pdf', txt: 'text/plain', zip: 'application/zip', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
function mimeOf(file) {
  const ext = path.extname(file).slice(1).toLowerCase();
  return MIME[ext] || 'application/octet-stream';
}

module.exports = { init, p, readJSON, writeJSON, rand, sleep, safeName, escapeLocalpart, mimeOf, get DATA() { return DATA; } };
