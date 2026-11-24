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
const MULTI_FILE = path.join(DATA_DIR, 'multi_db.json');
const MAX_BODY = 5 * 1024 * 1024;
const LOG_LIMIT = 500;
const DAY = 86400000;

let Pool = null;
try { ({ Pool } = require('pg')); } catch (_) { /* fallback file lokal jika pg belum terpasang */ }

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
const SECRET_SEED = [
  process.env.TOKEN_SECRET || '',
  process.env.DATABASE_URL || '',
  process.env.DB_HOST || '',
  process.env.DB_PASSWORD || '',
  AUTH_REQUIRED ? Array.from(USERS.entries()).map(([u, p]) => `${u}:${p}`).join('|') : 'open-mode-secret',
].join('::');
const TOKEN_SECRET = crypto.createHash('sha256').update(SECRET_SEED).digest();

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
  const log = (d.log || [])
    .filter((l) => l && typeof l.ts === 'string' && typeof l.text === 'string')
    .slice(0, LOG_LIMIT)
    .map((l) => ({
      ts: l.ts,
      text: l.text,
      by: typeof l.by === 'string' ? l.by : '',
      taskId: typeof l.taskId === 'string' ? l.taskId : null,
    }));
  return { rev: Number.isInteger(d.rev) ? d.rev : 1, phases, tasks, changes, log };
}

const RESERVED_SLUGS = new Set(['api', 'card', 'kanban', 'timeline', 'healthz', 'login', 'logout', 'admin']);
const slugify = (s) => String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

function loadSingleLegacyBoard() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) return seed();
  try {
    return normalize(JSON.parse(fs.readFileSync(DB_FILE, 'utf8')));
  } catch (e) {
    console.error(`[!] ${DB_FILE} tidak bisa dibaca: ${e.message}`);
    try {
      return normalize(JSON.parse(fs.readFileSync(DB_FILE + '.bak', 'utf8')));
    } catch (_) {
      return seed();
    }
  }
}

function buildInitialStore() {
  const defaultBoard = loadSingleLegacyBoard();
  const tenants = {
    main: {
      slug: 'main',
      name: 'Project Utama',
      createdAt: now(),
      board: defaultBoard,
    },
  };
  const users = {};
  for (const [u, p] of USERS.entries()) {
    users[u] = {
      username: u,
      password: p,
      role: u === 'admin' ? 'superadmin' : 'user',
      tenants: ['main'],
    };
  }
  if (!users.admin) {
    users.admin = {
      username: 'admin',
      password: USERS.get('admin') || process.env.APP_PASSWORD || '',
      role: 'superadmin',
      tenants: ['main'],
    };
  }
  if (!USERS.size && fs.existsSync(path.join(__dirname, '.env.example'))) {
    const ex = fs.readFileSync(path.join(__dirname, '.env.example'), 'utf8');
    const m = ex.match(/APP_USERS=([^\r\n]+)/);
    if (m) {
      for (const part of m[1].split(/[,;]+/)) {
        const u = part.split(':')[0].trim();
        if (u && !users[u]) {
          users[u] = { username: u, password: '', role: u === 'admin' ? 'superadmin' : 'user', tenants: ['main'] };
        }
      }
    }
  }
  return { authEnabled: AUTH_REQUIRED, users, tenants };
}

function normalizeStore(raw) {
  const base = buildInitialStore();
  if (!raw || typeof raw !== 'object') return base;
  const tenants = {};
  if (raw.tenants && typeof raw.tenants === 'object') {
    for (const [k, t] of Object.entries(raw.tenants)) {
      const slug = slugify(t && (t.slug || k));
      if (!slug || RESERVED_SLUGS.has(slug)) continue;
      try {
        tenants[slug] = {
          slug,
          name: str(t.name, 80) || slug,
          createdAt: t.createdAt || now(),
          board: normalize(t.board || seed()),
        };
      } catch (_) { /* lewati tenant rusak */ }
    }
  }
  if (!Object.keys(tenants).length) Object.assign(tenants, base.tenants);
  const allSlugs = Object.keys(tenants);

  const users = { ...base.users };
  if (raw.users && typeof raw.users === 'object') {
    for (const [k, u] of Object.entries(raw.users)) {
      const uname = str(u && (u.username || k), 60);
      if (!uname) continue;
      const envPass = USERS.get(uname);
      const pass = typeof (u && u.password) === 'string' && u.password ? u.password : (envPass || '');
      const role = (uname === 'admin' || (u && u.role === 'superadmin')) ? 'superadmin' : 'user';
      const userTenants = Array.isArray(u && u.tenants)
        ? u.tenants.filter((s) => tenants[s])
        : [allSlugs[0]];
      users[uname] = {
        username: uname,
        password: pass,
        role,
        tenants: role === 'superadmin' ? allSlugs : userTenants,
      };
    }
  }
  // Pastikan user dari env APP_USERS selalu terdaftar
  for (const [u, p] of USERS.entries()) {
    if (!users[u]) {
      users[u] = {
        username: u,
        password: p,
        role: u === 'admin' ? 'superadmin' : 'user',
        tenants: allSlugs,
      };
    } else if (!users[u].password && p) {
      users[u].password = p;
    }
  }
  if (!users.admin) {
    users.admin = { username: 'admin', password: USERS.get('admin') || '', role: 'superadmin', tenants: allSlugs };
  } else {
    users.admin.role = 'superadmin';
  }
  const hasAnyPassword = AUTH_REQUIRED || Object.values(users).some((u) => Boolean(u.password));
  return { authEnabled: hasAnyPassword, users, tenants };
}

function loadLocalStore() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(MULTI_FILE)) {
    try {
      return normalizeStore(JSON.parse(fs.readFileSync(MULTI_FILE, 'utf8')));
    } catch (e) {
      console.error(`[!] ${MULTI_FILE} gagal dibaca: ${e.message}`);
    }
  }
  return buildInitialStore();
}

let store = loadLocalStore();
let activeTenantSlug = Object.keys(store.tenants)[0] || 'main';
let db = store.tenants[activeTenantSlug].board;
let lastBackup = 0;

/* ---------- PostgreSQL Connection (Sakala DB support) ---------- */
let pgPool = null;
let pgReady = false;

function buildPgConfig(forceSsl = false) {
  if (!Pool) return null;
  const connUrl = (process.env.DATABASE_URL || process.env.POSTGRES_URL || '').trim();
  const host = (process.env.DB_HOST || process.env.PGHOST || '').trim();
  const database = (process.env.DB_DATABASE || process.env.DB_NAME || process.env.PGDATABASE || '').trim();
  const user = (process.env.DB_USERNAME || process.env.DB_USER || process.env.PGUSER || '').trim();
  const password = process.env.DB_PASSWORD || process.env.PGPASSWORD || '';
  const port = parseInt(process.env.DB_PORT || process.env.PGPORT || '5432', 10) || 5432;
  const wantSsl = forceSsl || /sslmode=require/i.test(connUrl) || process.env.DB_SSL === 'true';

  if (connUrl) {
    const cfg = { connectionString: connUrl, max: 10, idleTimeoutMillis: 30000, connectionTimeoutMillis: 8000 };
    if (wantSsl) cfg.ssl = { rejectUnauthorized: false };
    return cfg;
  }
  if (host && database && user) {
    const cfg = { host, port, database, user, password, max: 10, idleTimeoutMillis: 30000, connectionTimeoutMillis: 8000 };
    if (wantSsl) cfg.ssl = { rejectUnauthorized: false };
    return cfg;
  }
  return null;
}

async function initPostgres() {
  let cfg = buildPgConfig(false);
  if (!cfg) return;
  try {
    let pool = new Pool(cfg);
    try {
      await pool.query('SELECT 1');
    } catch (firstErr) {
      await pool.end().catch(() => {});
      if (!cfg.ssl) {
        cfg = buildPgConfig(true);
        pool = new Pool(cfg);
        await pool.query('SELECT 1');
      } else {
        throw firstErr;
      }
    }
    pgPool = pool;
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS pb_meta (
        key TEXT PRIMARY KEY,
        value JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS pb_tenants (
        slug TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        board JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    const tRes = await pgPool.query('SELECT slug, name, created_at, board FROM pb_tenants ORDER BY created_at ASC');
    const uRes = await pgPool.query("SELECT value FROM pb_meta WHERE key = 'users'");

    if (tRes.rows.length > 0) {
      const rawTenants = {};
      for (const row of tRes.rows) {
        rawTenants[row.slug] = {
          slug: row.slug,
          name: row.name,
          createdAt: row.created_at ? new Date(row.created_at).toISOString() : now(),
          board: row.board,
        };
      }
      const rawUsers = (uRes.rows[0] && uRes.rows[0].value) ? uRes.rows[0].value : {};
      store = normalizeStore({ tenants: rawTenants, users: rawUsers });
      activeTenantSlug = Object.keys(store.tenants)[0] || 'main';
      db = store.tenants[activeTenantSlug].board;
      pgReady = true;
      saveLocalStoreSync();
      console.log(`[PostgreSQL] Terhubung & memuat ${Object.keys(store.tenants).length} tenant serta ${Object.keys(store.users).length} user.`);
    } else {
      pgReady = true;
      await syncAllToPostgres();
      console.log(`[PostgreSQL] Tabel baru diinisialisasi & data awal (${Object.keys(store.tenants).length} tenant) disimpan ke PostgreSQL.`);
    }
  } catch (err) {
    console.error(`[!] Gagal terhubung ke PostgreSQL (${err.message}). Menggunakan penyimpanan file lokal sebagai fallback.`);
    pgReady = false;
  }
}

async function syncUsersToPostgres() {
  if (!pgReady || !pgPool) return;
  try {
    await pgPool.query(
      `INSERT INTO pb_meta (key, value, updated_at) VALUES ('users', $1::jsonb, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [JSON.stringify(store.users)],
    );
  } catch (e) {
    console.error('[PostgreSQL] Gagal menyimpan users:', e.message);
  }
}

async function syncTenantToPostgres(slug) {
  if (!pgReady || !pgPool) return;
  const t = store.tenants[slug];
  if (!t) return;
  try {
    await pgPool.query(
      `INSERT INTO pb_tenants (slug, name, created_at, board, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, NOW())
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, board = EXCLUDED.board, updated_at = NOW()`,
      [t.slug, t.name, t.createdAt || now(), JSON.stringify(t.board)],
    );
  } catch (e) {
    console.error(`[PostgreSQL] Gagal menyimpan tenant "${slug}":`, e.message);
  }
}

async function deleteTenantFromPostgres(slug) {
  if (!pgReady || !pgPool) return;
  try {
    await pgPool.query('DELETE FROM pb_tenants WHERE slug = $1', [slug]);
  } catch (e) {
    console.error(`[PostgreSQL] Gagal menghapus tenant "${slug}":`, e.message);
  }
}

async function syncAllToPostgres() {
  if (!pgReady || !pgPool) return;
  await syncUsersToPostgres();
  for (const slug of Object.keys(store.tenants)) {
    await syncTenantToPostgres(slug);
  }
}

function backupNow() {
  if (fs.existsSync(MULTI_FILE)) { fs.copyFileSync(MULTI_FILE, MULTI_FILE + '.bak'); lastBackup = Date.now(); }
}

function saveLocalStoreSync() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = MULTI_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(store, null, 1));
    if (Date.now() - lastBackup > 3600e3) backupNow();
    fs.renameSync(tmp, MULTI_FILE);
  } catch (e) {
    console.error('[!] Gagal menyimpan file lokal:', e.message);
  }
}

function save(tenantSlug = activeTenantSlug) {
  const t = store.tenants[tenantSlug];
  if (t) {
    t.board.rev++;
  }
  saveLocalStoreSync();
  syncTenantToPostgres(tenantSlug);
}

function saveMetaAndTenant(tenantSlug = null) {
  saveLocalStoreSync();
  syncUsersToPostgres();
  if (tenantSlug) syncTenantToPostgres(tenantSlug);
}

function addLog(text, user, taskId = null) {
  const suffix = user ? ` (oleh ${user})` : '';
  db.log.unshift({ ts: now(), text: text + suffix, by: user || '', taskId: taskId || null });
  if (db.log.length > LOG_LIMIT) db.log.length = LOG_LIMIT;
}

/* ---------- auth, role & tenant access helper ---------- */
const safeEq = (a, b) => crypto.timingSafeEqual(
  crypto.createHash('sha256').update(String(a)).digest(),
  crypto.createHash('sha256').update(String(b)).digest(),
);

const isAuthRequired = () => Boolean(store.authEnabled || AUTH_REQUIRED || Object.values(store.users).some((u) => Boolean(u.password)));
const isSuperAdmin = (username) => Boolean(username === 'admin' || (store.users[username] && store.users[username].role === 'superadmin'));

function allowedTenantsFor(username) {
  const all = Object.values(store.tenants);
  if (!username) return [];
  if (!isAuthRequired() || isSuperAdmin(username)) return all;
  const u = store.users[username];
  if (!u) return [];
  const list = Array.isArray(u.tenants) ? u.tenants : [];
  return all.filter((t) => list.includes(t.slug));
}

function usersForTenant(tenantSlug) {
  const out = new Set(['admin']);
  for (const u of Object.values(store.users)) {
    if (u.role === 'superadmin' || u.username === 'admin' || (Array.isArray(u.tenants) && u.tenants.includes(tenantSlug))) {
      out.add(u.username);
    }
  }
  return Array.from(out);
}

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
  if (isAuthRequired() && !store.users[username]) return null;
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
  for (const u of Object.values(store.users)) {
    if (safeEq(u.username, username)) {
      if (!u.password && !isAuthRequired()) return u.username;
      if (u.password && safeEq(u.password, password)) return u.username;
    }
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
      if (isAuthRequired()) {
        const matched = checkCredentials(u, p);
        if (matched) return matched;
      } else if (u.trim()) {
        return str(u, 60);
      }
    }
  }
  if (!isAuthRequired()) {
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
  db.tasks.filter((x) => x.phaseId === phase.id && x.status === st).forEach((x) => { x.order = (x.order || 0) + 1; });
  const t = { id: uid(), phaseId: phase.id, ...fields, status: st, origin: 'baseline', crId: null, createdAt: now(), updatedAt: now(), order: 0, ...extra };
  db.tasks.push(t);
  return t;
}

/* ---------- routes ---------- */
const routes = [];
const route = (method, pattern, fn) =>
  routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), fn });

const stateWithMeta = (user, tenantSlug = activeTenantSlug) => {
  const allowed = allowedTenantsFor(user);
  let t = store.tenants[tenantSlug];
  if (!t || !allowed.some((x) => x.slug === t.slug)) {
    t = allowed[0] || Object.values(store.tenants)[0];
  }
  const slug = t ? t.slug : 'main';
  const board = t ? t.board : db;
  const tenantUsers = usersForTenant(slug);
  if (user && !tenantUsers.includes(user)) tenantUsers.push(user);

  return {
    ...board,
    tenant: t ? { slug: t.slug, name: t.name } : { slug: 'main', name: 'Project Utama' },
    tenants: allowed.map((x) => ({ slug: x.slug, name: x.name })),
    storage: pgReady ? 'postgresql' : 'local-file',
    me: {
      user,
      role: isSuperAdmin(user) ? 'superadmin' : 'user',
      isSuperAdmin: isSuperAdmin(user),
      authRequired: isAuthRequired(),
      users: tenantUsers,
    },
  };
};
const saved = (user) => { save(activeTenantSlug); return stateWithMeta(user, activeTenantSlug); };

function buildAdminOverview() {
  const allSlugs = Object.keys(store.tenants);
  return {
    storage: pgReady ? 'postgresql' : 'local-file',
    tenants: Object.values(store.tenants).map((t) => ({
      slug: t.slug,
      name: t.name,
      createdAt: t.createdAt,
      phasesCount: (t.board.phases || []).length,
      tasksCount: (t.board.tasks || []).length,
      doneCount: (t.board.tasks || []).filter((x) => x.status === 'done').length,
      members: Object.values(store.users)
        .filter((u) => u.role === 'superadmin' || u.username === 'admin' || (Array.isArray(u.tenants) && u.tenants.includes(t.slug)))
        .map((u) => u.username),
    })),
    users: Object.values(store.users).map((u) => ({
      username: u.username,
      role: (u.role === 'superadmin' || u.username === 'admin') ? 'superadmin' : 'user',
      hasPassword: Boolean(u.password),
      tenants: (u.role === 'superadmin' || u.username === 'admin')
        ? allSlugs
        : (Array.isArray(u.tenants) ? u.tenants.filter((s) => store.tenants[s]) : []),
    })),
  };
}

route('GET', '/api/state', ({ user }) => stateWithMeta(user, activeTenantSlug));
route('GET', '/api/rev', () => ({ rev: db.rev, latestLog: db.log[0] || null, tenant: activeTenantSlug }));

/* ---------- Super Admin: Tenant & User Management ---------- */
route('GET', '/api/admin/overview', ({ user }) => {
  if (!isSuperAdmin(user)) throw forbidden('Hanya Super Admin yang dapat mengelola Tenant & User');
  return buildAdminOverview();
});

route('POST', '/api/admin/tenants', ({ body, user }) => {
  if (!isSuperAdmin(user)) throw forbidden('Hanya Super Admin yang dapat membuat Tenant baru');
  const name = str(body.name, 80);
  if (!name) throw bad('Nama Project / Tenant wajib diisi');
  const slug = slugify(body.slug || name);
  if (!slug || slug.length < 2) throw bad('Slug URL minimal 2 karakter huruf/angka');
  if (RESERVED_SLUGS.has(slug)) throw bad(`Slug "${slug}" adalah kata sistem tercadang, gunakan slug lain`);
  if (store.tenants[slug]) throw conflict(`Tenant dengan slug "${slug}" sudah ada`);

  const newBoard = seed();
  addLog.call(null, `Tenant "${name}" (${slug}) dibuat`, user);
  newBoard.log = [{ ts: now(), text: `Project / Tenant "${name}" dibuat (oleh ${user})`, by: user, taskId: null }];

  store.tenants[slug] = {
    slug,
    name,
    createdAt: now(),
    board: newBoard,
  };

  const members = Array.isArray(body.members) ? body.members.map((m) => str(m, 60)).filter(Boolean) : [];
  for (const u of Object.values(store.users)) {
    if (u.role === 'superadmin' || u.username === 'admin' || members.includes(u.username)) {
      const set = new Set(Array.isArray(u.tenants) ? u.tenants : []);
      set.add(slug);
      u.tenants = Array.from(set);
    }
  }

  saveMetaAndTenant(slug);
  return {
    overview: buildAdminOverview(),
    state: stateWithMeta(user, slug),
  };
});

route('PATCH', '/api/admin/tenants/:slug', ({ params, body, user }) => {
  if (!isSuperAdmin(user)) throw forbidden('Hanya Super Admin yang dapat mengubah Tenant');
  const t = store.tenants[params.slug];
  if (!t) throw notFound('Tenant tidak ditemukan');
  if (body.name !== undefined) {
    const name = str(body.name, 80);
    if (!name) throw bad('Nama Tenant tidak boleh kosong');
    t.name = name;
  }
  if (Array.isArray(body.members)) {
    const memberSet = new Set(body.members.map((m) => str(m, 60)).filter(Boolean));
    for (const u of Object.values(store.users)) {
      const cur = new Set(Array.isArray(u.tenants) ? u.tenants : []);
      if (u.role === 'superadmin' || u.username === 'admin' || memberSet.has(u.username)) {
        cur.add(t.slug);
      } else {
        cur.delete(t.slug);
      }
      u.tenants = Array.from(cur);
    }
  }
  saveMetaAndTenant(t.slug);
  return {
    overview: buildAdminOverview(),
    state: stateWithMeta(user, activeTenantSlug),
  };
});

route('DELETE', '/api/admin/tenants/:slug', ({ params, user }) => {
  if (!isSuperAdmin(user)) throw forbidden('Hanya Super Admin yang dapat menghapus Tenant');
  const slug = params.slug;
  if (!store.tenants[slug]) throw notFound('Tenant tidak ditemukan');
  if (Object.keys(store.tenants).length <= 1) throw bad('Minimal harus ada 1 Project / Tenant aktif');
  delete store.tenants[slug];
  for (const u of Object.values(store.users)) {
    if (Array.isArray(u.tenants)) {
      u.tenants = u.tenants.filter((s) => s !== slug);
    }
  }
  saveLocalStoreSync();
  syncUsersToPostgres();
  deleteTenantFromPostgres(slug);
  const nextSlug = Object.keys(store.tenants)[0];
  return {
    overview: buildAdminOverview(),
    state: stateWithMeta(user, nextSlug),
  };
});

route('POST', '/api/admin/users', ({ body, user }) => {
  if (!isSuperAdmin(user)) throw forbidden('Hanya Super Admin yang dapat mengelola User');
  const username = str(body.username, 60).toLowerCase().replace(/[^a-z0-9._-]/g, '');
  if (!username) throw bad('Username wajib diisi (huruf/angka)');
  const existing = store.users[username];
  const password = typeof body.password === 'string' ? body.password.trim() : '';
  if (!existing && !password) throw bad('Password wajib diisi untuk user baru');

  const role = (username === 'admin' || body.role === 'superadmin') ? 'superadmin' : 'user';
  const allSlugs = Object.keys(store.tenants);
  const tenants = role === 'superadmin'
    ? allSlugs
    : (Array.isArray(body.tenants) ? body.tenants.filter((s) => store.tenants[s]) : (existing ? existing.tenants : [allSlugs[0]]));

  store.users[username] = {
    username,
    password: password || (existing ? existing.password : ''),
    role,
    tenants,
  };
  store.authEnabled = Object.values(store.users).some((u) => Boolean(u.password));
  saveMetaAndTenant(null);
  return {
    overview: buildAdminOverview(),
    state: stateWithMeta(user, activeTenantSlug),
  };
});

route('DELETE', '/api/admin/users/:username', ({ params, user }) => {
  if (!isSuperAdmin(user)) throw forbidden('Hanya Super Admin yang dapat menghapus User');
  const target = params.username;
  if (target === 'admin') throw bad('Akun super admin utama (admin) tidak dapat dihapus');
  if (target === user) throw bad('Tidak dapat menghapus akun yang sedang Anda gunakan login');
  if (!store.users[target]) throw notFound('User tidak ditemukan');
  delete store.users[target];
  saveMetaAndTenant(null);
  return {
    overview: buildAdminOverview(),
    state: stateWithMeta(user, activeTenantSlug),
  };
});

route('GET', '/api/export', () => ({
  __send: true, status: 200,
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Disposition': `attachment; filename="kanban-${activeTenantSlug}-${todayStr()}.json"`,
  },
  body: JSON.stringify(db, null, 1),
}));

route('POST', '/api/import', ({ body, user }) => {
  if (!isSuperAdmin(user)) throw forbidden('Hanya Super Admin yang memiliki izin untuk restore/import database');
  let nd;
  try { nd = normalize(body); } catch (e) { throw bad('File backup tidak valid: ' + e.message); }
  backupNow();
  nd.rev = db.rev;
  store.tenants[activeTenantSlug].board = nd;
  db = nd;
  addLog(`Data project "${store.tenants[activeTenantSlug].name}" diimpor dari file backup`, user);
  return saved(user);
});

route('POST', '/api/reset', ({ body, user }) => {
  if (!isSuperAdmin(user)) throw forbidden('Hanya Super Admin yang memiliki izin untuk reset / clear database');
  backupNow();
  const rev = db.rev;
  if (body && body.mode === 'seed') {
    db = seed();
    db.rev = rev;
    addLog('Database project di-reset ke data awal (Phase 1)', user);
  } else {
    db = { rev, phases: [], tasks: [], changes: [], log: [] };
    addLog('Database project dikosongkan (Clear DB)', user);
  }
  store.tenants[activeTenantSlug].board = db;
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
  addLog(`Item "${t.title}" ditambahkan ke ${phase.name}`, user, t.id);
  return saved(user);
});

route('PATCH', '/api/tasks/:id', ({ params, body, user }) => {
  const t = mustTask(params.id);
  const oldStatus = t.status;
  const oldTitle = t.title;
  Object.assign(t, taskFields(body, t));
  const want = TASK_STATUS.includes(body.status) ? body.status : t.status;
  if (body.phaseId && body.phaseId !== t.phaseId) {
    const to = mustPhase(body.phaseId);
    if (to.locked) throw conflict(`Scope "${to.name}" sudah terkunci. Ajukan sebagai Change Request.`);
    const from = findPhase(t.phaseId);
    addLog(`Item "${t.title}" dipindah dari ${from ? from.name : '?'} ke ${to.name}${from && from.locked ? ' (scope phase asal berkurang)' : ''}`, user, t.id);
    t.phaseId = to.id;
    moveTask(t, want);
  } else if (want !== oldStatus) {
    moveTask(t, want);
    addLog(`Status "${t.title}" diubah ke ${want.toUpperCase()}`, user, t.id);
  } else if (body.assignees !== undefined) {
    addLog(`PIC "${t.title}" diperbarui: ${t.assignees.join(', ') || 'kosong'}`, user, t.id);
  } else if (body.due !== undefined) {
    addLog(`Deadline "${t.title}" diubah ke ${t.due || 'kosong'}`, user, t.id);
  } else if (body.links !== undefined) {
    addLog(`Link Doksli pada "${t.title}" diperbarui`, user, t.id);
  } else if (body.desc !== undefined) {
    addLog(`Deskripsi "${t.title}" diperbarui`, user, t.id);
  } else if (body.title !== undefined && t.title !== oldTitle) {
    addLog(`Judul card diubah menjadi "${t.title}"`, user, t.id);
  }
  t.updatedAt = now();
  return saved(user);
});

route('POST', '/api/tasks/:id/move', ({ params, body, user }) => {
  const t = mustTask(params.id);
  if (!TASK_STATUS.includes(body.status)) throw bad('Status tidak valid');
  const oldStatus = t.status;
  moveTask(t, body.status, body.index);
  if (body.status !== oldStatus) {
    addLog(`Status "${t.title}" dipindah ke ${body.status.toUpperCase()}`, user, t.id);
  }
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
  addLog(`Blocker baru pada "${t.title}": "${str(text, 80)}"`, user, t.id);
  return saved(user);
});

route('DELETE', '/api/tasks/:id/blockers/:bid', ({ params, user }) => {
  const t = mustTask(params.id);
  t.blockers = (t.blockers || []).filter((b) => b.id !== params.bid);
  t.updatedAt = now();
  addLog(`Blocker pada "${t.title}" diselesaikan`, user, t.id);
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
  addLog(`Komentar pada "${t.title}": "${str(text, 80)}"`, sender, t.id);
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

const SPA_PATH_RE = /^\/(?:(timeline|kanban|card\/[a-zA-Z0-9_-]+|kanban\/card\/[a-zA-Z0-9_-]+)|([a-zA-Z0-9_-]+)(?:\/(timeline|kanban|card\/[a-zA-Z0-9_-]+|kanban\/card\/[a-zA-Z0-9_-]+))?)\/?$/;

function applyRequestTenantContext(req, parsedUrl, user) {
  const allowed = allowedTenantsFor(user);
  if (!allowed.length) {
    throw forbidden('Akun Anda belum ditugaskan ke Project / Tenant mana pun. Hubungi Super Admin.');
  }
  const reqSlug = slugify(req.headers['x-tenant'] || parsedUrl.searchParams.get('tenant') || '');
  let target = reqSlug ? allowed.find((t) => t.slug === reqSlug) : null;
  if (!target) {
    if (reqSlug && req.method !== 'GET' && !parsedUrl.pathname.startsWith('/api/admin/')) {
      throw forbidden(`Anda tidak memiliki akses ke project "${reqSlug}"`);
    }
    target = allowed[0];
  }
  activeTenantSlug = target.slug;
  db = target.board;
  return target;
}

const server = http.createServer(async (req, res) => {
  try {
    const parsedUrl = new URL(req.url, 'http://localhost');
    const { pathname } = parsedUrl;
    if (pathname === '/healthz') return send(res, 200, 'ok', { 'Content-Type': 'text/plain' });

    // Static assets selalu dapat diakses agar halaman Login in-app bisa dimuat
    if (req.method === 'GET' && assets[pathname]) return serveAsset(req, res, assets[pathname]);
    // Deep-link SPA routes (/timeline, /kanban, /card/:id, /<tenant>/timeline, /<tenant>/kanban, /<tenant>/card/:id)
    if (req.method === 'GET' && !pathname.startsWith('/api/') && SPA_PATH_RE.test(pathname)) {
      return serveAsset(req, res, assets['/']);
    }

    // Endpoint Login & Logout
    if (pathname === '/api/login' && req.method === 'POST') {
      if (!/^application\/json/i.test(req.headers['content-type'] || '')) throw new HttpError(415, 'Content-Type harus application/json');
      const body = await readBody(req);
      const username = str(body.username, 60);
      const password = typeof body.password === 'string' ? body.password : '';
      if (!username) throw bad('Username wajib diisi');

      let validUser = username;
      if (isAuthRequired()) {
        validUser = checkCredentials(username, password);
        if (!validUser) throw new HttpError(401, 'Username atau password salah');
      } else if (!store.users[validUser]) {
        store.users[validUser] = {
          username: validUser,
          password: '',
          role: validUser === 'admin' ? 'superadmin' : 'user',
          tenants: Object.keys(store.tenants),
        };
        saveMetaAndTenant(null);
      }
      const allowed = allowedTenantsFor(validUser);
      const reqSlug = slugify(req.headers['x-tenant'] || parsedUrl.searchParams.get('tenant') || '');
      const chosen = (reqSlug && allowed.find((t) => t.slug === reqSlug)) || allowed[0];
      const token = signUser(validUser);
      return sendJson(res, 200, stateWithMeta(validUser, chosen ? chosen.slug : 'main'), {
        'Set-Cookie': `pb_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`,
      });
    }

    if (pathname === '/api/logout' && req.method === 'POST') {
      return sendJson(res, 200, { ok: true, authRequired: isAuthRequired() }, {
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
        applyRequestTenantContext(req, parsedUrl, user);
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

initPostgres().finally(() => {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Kanban Timeline Multi-Tenant berjalan di port ${PORT}`);
    console.log(`Storage: ${pgReady ? 'PostgreSQL (Sakala DB)' : `Local File (${MULTI_FILE})`}`);
    console.log(`Tenants: ${Object.keys(store.tenants).join(', ')}`);
    console.log(`Users (${Object.keys(store.users).length}): ${Object.keys(store.users).join(', ')}`);
  });
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    server.close(async () => {
      if (pgPool) await pgPool.end().catch(() => {});
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
