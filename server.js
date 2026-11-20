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

const PORT = parseInt(process.env.PORT, 10) || 3000;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const DB_FILE = path.join(DATA_DIR, 'db.json');
const APP_USER = process.env.APP_USER || 'admin';
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const MAX_BODY = 5 * 1024 * 1024;
const LOG_LIMIT = 500;
const DAY = 86400000;

const TASK_STATUS = ['todo', 'doing', 'review', 'done'];
const PRIORITY = ['low', 'medium', 'high'];
const PHASE_STATUS = ['planned', 'active', 'done'];

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (m) => new HttpError(400, m);
const conflict = (m) => new HttpError(409, m);
const notFound = (m) => new HttpError(404, m);

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
    return {
      id: String(t.id), phaseId: t.phaseId, title: str(t.title, 200), desc: str(t.desc, 4000),
      status: TASK_STATUS.includes(t.status) ? t.status : 'todo',
      priority: PRIORITY.includes(t.priority) ? t.priority : 'medium',
      assignee: str(t.assignee, 60), due: isDate(t.due) ? t.due : '',
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
  fs.renameSync(tmp, DB_FILE); // atomic: file tidak pernah setengah tertulis
}

function addLog(text) {
  db.log.unshift({ ts: now(), text });
  if (db.log.length > LOG_LIMIT) db.log.length = LOG_LIMIT;
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

// Geser semua phase setelah `p` sebanyak n hari (dipanggil sebelum tanggal p diubah).
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
  return {
    title, desc: str(m.desc, 4000),
    priority: PRIORITY.includes(m.priority) ? m.priority : 'medium',
    assignee: str(m.assignee, 60), due: isDate(m.due) ? m.due : '',
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
const saved = () => { save(); return db; };

route('GET', '/api/state', () => db);
route('GET', '/api/rev', () => ({ rev: db.rev }));

route('GET', '/api/export', () => ({
  __send: true, status: 200,
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Disposition': `attachment; filename="kanban-backup-${todayStr()}.json"`,
  },
  body: JSON.stringify(db, null, 1),
}));

route('POST', '/api/import', ({ body }) => {
  let nd;
  try { nd = normalize(body); } catch (e) { throw bad('File backup tidak valid: ' + e.message); }
  backupNow();
  nd.rev = db.rev;
  db = nd;
  addLog('Data diimpor dari file backup');
  return saved();
});

route('POST', '/api/reset', ({ body }) => {
  backupNow();
  const rev = db.rev;
  if (body && body.mode === 'seed') {
    db = seed();
    db.rev = rev;
    addLog('Database di-reset ke data awal (Phase 1)');
  } else {
    db = { rev, phases: [], tasks: [], changes: [], log: [] };
    addLog('Database dikosongkan (Clear DB)');
  }
  return saved();
});

/* phases */
route('POST', '/api/phases', ({ body }) => {
  const p = { id: uid(), ...phaseInput(body), locked: false, approvedAt: null, baselineCount: 0 };
  db.phases.push(p);
  addLog(`Phase "${p.name}" dibuat (${p.start} → ${p.end})`);
  return saved();
});

route('PATCH', '/api/phases/:id', ({ params, body }) => {
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
    : `Phase "${p.name}" diperbarui`);
  return saved();
});

route('DELETE', '/api/phases/:id', ({ params }) => {
  const p = mustPhase(params.id);
  if (db.tasks.some((t) => t.phaseId === p.id)) throw conflict('Phase masih punya task. Pindahkan atau hapus task-nya dulu.');
  if (db.changes.some((c) => c.status === 'pending' && c.phaseId === p.id)) throw conflict('Masih ada change request yang menunggu keputusan di phase ini.');
  db.phases = db.phases.filter((x) => x.id !== p.id);
  addLog(`Phase "${p.name}" dihapus`);
  return saved();
});

route('POST', '/api/phases/:id/lock', ({ params, body }) => {
  const p = mustPhase(params.id);
  const lock = !!body.locked;
  if (lock === p.locked) return db;
  p.locked = lock;
  if (lock) {
    p.approvedAt = now();
    p.baselineCount = db.tasks.filter((t) => t.phaseId === p.id).length;
    addLog(`Scope "${p.name}" DIKUNCI (${p.baselineCount} item disetujui sebagai baseline)`);
  } else {
    addLog(`Kunci scope "${p.name}" dibuka kembali`);
  }
  return saved();
});

/* tasks */
route('POST', '/api/tasks', ({ body }) => {
  const phase = mustPhase(body.phaseId);
  if (phase.locked) throw conflict(`Scope "${phase.name}" sudah terkunci. Ajukan sebagai Change Request.`);
  const t = newTask(phase, taskFields(body), body.status);
  addLog(`Item "${t.title}" ditambahkan ke ${phase.name}`);
  return saved();
});

route('PATCH', '/api/tasks/:id', ({ params, body }) => {
  const t = mustTask(params.id);
  Object.assign(t, taskFields(body, t));
  const want = TASK_STATUS.includes(body.status) ? body.status : t.status;
  if (body.phaseId && body.phaseId !== t.phaseId) {
    const to = mustPhase(body.phaseId);
    if (to.locked) throw conflict(`Scope "${to.name}" sudah terkunci. Ajukan sebagai Change Request.`);
    const from = findPhase(t.phaseId);
    addLog(`Item "${t.title}" dipindah dari ${from ? from.name : '?'} ke ${to.name}${from && from.locked ? ' (scope phase asal berkurang)' : ''}`);
    t.phaseId = to.id;
    moveTask(t, want);
  } else if (want !== t.status) {
    moveTask(t, want);
  }
  t.updatedAt = now();
  return saved();
});

route('POST', '/api/tasks/:id/move', ({ params, body }) => {
  const t = mustTask(params.id);
  if (!TASK_STATUS.includes(body.status)) throw bad('Status tidak valid');
  moveTask(t, body.status, body.index);
  return saved();
});

route('DELETE', '/api/tasks/:id', ({ params }) => {
  const t = mustTask(params.id);
  const p = findPhase(t.phaseId);
  db.tasks = db.tasks.filter((x) => x.id !== t.id);
  addLog(`Item "${t.title}" dihapus dari ${p ? p.name : '?'}${p && p.locked ? ' (scope berkurang)' : ''}`);
  return saved();
});

/* change requests */
route('POST', '/api/changes', ({ body }) => {
  const title = str(body.title, 200);
  if (!title) throw bad('Judul perubahan wajib diisi');
  const phase = mustPhase(body.phaseId);
  const c = {
    id: uid(), title, desc: str(body.desc, 4000), requestedBy: str(body.requestedBy, 80), reason: str(body.reason, 1000),
    phaseId: phase.id, phaseName: phase.name, status: 'pending', decision: null,
    decidedPhaseId: null, decidedPhaseName: '', decisionNote: '', extendDays: 0, taskId: null,
    createdAt: now(), decidedAt: null,
  };
  db.changes.push(c);
  addLog(`Change request "${c.title}" diajukan${c.requestedBy ? ' oleh ' + c.requestedBy : ''} (saat ${phase.name})`);
  return saved();
});

route('POST', '/api/changes/:id/decide', ({ params, body }) => {
  const c = mustChange(params.id);
  if (c.status !== 'pending') throw conflict('Change request ini sudah diputuskan');
  const decision = body.decision;
  const note = str(body.note, 1000);
  if (!['current', 'next', 'reject'].includes(decision)) throw bad('Keputusan tidak valid');

  if (decision === 'reject') {
    Object.assign(c, { status: 'rejected', decisionNote: note, decidedAt: now() });
    addLog(`Change request "${c.title}" DITOLAK${note ? ': ' + note : ''}`);
    return saved();
  }

  let target;
  if (decision === 'current') {
    target = findPhase(c.phaseId);
    if (!target) throw bad('Phase asal sudah tidak ada');
    if (!note) throw bad('Isi alasan kenapa perubahan ini wajib masuk phase sekarang');
  } else {
    target = nextPhaseOf(c.phaseId);
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
    : `Change request "${c.title}" DIGESER ke ${target.name}${note ? ': ' + note : ''}`);
  return saved();
});

route('DELETE', '/api/changes/:id', ({ params }) => {
  const c = mustChange(params.id);
  if (c.status !== 'pending') throw conflict('Hanya permintaan yang masih menunggu yang bisa dihapus');
  db.changes = db.changes.filter((x) => x.id !== c.id);
  addLog(`Change request "${c.title}" ditarik/dihapus`);
  return saved();
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
const sendJson = (res, status, obj) => send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });

function serveAsset(req, res, a) {
  const headers = { 'Content-Type': a.type, 'Cache-Control': 'no-cache', ETag: a.etag, Vary: 'Accept-Encoding' };
  if (req.headers['if-none-match'] === a.etag) return send(res, 304, null, headers);
  if (/\bgzip\b/.test(req.headers['accept-encoding'] || '')) return send(res, 200, a.gz, { ...headers, 'Content-Encoding': 'gzip' });
  return send(res, 200, a.raw, headers);
}

const safeEq = (a, b) => crypto.timingSafeEqual(
  crypto.createHash('sha256').update(a).digest(),
  crypto.createHash('sha256').update(b).digest(),
);

function authorized(req) {
  if (!APP_PASSWORD) return true;
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return false;
  const raw = Buffer.from(h.slice(6), 'base64').toString('utf8');
  const i = raw.indexOf(':');
  if (i < 0) return false;
  return safeEq(raw.slice(0, i), APP_USER) && safeEq(raw.slice(i + 1), APP_PASSWORD);
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

    if (!authorized(req)) {
      return send(res, 401, 'Butuh login', {
        'WWW-Authenticate': 'Basic realm="Kanban Timeline", charset="UTF-8"',
        'Content-Type': 'text/plain; charset=utf-8',
      });
    }

    if (req.method === 'GET' && assets[pathname]) return serveAsset(req, res, assets[pathname]);

    if (pathname.startsWith('/api/')) {
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = pathname.match(r.re);
        if (!m) continue;
        let body = {};
        if (req.method !== 'GET') {
          // Wajib JSON: mencegah CSRF lintas-situs (form biasa tidak bisa kirim content-type ini tanpa preflight)
          if (!/^application\/json/i.test(req.headers['content-type'] || '')) throw new HttpError(415, 'Content-Type harus application/json');
          body = await readBody(req);
          if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('Body harus berupa objek JSON');
        }
        const out = r.fn({ params: m.groups || {}, body, req });
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
  if (!APP_PASSWORD) console.warn('[!] APP_PASSWORD kosong: aplikasi terbuka untuk siapa saja yang tahu URL-nya.');
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 2000).unref(); });
}
