'use strict';
/*
 * Kanban + Timeline Phase
 * Tanpa dependency: hanya modul bawaan Node. Data disimpan di satu file JSON.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

// Muat file .env lokal secara otomatis jika ada (tanpa dependency dotenv)
const ENV_FILE = path.join(__dirname, '.env');
if (fs.existsSync(ENV_FILE)) {
  for (const line of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const k = trimmed.slice(0, eq).trim();
    let v = trimmed.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

const PORT = parseInt(process.env.PORT, 10) || 3000;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const DB_FILE = path.join(DATA_DIR, 'db.json');
const MAX_BODY = 5 * 1024 * 1024;
const LOG_LIMIT = 500;
const DAY = 86400000;

/* ---------- multi-user dari environment variable ---------- */
// Format APP_USERS: "iqbal:pass123,budi:pass456,sari:pass789" (mendukung pemisah koma, titik koma, atau baris baru)
// Tetap kompatibel dengan APP_USER & APP_PASSWORD tunggal.
function loadUsersFromEnv() {
  const map = new Map();
  const rawList = process.env.APP_USERS || '';
  for (const part of rawList.split(/[,;\r\n]+/)) {
    const item = part.trim();
    if (!item) continue;
    const idx = item.indexOf(':');
    if (idx <= 0) continue;
    const u = item.slice(0, idx).trim();
    const p = item.slice(idx + 1).trim();
    if (u && p) map.set(u, p);
  }
  const singleUser = (process.env.APP_USER || 'admin').trim();
  const singlePass = (process.env.APP_PASSWORD || '').trim();
  if (singlePass && !map.has(singleUser)) {
    map.set(singleUser, singlePass);
  }
  return map;
}

const USERS = loadUsersFromEnv();
const AUTH_REQUIRED = USERS.size > 0;
const TOKEN_SECRET = crypto
  .createHash('sha256')
  .update(AUTH_REQUIRED ? Array.from(USERS.entries()).map(([u, p]) => `${u}:${p}`).join('|') : 'open-mode-secret')
  .digest();

const TASK_STATUS = ['todo', 'doing', 'review', 'done'];
const PRIORITY = ['low', 'medium', 'high'];
const PHASE_STATUS = ['planned', 'active', 'done'];

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (m) => new HttpError(400, m);
const conflict = (m) => new HttpError(409, m);
const notFound = (m) => new HttpError(404, m);
const forbidden = (m) => new HttpError(403, m);

/* ---------- util ---------- */
const uid = () => crypto.randomBytes(4).toString('hex');
const now = () => new Date().toISOString();
const str = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'));
const addDays = (s, n) => new Date(Date.parse(s + 'T00:00:00Z') + n * DAY).toISOString().slice(0, 10);
const diffDays = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / DAY);
const todayStr = () => new Date().toISOString().slice(0, 10);

/* ---------- database ---------- */
function seed() {
  const t = todayStr();
  return {
    rev: 1,
    phases: [{ id: uid(), name: 'Phase 1', goal: '', start: t, end: addDays(t, 13), status: 'active', locked: false, approvedAt: null, baselineCount: 0 }],
    tasks: [], changes: [], log: [],
  };
}

function normalize(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) throw new Error('format data tidak valid');
  for (const k of ['phases', 'tasks', 'changes', 'log']) {
    if (d[k] !== undefined && !Array.isArray(d[k])) throw new Error(`"${k}" harus berupa array`);
  }
  const phases = (d.phases || []).map((p, i) => {
    if (!p || !p.id || !str(p.name) || !isDate(p.start) || !isDate(p.end)) throw new Error(`phase #${i + 1} tidak valid`);
    return {
      id: String(p.id), name: str(p.name, 80), goal: str(p.goal, 500), start: p.start, end: p.end,
      status: PHASE_STATUS.includes(p.status) ? p.status : 'planned',
      locked: !!p.locked, approvedAt: p.approvedAt || null, baselineCount: Number.isInteger(p.baselineCount) ? p.baselineCount : 0,
    };
  });
  const ids = new Set(phases.map((p) => p.id));
  const tasks = (d.tasks || []).map((t, i) => {
    if (!t || !t.id || !str(t.title) || !ids.has(t.phaseId)) throw new Error(`task #${i + 1} tidak valid`);
    const links = Array.isArray(t.links)
      ? t.links.filter((l) => l && str(l.url, 1000)).slice(0, 20).map((l) => ({
          id: String(l.id || uid()),
          title: str(l.title, 120) || str(l.url, 120),
          url: str(l.url, 1000),
        }))
      : [];
    const rawComments = Array.isArray(t.comments) ? t.comments : (Array.isArray(t.updates) ? t.updates : []);
    const comments = rawComments
      .filter((c) => c && str(c.text, 1000))
      .slice(0, 100)
      .map((c) => ({
        id: String(c.id || uid()),
        user: str(c.user || c.role, 60) || 'user',
        text: str(c.text, 1000),
        ts: typeof c.ts === 'string' ? c.ts : now(),
      }));
    const rawBlockers = Array.isArray(t.blockers)
      ? t.blockers
      : (typeof t.blocker === 'string' && t.blocker.trim() ? [{ id: uid(), text: t.blocker.trim(), by: 'tim', ts: t.updatedAt || now() }] : []);
    const blockers = rawBlockers
      .filter((b) => b && str(b.text, 500))
      .slice(0, 30)
      .map((b) => ({
        id: String(b.id || uid()),
        text: str(b.text, 500),
        by: str(b.by, 60) || 'tim',
        ts: typeof b.ts === 'string' ? b.ts : now(),
      }));
    let assignees = [];
    if (Array.isArray(t.assignees)) {
      assignees = t.assignees.map((x) => str(x, 60)).filter(Boolean);
    } else if (typeof t.assignee === 'string' && t.assignee.trim()) {
      assignees = t.assignee.split(/[,;]+/).map((x) => str(x.trim(), 60)).filter(Boolean);
    }
    return {
      id: String(t.id), phaseId: t.phaseId, title: str(t.title, 200), desc: str(t.desc, 4000),
      blockers,
      links, comments,
      status: TASK_STATUS.includes(t.status) ? t.status : 'todo',
      priority: PRIORITY.includes(t.priority) ? t.priority : 'medium',
      assignees,
      assignee: assignees.join(', '),
      due: isDate(t.due) ? t.due : '',
      origin: t.origin === 'change' ? 'change' : 'baseline', crId: t.crId || null,
      createdAt: t.createdAt || now(), updatedAt: t.updatedAt || now(),
      order: Number.isFinite(t.order) ? t.order : i,
    };
  });
  const changes = (d.changes || []).map((c, i) => {
    if (!c || !c.id || !str(c.title)) throw new Error(`change request #${i + 1} tidak valid`);
    return {
      id: String(c.id), title: str(c.title, 200), desc: str(c.desc, 4000), requestedBy: str(c.requestedBy, 80),
      reason: str(c.reason, 1000), phaseId: c.phaseId || null, phaseName: str(c.phaseName, 80),
      status: ['pending', 'approved', 'rejected'].includes(c.status) ? c.status : 'pending',
      decision: ['current', 'next'].includes(c.decision) ? c.decision : null,
      decidedPhaseId: c.decidedPhaseId || null, decidedPhaseName: str(c.decidedPhaseName, 80),
      decisionNote: str(c.decisionNote, 1000), extendDays: Number.isInteger(c.extendDays) ? c.extendDays : 0,
      taskId: c.taskId || null, createdAt: c.createdAt || now(), decidedAt: c.decidedAt || null,
    };
  });
  const log = (d.log || []).filter((l) => l && typeof l.ts === 'string' && typeof l.text === 'string').slice(0, LOG_LIMIT);
  return { rev: Number.isInteger(d.rev) ? d.rev : 1, phases, tasks, changes, log };
}

function load() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) return seed();
  try {
    return normalize(JSON.parse(fs.readFileSync(DB_FILE, 'utf8')));
  } catch (e) {
    console.error(`[!] ${DB_FILE} tidak bisa dibaca: ${e.message}`);
    try {
      const d = normalize(JSON.parse(fs.readFileSync(DB_FILE + '.bak', 'utf8')));
      console.error('[!] Memakai db.json.bak sebagai gantinya.');
      return d;
    } catch (_) {
      console.error('[!] Backup juga tidak bisa dibaca. Server dihentikan supaya data tidak tertimpa.');
      process.exit(1);
    }
  }
}

let db = load();
let lastBackup = 0;

function backupNow() {
  if (fs.existsSync(DB_FILE)) { fs.copyFileSync(DB_FILE, DB_FILE + '.bak'); lastBackup = Date.now(); }
}

function save() {
  db.rev++;
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 1));
  if (Date.now() - lastBackup > 3600e3) backupNow();
  fs.renameSync(tmp, DB_FILE);
}

function addLog(text, user) {
  const suffix = user ? ` (oleh ${user})` : '';
  db.log.unshift({ ts: now(), text: text + suffix });
  if (db.log.length > LOG_LIMIT) db.log.length = LOG_LIMIT;
}

/* ---------- auth & session helper ---------- */
const safeEq = (a, b) => crypto.timingSafeEqual(
  crypto.createHash('sha256').update(String(a)).digest(),
  crypto.createHash('sha256').update(String(b)).digest(),
);

function signUser(username) {
  const sig = crypto.createHmac('sha256', TOKEN_SECRET).update(username).digest('base64url');
  return `${encodeURIComponent(username)}.${sig}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  let username;
  try { username = decodeURIComponent(token.slice(0, dot)); } catch (_) { return null; }
  const sig = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', TOKEN_SECRET).update(username).digest('base64url');
  if (!safeEq(sig, expected)) return null;
  if (AUTH_REQUIRED && !USERS.has(username)) return null;
  return username;
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

function checkCredentials(username, password) {
  for (const [u, p] of USERS.entries()) {
    if (safeEq(u, username) && safeEq(p, password)) return u;
  }
  return null;
}

function getAuthUser(req) {
  const cookies = parseCookies(req);
  if (cookies.pb_session) {
    const u = verifyToken(cookies.pb_session);
    if (u) return u;
  }
  const h = req.headers.authorization || '';
  if (h.startsWith('Basic ')) {
    const raw = Buffer.from(h.slice(6), 'base64').toString('utf8');
    const i = raw.indexOf(':');
    if (i >= 0) {
      const u = raw.slice(0, i);
      const p = raw.slice(i + 1);
      if (AUTH_REQUIRED) {
        const matched = checkCredentials(u, p);
        if (matched) return matched;
      } else if (u.trim()) {
        return str(u, 60);
      }
    }
  }
  if (!AUTH_REQUIRED) {
    return 'admin';
  }
  return null;
}

/* ---------- domain helpers ---------- */
const findPhase = (id) => db.phases.find((p) => p.id === id);
const mustPhase = (id) => findPhase(id) || (() => { throw notFound('Phase tidak ditemukan'); })();
const mustTask = (id) => db.tasks.find((t) => t.id === id) || (() => { throw notFound('Task tidak ditemukan'); })();
const mustChange = (id) => db.changes.find((c) => c.id === id) || (() => { throw notFound('Change request tidak ditemukan'); })();
const sortedPhases = () => [...db.phases].sort((a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id));

function nextPhaseOf(id) {
  const s = sortedPhases();
  const i = s.findIndex((p) => p.id === id);
  return s.slice(i + 1).find((p) => p.status !== 'done') || null;
}

function shiftLater(p, n) {
  if (!n) return;
  const s = sortedPhases();
  const i = s.findIndex((x) => x.id === p.id);
  for (const q of s.slice(i + 1)) { q.start = addDays(q.start, n); q.end = addDays(q.end, n); }
}

function moveTask(t, status, index) {
  const col = db.tasks
    .filter((x) => x.phaseId === t.phaseId && x.status === status && x.id !== t.id)
    .sort((a, b) => a.order - b.order);
  const i = Number.isInteger(index) ? Math.max(0, Math.min(index, col.length)) : col.length;
  col.splice(i, 0, t);
  t.status = status;
  col.forEach((x, n) => { x.order = n; });
  t.updatedAt = now();
}

function phaseInput(b) {
  const name = str(b.name, 80);
  if (!name) throw bad('Nama phase wajib diisi');
  if (!isDate(b.start) || !isDate(b.end)) throw bad('Tanggal mulai dan selesai wajib diisi');
  if (b.end < b.start) throw bad('Tanggal selesai tidak boleh sebelum tanggal mulai');
  return {
    name, goal: str(b.goal, 500), start: b.start, end: b.end,
    status: PHASE_STATUS.includes(b.status) ? b.status : 'planned',
  };
}

function taskFields(b, base = {}) {
  const m = { ...base, ...b };
  const title = str(m.title, 200);
  if (!title) throw bad('Judul wajib diisi');
  const links = Array.isArray(m.links)
    ? m.links.filter((l) => l && str(l.url, 1000)).slice(0, 20).map((l) => ({
        id: String(l.id || uid()),
        title: str(l.title, 120) || str(l.url, 120),
        url: str(l.url, 1000),
      }))
    : (base.links || []);
  const comments = Array.isArray(m.comments)
    ? m.comments.filter((c) => c && str(c.text, 1000)).slice(0, 100).map((c) => ({
        id: String(c.id || uid()),
        user: str(c.user, 60) || 'user',
        text: str(c.text, 1000),
        ts: typeof c.ts === 'string' ? c.ts : now(),
      }))
    : (base.comments || []);
  let blockers = base.blockers || [];
  if (Array.isArray(m.blockers)) {
    blockers = m.blockers
      .filter((x) => x && str(x.text, 500))
      .slice(0, 30)
      .map((x) => ({
        id: String(x.id || uid()),
        text: str(x.text, 500),
        by: str(x.by, 60) || 'tim',
        ts: typeof x.ts === 'string' ? x.ts : now(),
      }));
  } else if (typeof b.blocker === 'string') {
    blockers = b.blocker.trim() ? [{ id: uid(), text: str(b.blocker, 500), by: 'tim', ts: now() }] : [];
  }
  let assignees;
  if (Array.isArray(b.assignees)) {
    assignees = b.assignees.map((x) => str(x, 60)).filter(Boolean);
  } else if (typeof b.assignee === 'string') {
    assignees = b.assignee ? b.assignee.split(/[,;]+/).map((x) => str(x.trim(), 60)).filter(Boolean) : [];
  } else if (base.assignees && Array.isArray(base.assignees)) {
    assignees = base.assignees.map((x) => str(x, 60)).filter(Boolean);
  } else if (base.assignee) {
    assignees = base.assignee.split(/[,;]+/).map((x) => str(x.trim(), 60)).filter(Boolean);
  } else {
    assignees = [];
  }
  const assignee = assignees.join(', ');
  return {
    title, desc: str(m.desc, 4000),
    blockers,
    links, comments,
    priority: PRIORITY.includes(m.priority) ? m.priority : 'medium',
    assignees,
    assignee,
    due: isDate(m.due) ? m.due : '',
  };
}

function newTask(phase, fields, status, extra = {}) {
  const st = TASK_STATUS.includes(status) ? status : 'todo';
  const order = db.tasks.filter((x) => x.phaseId === phase.id && x.status === st).reduce((m, x) => Math.max(m, x.order + 1), 0);
  const t = { id: uid(), phaseId: phase.id, ...fields, status: st, origin: 'baseline', crId: null, createdAt: now(), updatedAt: now(), order, ...extra };
  db.tasks.push(t);
  return t;
}

/* ---------- routes ---------- */
const routes = [];
const route = (method, pattern, fn) =>
  routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), fn });

const stateWithMeta = (user) => {
  const userSet = new Set(['admin', ...Array.from(USERS.keys())]);
  if (!USERS.size && fs.existsSync( path.join(__dirname, '.env.example') )) {
    const ex = fs.readFileSync(path.join(__dirname, '.env.example'), 'utf8');
    const m = ex.match(/APP_USERS=([^\r\n]+)/);
    if (m) {
      for (const part of m[1].split(/[,;]+/)) {
        const u = part.split(':')[0].trim();
        if (u) userSet.add(u);
      }
    }
  }
  if (user) userSet.add(user);
  return {
    ...db,
    me: {
      user,
      authRequired: AUTH_REQUIRED,
      users: Array.from(userSet),
    },
  };
};
const saved = (user) => { save(); return stateWithMeta(user); };

route('GET', '/api/state', ({ user }) => stateWithMeta(user));
route('GET', '/api/rev', () => ({ rev: db.rev }));

route('GET', '/api/export', () => ({
  __send: true, status: 200,
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Disposition': `attachment; filename="kanban-backup-${todayStr()}.json"`,
  },
  body: JSON.stringify(db, null, 1),
}));

route('POST', '/api/import', ({ body, user }) => {
  if (user !== 'admin') throw forbidden('Hanya akun admin yang memiliki izin untuk restore/import database');
  let nd;
  try { nd = normalize(body); } catch (e) { throw bad('File backup tidak valid: ' + e.message); }
  backupNow();
  nd.rev = db.rev;
  db = nd;
  addLog('Data diimpor dari file backup', user);
  return saved(user);
});

route('POST', '/api/reset', ({ body, user }) => {
  if (user !== 'admin') throw forbidden('Hanya akun admin yang memiliki izin untuk reset / clear database');
  backupNow();
  const rev = db.rev;
  if (body && body.mode === 'seed') {
    db = seed();
    db.rev = rev;
    addLog('Database di-reset ke data awal (Phase 1)', user);
  } else {
    db = { rev, phases: [], tasks: [], changes: [], log: [] };
    addLog('Database dikosongkan (Clear DB)', user);
  }
  return saved(user);
});

/* phases */
route('POST', '/api/phases', ({ body, user }) => {
  const p = { id: uid(), ...phaseInput(body), locked: false, approvedAt: null, baselineCount: 0 };
  db.phases.push(p);
  addLog(`Phase "${p.name}" dibuat (${p.start} → ${p.end})`, user);
  return saved(user);
});

route('PATCH', '/api/phases/:id', ({ params, body, user }) => {
  const p = mustPhase(params.id);
  const f = phaseInput({ ...p, ...body });
  const delta = diffDays(p.end, f.end);
  const moved = p.start !== f.start || p.end !== f.end;
  const old = `${p.start} → ${p.end}`;
  let cascaded = 0;
  if (body.cascade && delta !== 0) { shiftLater(p, delta); cascaded = delta; }
  Object.assign(p, f);
  addLog(moved
    ? `Timeline "${p.name}" berubah: ${old} menjadi ${p.start} → ${p.end}${cascaded ? `; phase berikutnya digeser ${cascaded > 0 ? '+' : ''}${cascaded} hari` : ''}`
    : `Phase "${p.name}" diperbarui`, user);
  return saved(user);
});

route('DELETE', '/api/phases/:id', ({ params, user }) => {
  const p = mustPhase(params.id);
  const removedTasks = db.tasks.filter((t) => t.phaseId === p.id).length;
  db.tasks = db.tasks.filter((t) => t.phaseId !== p.id);
  db.changes = db.changes.filter((c) => !(c.status === 'pending' && c.phaseId === p.id));
  db.phases = db.phases.filter((x) => x.id !== p.id);
  addLog(`Phase "${p.name}" dihapus${removedTasks ? ` (beserta ${removedTasks} item scope)` : ''}`, user);
  return saved(user);
});

route('POST', '/api/phases/:id/lock', ({ params, body, user }) => {
  const p = mustPhase(params.id);
  const lock = !!body.locked;
  if (lock === p.locked) return stateWithMeta(user);
  p.locked = lock;
  if (lock) {
    p.approvedAt = now();
    p.baselineCount = db.tasks.filter((t) => t.phaseId === p.id).length;
    addLog(`Scope "${p.name}" DIKUNCI (${p.baselineCount} item disetujui sebagai baseline)`, user);
  } else {
    addLog(`Kunci scope "${p.name}" dibuka kembali`, user);
  }
  return saved(user);
});

/* tasks */
route('POST', '/api/tasks', ({ body, user }) => {
  const phase = mustPhase(body.phaseId);
  if (phase.locked) throw conflict(`Scope "${phase.name}" sudah terkunci. Ajukan sebagai Change Request.`);
  const t = newTask(phase, taskFields(body), body.status);
  addLog(`Item "${t.title}" ditambahkan ke ${phase.name}`, user);
  return saved(user);
});

route('PATCH', '/api/tasks/:id', ({ params, body, user }) => {
  const t = mustTask(params.id);
  Object.assign(t, taskFields(body, t));
  const want = TASK_STATUS.includes(body.status) ? body.status : t.status;
  if (body.phaseId && body.phaseId !== t.phaseId) {
    const to = mustPhase(body.phaseId);
    if (to.locked) throw conflict(`Scope "${to.name}" sudah terkunci. Ajukan sebagai Change Request.`);
    const from = findPhase(t.phaseId);
    addLog(`Item "${t.title}" dipindah dari ${from ? from.name : '?'} ke ${to.name}${from && from.locked ? ' (scope phase asal berkurang)' : ''}`, user);
    t.phaseId = to.id;
    moveTask(t, want);
  } else if (want !== t.status) {
    moveTask(t, want);
  }
  t.updatedAt = now();
  return saved(user);
});

route('POST', '/api/tasks/:id/move', ({ params, body, user }) => {
  const t = mustTask(params.id);
  if (!TASK_STATUS.includes(body.status)) throw bad('Status tidak valid');
  moveTask(t, body.status, body.index);
  return saved(user);
});

/* blockers on task */
route('POST', '/api/tasks/:id/blockers', ({ params, body, user }) => {
  const t = mustTask(params.id);
  const text = str(body.text, 500);
  if (!text) throw bad('Isi catatan blocker tidak boleh kosong');
  t.blockers = t.blockers || [];
  t.blockers.push({ id: uid(), text, by: user || 'admin', ts: now() });
  t.updatedAt = now();
  return saved(user);
});

route('DELETE', '/api/tasks/:id/blockers/:bid', ({ params, user }) => {
  const t = mustTask(params.id);
  t.blockers = (t.blockers || []).filter((b) => b.id !== params.bid);
  t.updatedAt = now();
  return saved(user);
});

/* comments on task */
route('POST', '/api/tasks/:id/comments', ({ params, body, user }) => {
  const t = mustTask(params.id);
  const text = str(body.text, 1000);
  if (!text) throw bad('Isi komentar tidak boleh kosong');
  const sender = user || str(body.user, 60) || 'user';
  t.comments = t.comments || [];
  t.comments.push({ id: uid(), user: sender, text, ts: now() });
  t.updatedAt = now();
  return saved(user);
});

route('DELETE', '/api/tasks/:id/comments/:cid', ({ params, user }) => {
  const t = mustTask(params.id);
  t.comments = (t.comments || []).filter((c) => c.id !== params.cid);
  t.updatedAt = now();
  return saved(user);
});

route('DELETE', '/api/tasks/:id', ({ params, user }) => {
  const t = mustTask(params.id);
  const p = findPhase(t.phaseId);
  db.tasks = db.tasks.filter((x) => x.id !== t.id);
  addLog(`Item "${t.title}" dihapus dari ${p ? p.name : '?'}${p && p.locked ? ' (scope berkurang)' : ''}`, user);
  return saved(user);
});

/* change requests */
route('POST', '/api/changes', ({ body, user }) => {
  const title = str(body.title, 200);
  if (!title) throw bad('Judul perubahan wajib diisi');
  const phase = mustPhase(body.phaseId);
  const c = {
    id: uid(), title, desc: str(body.desc, 4000), requestedBy: str(body.requestedBy, 80) || user || '',
    reason: str(body.reason, 1000),
    phaseId: phase.id, phaseName: phase.name, status: 'pending', decision: null,
    decidedPhaseId: null, decidedPhaseName: '', decisionNote: '', extendDays: 0, taskId: null,
    createdAt: now(), decidedAt: null,
  };
  db.changes.push(c);
  addLog(`Change request "${c.title}" diajukan${c.requestedBy ? ' oleh ' + c.requestedBy : ''} (saat ${phase.name})`, user);
  return saved(user);
});

route('POST', '/api/changes/:id/decide', ({ params, body, user }) => {
  const c = mustChange(params.id);
  if (c.status !== 'pending') throw conflict('Change request ini sudah diputuskan');
  const decision = body.decision;
  const note = str(body.note, 1000);
  if (!['current', 'next', 'reject'].includes(decision)) throw bad('Keputusan tidak valid');

  if (decision === 'reject') {
    Object.assign(c, { status: 'rejected', decisionNote: note, decidedAt: now() });
    addLog(`Change request "${c.title}" DITOLAK${note ? ': ' + note : ''}`, user);
    return saved(user);
  }

  let target;
  if (decision === 'current') {
    target = findPhase(c.phaseId);
    if (!target) throw bad('Phase asal sudah tidak ada');
    if (!note) throw bad('Isi alasan kenapa perubahan ini wajib masuk phase sekarang');
  } else {
    target = nextPhaseOf(c.phaseId);
    if (!target && body.autoCreateNext) {
      const s = sortedPhases();
      const last = s[s.length - 1];
      const start = last ? addDays(last.end, 1) : todayStr();
      target = {
        id: uid(), name: `Phase ${s.length + 1}`, goal: 'Lanjutan & Change Request',
        start, end: addDays(start, 13), status: 'planned', locked: false, approvedAt: null, baselineCount: 0,
      };
      db.phases.push(target);
      addLog(`Phase baru "${target.name}" otomatis dibuat untuk menampung Change Request`, user);
    }
    if (!target) throw bad('Belum ada phase berikutnya. Buat phase baru dulu di Timeline.');
  }

  let extend = 0;
  if (decision === 'current') {
    extend = Math.max(0, Math.min(365, parseInt(body.extendDays, 10) || 0));
    if (extend) {
      if (body.cascade) shiftLater(target, extend);
      target.end = addDays(target.end, extend);
    }
  }

  const t = newTask(target, taskFields({ title: c.title, desc: c.desc, priority: body.priority }), 'todo', { origin: 'change', crId: c.id });
  Object.assign(c, {
    status: 'approved', decision, decidedPhaseId: target.id, decidedPhaseName: target.name,
    decisionNote: note, extendDays: extend, taskId: t.id, decidedAt: now(),
  });
  addLog(decision === 'current'
    ? `Change request "${c.title}" DISETUJUI masuk ${target.name} (wajib: ${note})${extend ? `; timeline +${extend} hari${body.cascade ? ', phase berikutnya ikut geser' : ''}` : ''}`
    : `Change request "${c.title}" DIGESER ke ${target.name}${note ? ': ' + note : ''}`, user);
  return saved(user);
});

route('DELETE', '/api/changes/:id', ({ params, user }) => {
  const c = mustChange(params.id);
  if (c.status !== 'pending') throw conflict('Hanya permintaan yang masih menunggu yang bisa dihapus');
  db.changes = db.changes.filter((x) => x.id !== c.id);
  addLog(`Change request "${c.title}" ditarik/dihapus`, user);
  return saved(user);
});

/* ---------- static files ---------- */
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'application/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};
const assets = {};
for (const [url, [file, type]] of Object.entries(STATIC)) {
  const raw = fs.readFileSync(path.join(__dirname, file));
  assets[url] = {
    type, raw, gz: zlib.gzipSync(raw, { level: 9 }),
    etag: '"' + crypto.createHash('sha1').update(raw).digest('hex').slice(0, 16) + '"',
  };
}

/* ---------- http ---------- */
const SECURITY = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SECURITY, ...headers });
  res.end(body);
}
const sendJson = (res, status, obj, extraHeaders = {}) =>
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extraHeaders });

function serveAsset(req, res, a) {
  const headers = { 'Content-Type': a.type, 'Cache-Control': 'no-cache', ETag: a.etag, Vary: 'Accept-Encoding' };
  if (req.headers['if-none-match'] === a.etag) return send(res, 304, null, headers);
  if (/\bgzip\b/.test(req.headers['accept-encoding'] || '')) return send(res, 200, a.gz, { ...headers, 'Content-Encoding': 'gzip' });
  return send(res, 200, a.raw, headers);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new HttpError(413, 'Data terlalu besar')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (_) { reject(bad('JSON tidak valid')); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname === '/healthz') return send(res, 200, 'ok', { 'Content-Type': 'text/plain' });

    // Static assets selalu dapat diakses agar halaman Login in-app bisa dimuat
    if (req.method === 'GET' && assets[pathname]) return serveAsset(req, res, assets[pathname]);

    // Endpoint Login & Logout
    if (pathname === '/api/login' && req.method === 'POST') {
      if (!/^application\/json/i.test(req.headers['content-type'] || '')) throw new HttpError(415, 'Content-Type harus application/json');
      const body = await readBody(req);
      const username = str(body.username, 60);
      const password = typeof body.password === 'string' ? body.password : '';
      if (!username) throw bad('Username wajib diisi');

      let validUser = username;
      if (AUTH_REQUIRED) {
        validUser = checkCredentials(username, password);
        if (!validUser) throw new HttpError(401, 'Username atau password salah');
      }
      const token = signUser(validUser);
      return sendJson(res, 200, stateWithMeta(validUser), {
        'Set-Cookie': `pb_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`,
      });
    }

    if (pathname === '/api/logout' && req.method === 'POST') {
      return sendJson(res, 200, { ok: true, authRequired: AUTH_REQUIRED }, {
        'Set-Cookie': 'pb_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',
      });
    }

    const user = getAuthUser(req);
    if (!user) {
      return sendJson(res, 401, {
        error: 'Butuh login',
        authRequired: true,
      });
    }

    if (pathname.startsWith('/api/')) {
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = pathname.match(r.re);
        if (!m) continue;
        let body = {};
        if (req.method !== 'GET') {
          if (!/^application\/json/i.test(req.headers['content-type'] || '')) throw new HttpError(415, 'Content-Type harus application/json');
          body = await readBody(req);
          if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('Body harus berupa objek JSON');
        }
        const out = r.fn({ params: m.groups || {}, body, req, user });
        if (out && out.__send) return send(res, out.status, out.body, out.headers);
        return sendJson(res, 200, out);
      }
      throw notFound('Endpoint tidak ditemukan');
    }

    send(res, 404, 'Tidak ditemukan', { 'Content-Type': 'text/plain; charset=utf-8' });
  } catch (e) {
    if (e instanceof HttpError) return sendJson(res, e.status, { error: e.message });
    console.error(e);
    sendJson(res, 500, { error: 'Terjadi kesalahan di server' });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Kanban Timeline berjalan di port ${PORT}`);
  console.log(`Data: ${DB_FILE}`);
  if (AUTH_REQUIRED) {
    console.log(`Multi-user aktif (${USERS.size} akun terdaftar dari env APP_USERS/APP_PASSWORD): ${Array.from(USERS.keys()).join(', ')}`);
  } else {
    console.warn('[!] APP_USERS / APP_PASSWORD kosong: mode terbuka (user bisa ganti nama langsung di UI).');
  }
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 2000).unref(); });
}
