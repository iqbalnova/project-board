'use strict';
(() => {
  /* ======================= KONSTANTA & STATE ======================= */
  const DAY = 86400000;
  const STATUSES = [['todo', 'To Do'], ['doing', 'In Progress'], ['review', 'Review'], ['done', 'Done']];
  const STATUS_SHORT = { todo: 'Todo', doing: 'Progress', review: 'Review', done: 'Done' };
  const STATUS_LABEL = Object.fromEntries(STATUSES);
  const PRIO_OPTIONS = [['low', 'Rendah'], ['medium', 'Sedang'], ['high', 'Tinggi']];
  const PHASE_OPTIONS = [['planned', 'Direncanakan'], ['active', 'Berjalan'], ['done', 'Selesai']];
  const PHASE_LABEL = Object.fromEntries(PHASE_OPTIONS);
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
  const MON_FULL = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
  const DOW = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (_) { /* abaikan */ } },
  };

  let S = { rev: 0, phases: [], tasks: [], changes: [], log: [], me: { user: 'admin', authRequired: false, users: ['admin'] } };
  const ui = {
    view: store.get('view') === 'kanban' ? 'kanban' : 'timeline',
    phaseId: store.get('phaseId'),
    q: '',
    refocus: null,
    drawerTaskId: null,
    drawerRefocusComment: false,
    addingBlocker: false,
    needLogin: false,
    cascade: store.get('cascade') !== '0',
    theme: store.get('theme') === 'dark' ? 'dark' : 'light',
    scaleMode: store.get('scaleMode') || '1d',
    pxPerDay: Number(store.get('pxPerDay')) || 42,
    scrollLeft: 0,
  };
  let dragging = false;
  let dragId = null;

  /* ======================= TEMA ======================= */
  const SUN_ICON = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>';
  const MOON_ICON = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';

  function applyTheme() {
    document.documentElement.dataset.theme = ui.theme;
    const btn = document.getElementById('btn-theme');
    if (btn) {
      const isDark = ui.theme === 'dark';
      btn.innerHTML = isDark ? SUN_ICON : MOON_ICON;
      btn.title = isDark ? 'Mode Gelap (Klik untuk beralih ke Mode Terang)' : 'Mode Terang (Klik untuk beralih ke Mode Gelap)';
      btn.setAttribute('aria-label', btn.title);
    }
  }

  function updateUserButton() {
    const btn = document.getElementById('btn-user');
    const btnReset = document.getElementById('btn-reset');
    const u = (S.me && S.me.user) || '';
    const isAdmin = u === 'admin';

    if (btn) {
      if (ui.needLogin) {
        btn.textContent = 'Login';
      } else {
        btn.textContent = u || 'admin';
      }
    }

    if (btnReset) {
      btnReset.style.display = (!ui.needLogin && isAdmin) ? '' : 'none';
    }
  }

  /* ======================= UTIL DOM & SVG ======================= */
  const $ = (sel) => document.querySelector(sel);

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
        else if (k === 'dataset') Object.assign(el.dataset, v);
        else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
        else if (v === true) el.setAttribute(k, '');
        else el.setAttribute(k, v);
      }
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

  function statusSvg(st) {
    const span = document.createElement('span');
    span.className = 'st-icon';
    if (st === 'todo') {
      span.innerHTML = `<svg viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="5.2" stroke="currentColor" stroke-width="1.4" stroke-dasharray="2.2 2"/></svg>`;
    } else if (st === 'doing') {
      span.innerHTML = `<svg viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="5.2" stroke="currentColor" stroke-width="1.4"/><path d="M7 1.8A5.2 5.2 0 0 1 7 12.2Z" fill="currentColor"/></svg>`;
    } else if (st === 'review') {
      span.innerHTML = `<svg viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="5.2" stroke="currentColor" stroke-width="1.4"/><circle cx="7" cy="7" r="2.6" fill="currentColor"/></svg>`;
    } else {
      span.innerHTML = `<svg viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="5.5" fill="currentColor"/><path d="M4.5 7.1L6.3 8.9L9.6 5.3" stroke="var(--panel)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    }
    return span;
  }

  const badge = (text, cls = '') => h('span', { class: ('badge ' + cls).trim() }, text);

  function renderLinkedText(text) {
    const frag = document.createDocumentFragment();
    const re = /(https?:\/\/[^\s<>")]+)/g;
    let last = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) frag.append(document.createTextNode(text.slice(last, m.index)));
      const url = m[1];
      let host = url;
      try { host = new URL(url).hostname.replace(/^www\./, ''); } catch (_) { /* ignore */ }
      frag.append(h('a', { href: url, target: '_blank', rel: 'noopener noreferrer', onclick: (e) => e.stopPropagation() }, `${host} ↗`));
      last = re.lastIndex;
    }
    if (last < text.length) frag.append(document.createTextNode(text.slice(last)));
    return frag;
  }

  /* ======================= TANGGAL ======================= */
  const T = (s) => Date.parse(s + 'T00:00:00Z');
  const fmt = (s) => new Date(T(s)).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const fmtShort = (s) => new Date(T(s)).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  const fmtTime = (ts) => new Date(ts).toLocaleString('id-ID', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const pad = (n) => String(n).padStart(2, '0');
  const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const addDays = (s, n) => new Date(T(s) + n * DAY).toISOString().slice(0, 10);
  const days = (p) => Math.round((T(p.end) - T(p.start)) / DAY) + 1;

  /* ======================= DATA HELPER ======================= */
  const phases = () => [...S.phases].sort((a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id));
  const phaseById = (id) => S.phases.find((p) => p.id === id) || null;
  const tasksOf = (pid) => S.tasks.filter((t) => t.phaseId === pid);
  function currentPhase() {
    const ps = phases();
    return ps.find((p) => p.status === 'active') || ps.find((p) => p.status !== 'done') || ps[ps.length - 1] || null;
  }
  function nextPhaseOf(id) {
    const ps = phases();
    const i = ps.findIndex((p) => p.id === id);
    return ps.slice(i + 1).find((p) => p.status !== 'done') || null;
  }
  function stats(p) {
    const ts = tasksOf(p.id);
    const done = ts.filter((t) => t.status === 'done').length;
    return { total: ts.length, done, pct: ts.length ? Math.round((done / ts.length) * 100) : 0 };
  }
  const initials = (n) => (n || '?').split(/[\s._-]+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
  const blockersOf = (t) => Array.isArray(t.blockers) ? t.blockers : (t.blocker ? [{ id: 'legacy', text: t.blocker, by: 'tim' }] : []);
  const assigneesOf = (t) => {
    if (Array.isArray(t.assignees) && t.assignees.length) return t.assignees.filter(Boolean);
    if (typeof t.assignee === 'string' && t.assignee.trim()) {
      return t.assignee.split(/[,;]+/).map((s) => s.trim()).filter(Boolean);
    }
    return [];
  };

  function envUsers() {
    const list = (S.me && Array.isArray(S.me.users) && S.me.users.length) ? S.me.users : ['admin'];
    return list.includes('admin') ? list : ['admin', ...list];
  }

  function picOptions(currentVal = '') {
    const users = envUsers();
    const opts = [['', '— Pilih PIC —'], ...users.map((u) => [u, u])];
    if (currentVal && !users.includes(currentVal)) opts.push([currentVal, currentVal]);
    return opts;
  }

  /* ======================= API ======================= */
  async function api(method, url, body) {
    const opt = { method, headers: {} };
    if (method !== 'GET') { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body ?? {}); }
    const res = await fetch(url, opt);
    let data = null;
    try { data = await res.json(); } catch (_) { /* bukan JSON */ }
    if (res.status === 401 && url !== '/api/login') {
      ui.needLogin = true;
      ui.drawerTaskId = null;
      render();
      throw new Error((data && data.error) || 'Silakan login terlebih dahulu');
    }
    if (!res.ok) throw new Error((data && data.error) || `Gagal (${res.status})`);
    return data;
  }
  async function mutate(method, url, body) {
    const vp = document.querySelector('.g-viewport');
    if (vp) ui.scrollLeft = vp.scrollLeft;
    S = await api(method, url, body);
    ui.needLogin = false;
    render();
  }

  let toastTimer;
  function toast(msg, isErr) {
    const el = $('#toast');
    el.textContent = msg;
    el.className = 'show' + (isErr ? ' err' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.className = ''; }, 3200);
  }
  const safe = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, true); } };

  const refreshState = safe(async (showMsg = true) => {
    const vp = document.querySelector('.g-viewport');
    if (vp) ui.scrollLeft = vp.scrollLeft;
    S = await api('GET', '/api/state');
    ui.needLogin = false;
    render();
    if (showMsg) toast('Data diperbarui');
  });

  /* ======================= LOGIN & MULTI-USER ======================= */
  function loginView() {
    const err = h('div', { class: 'form-err', role: 'alert', hidden: true });
    const uIn = h('input', { name: 'username', required: true, placeholder: 'Username', autocomplete: 'username' });
    const pIn = h('input', { name: 'password', type: 'password', required: true, placeholder: 'Password', autocomplete: 'current-password' });
    const btn = h('button', { type: 'submit', class: 'btn primary' }, 'Masuk');

    const form = h('form', {
      class: 'form',
      onsubmit: async (e) => {
        e.preventDefault();
        err.hidden = true;
        btn.disabled = true;
        try {
          S = await api('POST', '/api/login', { username: uIn.value.trim(), password: pIn.value });
          ui.needLogin = false;
          render();
          toast(`Masuk sebagai ${S.me.user}`);
        } catch (ex) {
          err.textContent = ex.message;
          err.hidden = false;
        } finally {
          btn.disabled = false;
        }
      },
    },
    h('label', { class: 'field' }, h('span', {}, 'Username'), uIn),
    h('label', { class: 'field' }, h('span', {}, 'Password'), pIn),
    err,
    btn);

    setTimeout(() => uIn.focus(), 0);
    return h('div', { class: 'panel login-wrap' },
      h('h2', {}, 'Login Project Board'),
      h('p', {}, 'Silakan masuk dengan akun Anda untuk mengakses board.'),
      form);
  }

  function userDialog() {
    const dlg = $('#dlg');
    const me = (S.me && S.me.user) || 'admin';
    const authReq = Boolean(S.me && S.me.authRequired);
    const err = h('div', { class: 'form-err', role: 'alert', hidden: true });
    const uIn = h('input', { name: 'username', required: true, value: me, placeholder: 'Nama user (mis: iqbal / budi)' });
    const pIn = h('input', { name: 'password', type: 'password', required: authReq, placeholder: authReq ? 'Password' : 'Kosongkan (mode tanpa password)' });

    const form = h('form', {
      class: 'form',
      onsubmit: async (e) => {
        e.preventDefault();
        err.hidden = true;
        try {
          S = await api('POST', '/api/login', { username: uIn.value.trim(), password: pIn.value });
          ui.needLogin = false;
          dlg.close();
          render();
          toast(`Aktif sebagai ${S.me.user}`);
        } catch (ex) {
          err.textContent = ex.message;
          err.hidden = false;
        }
      },
    },
    h('label', { class: 'field' }, h('span', {}, 'Username'), uIn),
    authReq && h('label', { class: 'field' }, h('span', {}, 'Password'), pIn),
    err,
    h('div', { class: 'actions-row' },
      authReq && h('button', {
        type: 'button', class: 'btn danger spacer',
        onclick: async () => {
          await api('POST', '/api/logout', {});
          dlg.close();
          ui.needLogin = true;
          ui.drawerTaskId = null;
          render();
        },
      }, 'Logout'),
      h('button', { type: 'button', class: 'btn', onclick: () => dlg.close() }, 'Batal'),
      h('button', { type: 'submit', class: 'btn primary' }, 'Ganti User')));

    dlg.replaceChildren(
      h('div', { class: 'dlg-in' },
        h('h2', {}, `User Aktif: ${me}`),
        h('p', { class: 'intro' }, authReq
          ? 'Komentar dan riwayat aktivitas otomatis tercatat atas nama akun ini.'
          : 'Ganti nama user aktif agar komentar dan riwayat tercatat atas namamu.'),
        form));
    dlg.showModal();
  }

  /* ======================= NAVIGASI & AKSI ======================= */
  function jumpToPhase(id) {
    const el = document.getElementById('phase-' + id);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 1200);
  }

  function openPhaseInKanban(id) {
    ui.phaseId = id;
    ui.view = 'kanban';
    store.set('phaseId', id);
    store.set('view', 'kanban');
    render();
  }

  const adjustPhaseDates = safe(async (p, deltaStart, deltaEnd) => {
    const newStart = addDays(p.start, deltaStart);
    let newEnd = addDays(p.end, deltaEnd);
    if (newEnd < newStart) newEnd = newStart;
    await mutate('PATCH', `/api/phases/${p.id}`, {
      name: p.name, goal: p.goal, status: p.status,
      start: newStart, end: newEnd, cascade: ui.cascade,
    });
  });

  const deletePhaseDirect = safe(async (p) => {
    const count = tasksOf(p.id).length;
    const msg = count
      ? `Hapus "${p.name}" beserta ${count} item scope di dalamnya?`
      : `Hapus "${p.name}"?`;
    if (!confirm(msg)) return;
    await mutate('DELETE', `/api/phases/${p.id}`);
    toast(`${p.name} dihapus`);
  });

  /* ======================= SIDE-PEEK DETAIL SHEET ======================= */
  function openTaskDrawer(t) {
    if (ui.drawerTaskId !== t.id) ui.addingBlocker = false;
    ui.drawerTaskId = t.id;
    renderDrawer();
  }

  function closeTaskDrawer() {
    ui.drawerTaskId = null;
    ui.addingBlocker = false;
    renderDrawer();
  }

  function renderDrawer() {
    const drawer = $('#drawer');
    const backdrop = $('#drawer-backdrop');
    if (!drawer || !backdrop) return;

    if (!ui.drawerTaskId || ui.needLogin) {
      drawer.hidden = true;
      backdrop.hidden = true;
      drawer.replaceChildren();
      return;
    }

    const t = S.tasks.find((x) => x.id === ui.drawerTaskId);
    if (!t) {
      ui.drawerTaskId = null;
      drawer.hidden = true;
      backdrop.hidden = true;
      return;
    }

    const ph = phaseById(t.phaseId);
    const cr = t.crId ? S.changes.find((c) => c.id === t.crId) : null;
    const links = [...(t.links || [])];
    const blockers = blockersOf(t);
    const comments = t.comments || [];
    const me = (S.me && S.me.user) || 'admin';

    const patchField = safe(async (patch) => {
      await mutate('PATCH', `/api/tasks/${t.id}`, patch);
    });

    // Top bar dengan tombol Refresh
    const topBar = h('div', { class: 'drawer-top' },
      h('div', { class: 'drawer-top-left' },
        h('span', { style: { fontWeight: '600', color: 'var(--text-sec)' } }, ph ? ph.name : 'Phase'),
        h('span', {}, '/'),
        h('span', {}, 'Detail Ticket'),
        t.origin === 'change' && badge('CR', 'cr')),
      h('div', { class: 'drawer-top-actions' },
        h('button', {
          type: 'button', class: 'btn xs',
          title: 'Refresh data & komentar terbaru',
          onclick: () => refreshState(true),
        }, '↻ Refresh'),
        h('button', {
          type: 'button', class: 'btn xs danger',
          onclick: safe(async () => {
            if (!confirm(`Hapus "${t.title}"?`)) return;
            await mutate('DELETE', `/api/tasks/${t.id}`);
            closeTaskDrawer();
          }),
        }, 'Hapus'),
        h('button', { type: 'button', class: 'btn xs', onclick: closeTaskDrawer }, 'Tutup ✕')));

    // Title input (auto-save)
    const titleIn = h('input', {
      class: 'drawer-title-input',
      value: t.title,
      maxlength: 200,
      placeholder: 'Judul Scope / Ticket...',
      onblur: () => {
        const val = titleIn.value.trim();
        if (val && val !== t.title) patchField({ title: val });
      },
      onkeydown: (e) => {
        if (e.key === 'Enter') { e.preventDefault(); titleIn.blur(); }
      },
    });

    // Properties Grid (PIC dropdown dari env users)
    const curAssignees = assigneesOf(t);
    const allUsers = Array.from(new Set([...envUsers(), ...curAssignees]));
    const isDueOrOver = t.due && t.status !== 'done' && t.due <= todayStr();

    const picPills = h('div', { class: 'pic-pills-wrap' },
      allUsers.map((u) => {
        const isSelected = curAssignees.includes(u);
        return h('button', {
          type: 'button',
          class: 'pic-pill' + (isSelected ? ' is-active' : ''),
          title: isSelected ? `Klik untuk mencabut ${u}` : `Klik untuk menugaskan ${u}`,
          onclick: () => {
            const next = isSelected
              ? curAssignees.filter((x) => x !== u)
              : [...curAssignees, u];
            patchField({ assignees: next, assignee: next.join(', ') });
          },
        },
        h('span', { class: 'pic-avatar' }, initials(u)),
        h('span', { class: 'pic-name' }, u),
        isSelected && h('span', { class: 'pic-chk' }, '✓'));
      }));

    const propGrid = h('div', { class: 'prop-grid' },
      h('label', { class: 'prop-item' },
        h('span', {}, 'Status'),
        h('select', { onchange: (e) => patchField({ status: e.target.value }) },
          STATUSES.map(([v, l]) => h('option', { value: v, selected: v === t.status }, l)))),
      h('label', { class: 'prop-item' },
        h('span', {}, 'Prioritas'),
        h('select', { onchange: (e) => patchField({ priority: e.target.value }) },
          PRIO_OPTIONS.map(([v, l]) => h('option', { value: v, selected: v === t.priority }, l)))),
      h('label', { class: 'prop-item' },
        h('span', {}, 'Phase'),
        h('select', { onchange: (e) => patchField({ phaseId: e.target.value }) },
          phases().map((p) => h('option', { value: p.id, selected: p.id === t.phaseId }, p.name + (p.locked ? ' (Locked)' : ''))))),
      h('label', { class: 'prop-item' },
        h('span', {}, 'Deadline' + (isDueOrOver ? ' (Lewat / Hari H)' : '')),
        h('input', {
          type: 'date', value: t.due || '',
          class: isDueOrOver ? 'due-over-input' : '',
          onchange: (e) => patchField({ due: e.target.value }),
        })),
      h('div', { class: 'prop-pics-full' },
        h('span', { class: 'prop-hdr' }, `PIC / Assignee (${curAssignees.length ? curAssignees.join(', ') : 'Belum dipilih - klik untuk assign'})`),
        picPills));

    // 1. DESKRIPSI (Di paling atas setelah properti)
    const descIn = h('textarea', {
      rows: 4,
      maxlength: 4000,
      placeholder: 'Tulis deskripsi, spesifikasi, atau catatan context (otomatis disimpan saat selesai ketik)...',
      onblur: () => {
        if (descIn.value !== (t.desc || '')) patchField({ desc: descIn.value });
      },
    }, t.desc || '');

    const descSec = h('div', { class: 'ws-section' },
      h('div', { class: 'ws-head' },
        h('span', {}, 'DESKRIPSI')),
      descIn,
      t.desc && /https?:\/\//.test(t.desc) && h('div', { class: 'notion-preview' },
        h('div', { class: 'small muted', style: { marginBottom: '4px', fontWeight: '600' } }, 'Link Aktif di Deskripsi:'),
        renderLinkedText(t.desc)));

    // 2. LINK DOKSLI (Section tersendiri)
    const lTitleIn = h('input', { name: 'ltitle', placeholder: 'Label (mis: Figma / API Spec / PRD)', maxlength: 120 });
    const lUrlIn = h('input', { name: 'lurl', placeholder: 'https://...', maxlength: 1000 });
    const addLinkForm = h('form', {
      class: 'link-add-row',
      onsubmit: safe(async (e) => {
        e.preventDefault();
        let url = lUrlIn.value.trim();
        if (!url) return;
        if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
        links.push({ id: String(Date.now()), title: lTitleIn.value.trim() || url, url });
        await patchField({ links });
      }),
    }, lTitleIn, lUrlIn, h('button', { type: 'submit', class: 'btn xs' }, '+ Link'));

    const linksSec = h('div', { class: 'ws-section' },
      h('div', { class: 'ws-head' },
        h('span', {}, `LINK DOKSLI (${links.length})`)),
      links.length > 0 && h('div', { class: 'links-list' },
        links.map((l, idx) => h('div', { class: 'link-card' },
          h('a', { href: l.url, target: '_blank', rel: 'noopener noreferrer' }, `${l.title} ↗`),
          h('button', {
            type: 'button', title: 'Hapus link',
            onclick: () => { links.splice(idx, 1); patchField({ links }); },
          }, '×')))),
      addLinkForm);

    // 3. MULTI-BLOCKER (Jika kosong dan belum klik tambah -> sisa tombol '+ Tambah Blocker' saja)
    let blockerSec;
    if (!blockers.length && !ui.addingBlocker) {
      blockerSec = h('div', { class: 'blocker-add-trigger' },
        h('button', {
          type: 'button',
          class: 'btn small danger',
          onclick: () => { ui.addingBlocker = true; renderDrawer(); },
        }, '+ Tambah Blocker'));
    } else {
      const bIn = h('input', {
        placeholder: 'Tulis kendala / blocker baru... (tekan Enter)',
        maxlength: 500,
      });
      if (ui.addingBlocker) {
        requestAnimationFrame(() => bIn.focus());
      }
      const addBlockerForm = h('form', {
        class: 'comment-form',
        onsubmit: safe(async (e) => {
          e.preventDefault();
          const text = bIn.value.trim();
          if (!text) return;
          ui.addingBlocker = false;
          await mutate('POST', `/api/tasks/${t.id}/blockers`, { text });
        }),
      },
      bIn,
      h('button', { type: 'submit', class: 'btn xs danger' }, 'Simpan'),
      h('button', {
        type: 'button', class: 'btn xs ghost',
        onclick: () => { ui.addingBlocker = false; renderDrawer(); },
      }, 'Batal'));

      blockerSec = h('div', { class: 'ws-section blocker-sec' },
        h('div', { class: 'ws-head' },
          h('span', { style: { color: 'var(--bad)' } }, `BLOCKER / KENDALA (${blockers.length})`),
          !ui.addingBlocker && h('button', {
            type: 'button', class: 'btn xs danger',
            onclick: () => { ui.addingBlocker = true; renderDrawer(); },
          }, '+ Tambah Blocker')),
        blockers.length > 0 && h('ul', { class: 'blocker-list' },
          blockers.map((b) => h('li', { class: 'blocker-item' },
            h('div', { class: 'blocker-item-main' },
              h('span', {}, b.text),
              b.by && h('span', { class: 'blocker-item-by' }, `· ${b.by}`)),
            h('button', {
              type: 'button', class: 'btn xs',
              title: 'Tandai blocker ini selesai',
              onclick: safe(async () => {
                await mutate('DELETE', `/api/tasks/${t.id}/blockers/${b.id}`);
              }),
            }, 'Selesai ✓')))),
        ui.addingBlocker && addBlockerForm);
    }

    // 4. KOMENTAR TIM
    const commentIn = h('input', {
      placeholder: `Tulis komentar sebagai ${me}… (tekan Enter)`,
      maxlength: 1000,
    });
    if (ui.drawerRefocusComment) {
      ui.drawerRefocusComment = false;
      requestAnimationFrame(() => commentIn.focus());
    }

    const commentForm = h('form', {
      class: 'comment-form',
      onsubmit: safe(async (e) => {
        e.preventDefault();
        const text = commentIn.value.trim();
        if (!text) return;
        ui.drawerRefocusComment = true;
        await mutate('POST', `/api/tasks/${t.id}/comments`, { text });
      }),
    }, commentIn, h('button', { type: 'submit', class: 'btn xs primary' }, 'Kirim'));

    const commentSec = h('div', { class: 'ws-section' },
      h('div', { class: 'ws-head' },
        h('span', {}, `KOMENTAR (${comments.length})`),
        h('span', { class: 'muted small' }, `Aktif sebagai: ${me}`)),
      comments.length > 0
        ? h('ul', { class: 'comment-list' },
            comments.map((c) => h('li', { class: 'comment-item' },
              h('span', { class: 'comment-avatar', title: c.user }, initials(c.user)),
              h('div', { class: 'comment-main' },
                h('div', { class: 'comment-head' },
                  h('span', { class: 'comment-user' }, c.user),
                  h('time', { class: 'comment-time' }, fmtTime(c.ts)),
                  h('button', {
                    type: 'button', class: 'comment-del', title: 'Hapus komentar',
                    onclick: safe(async () => {
                      await mutate('DELETE', `/api/tasks/${t.id}/comments/${c.id}`);
                    }),
                  }, '×')),
                h('div', { class: 'comment-text' }, renderLinkedText(c.text))))))
        : h('div', { class: 'muted small' }, 'Belum ada komentar di ticket ini.'),
      commentForm);

    const body = h('div', { class: 'drawer-body' },
      h('div', {},
        titleIn,
        t.origin === 'change' && cr && h('p', { class: 'muted small', style: { marginTop: '6px' } },
          `Masuk lewat Change Request${cr.requestedBy ? ' dari ' + cr.requestedBy : ''}${cr.decisionNote ? ' — ' + cr.decisionNote : ''}.`)),
      propGrid,
      descSec,
      linksSec,
      blockerSec,
      commentSec);

    drawer.replaceChildren(topBar, body);
    drawer.hidden = false;
    backdrop.hidden = false;
  }

  /* ======================= DIALOG FORM STANDAR ======================= */
  function openForm({ title, intro, fields, submit = 'Simpan', onSubmit, extraButtons = [], wide = false }) {
    const dlg = $('#dlg');
    const err = h('div', { class: 'form-err', role: 'alert', hidden: true });
    const inputs = {};
    const showErr = (m) => { err.textContent = m; err.hidden = false; };

    const rows = fields.map((f) => {
      if (f.type === 'custom') return f.render(inputs);
      const common = { name: f.name, id: 'f_' + f.name, required: f.required, placeholder: f.placeholder };
      let input;
      if (f.type === 'textarea') input = h('textarea', { ...common, rows: f.rows || 3, maxlength: f.maxlength }, f.value || '');
      else if (f.type === 'select') input = h('select', common, f.options.map(([v, l]) => h('option', { value: v, selected: v === f.value }, l)));
      else if (f.type === 'checkbox') input = h('input', { ...common, type: 'checkbox', checked: !!f.value });
      else input = h('input', { ...common, type: f.type || 'text', value: f.value ?? '', min: f.min, max: f.max, maxlength: f.maxlength, step: f.step });
      inputs[f.name] = input;
      if (f.type === 'checkbox') return h('label', { class: 'field check' }, input, h('span', {}, f.label));
      return h('label', { class: 'field' }, h('span', {}, f.label), input, f.hint && h('small', {}, f.hint));
    });

    const values = () => Object.fromEntries(fields.filter((f) => f.type !== 'custom').map((f) => {
      const el = inputs[f.name];
      if (f.type === 'checkbox') return [f.name, el.checked];
      if (f.type === 'number') return [f.name, el.value === '' ? 0 : Number(el.value)];
      return [f.name, el.value];
    }));

    const submitBtn = h('button', { class: 'btn primary', type: 'submit' }, submit);
    const extras = extraButtons.map((b) => h('button', {
      type: 'button', class: 'btn ' + (b.danger ? 'danger spacer' : ''),
      onclick: async () => {
        err.hidden = true;
        try { if (await b.onClick()) dlg.close(); } catch (e) { showErr(e.message); }
      },
    }, b.label));

    const form = h('form', {
      class: 'form',
      onsubmit: async (e) => {
        e.preventDefault();
        err.hidden = true;
        submitBtn.disabled = true;
        try { await onSubmit(values()); dlg.close(); } catch (ex) { showErr(ex.message); } finally { submitBtn.disabled = false; }
      },
    }, rows, err, h('div', { class: 'actions-row' }, extras, h('button', { type: 'button', class: 'btn', onclick: () => dlg.close() }, 'Batal'), submitBtn));

    dlg.replaceChildren(h('div', { class: 'dlg-in' + (wide ? ' wide' : '') }, h('h2', {}, title), intro && h('p', { class: 'intro' }, intro), form));
    dlg.showModal();
    setTimeout(() => { const f = form.querySelector('input:not([type=checkbox]),textarea,select'); if (f) f.focus(); }, 0);
  }

  function infoDialog(title, content) {
    const dlg = $('#dlg');
    dlg.replaceChildren(h('div', { class: 'dlg-in wide' }, h('h2', {}, title), content, h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => dlg.close() }, 'Tutup'))));
    dlg.showModal();
  }

  function resetDialog() {
    const me = (S.me && S.me.user) || '';
    if (me !== 'admin') {
      return toast('Akses ditolak: Hanya akun admin yang dapat melakukan Clear DB', true);
    }
    const dlg = $('#dlg');
    const doReset = safe(async (mode, msg) => {
      closeTaskDrawer();
      await mutate('POST', '/api/reset', { mode });
      dlg.close();
      toast(msg);
    });

    const confirmAction = (mode, actionTitle, warningMsg, btnLabel) => {
      dlg.replaceChildren(
        h('div', { class: 'dlg-in' },
          h('h2', { style: { color: 'var(--bad)', display: 'flex', alignItems: 'center', gap: '8px' } },
            '⚠️ Konfirmasi: ' + actionTitle),
          h('p', { class: 'intro', style: { color: 'var(--text)' } },
            'Tindakan ini memerlukan konfirmasi keamanan admin.'),
          h('div', { class: 'form-err', style: { margin: '14px 0', lineHeight: '1.5' } },
            h('strong', {}, warningMsg),
            h('div', { class: 'small', style: { marginTop: '4px' } }, 'Semua data aktif yang dihapus tidak dapat dipulihkan secara otomatis.')),
          h('div', { class: 'actions' },
            h('button', { type: 'button', class: 'btn', onclick: () => resetDialog() }, 'Batal'),
            h('button', {
              type: 'button',
              class: 'btn danger',
              onclick: () => doReset(mode, actionTitle + ' berhasil'),
            }, btnLabel))));
    };

    dlg.replaceChildren(
      h('div', { class: 'dlg-in' },
        h('h2', {}, 'Clear Database (Khusus Admin)'),
        h('p', { class: 'intro' }, 'Pilih mode pembersihan data. File backup (.bak) tetap tersimpan otomatis di server.'),
        h('div', { class: 'reset-cards' },
          h('div', { class: 'reset-card' },
            h('div', {},
              h('h4', {}, 'Kosongkan Semua (0 Phase)'),
              h('p', {}, 'Hapus seluruh phase, task, change request, dan riwayat.')),
            h('button', {
              class: 'btn danger small',
              onclick: () => confirmAction('empty', 'Kosongkan Database', 'PERINGATAN: Seluruh phase, ticket/card, komentar, dan riwayat akan dihapus total (0 item)!', 'Ya, Kosongkan Database'),
            }, 'Kosongkan…')),
          h('div', { class: 'reset-card' },
            h('div', {},
              h('h4', {}, 'Reset ke Awal (Phase 1)'),
              h('p', {}, 'Hapus data lama dan buat Phase 1 baru mulai hari ini.')),
            h('button', {
              class: 'btn primary small',
              onclick: () => confirmAction('seed', 'Reset ke Phase 1', 'Data lama akan digantikan dengan template default Phase 1.', 'Ya, Reset ke Phase 1'),
            }, 'Reset Phase 1…'))),
        h('div', { class: 'actions' },
          h('button', { class: 'btn', onclick: () => dlg.close() }, 'Batal'))));
    dlg.showModal();
  }

  function phaseDialog(p) {
    const ps = phases();
    const last = ps[ps.length - 1];
    const start = p ? p.start : (last ? addDays(last.end, 1) : todayStr());
    const end = p ? p.end : addDays(start, 13);

    openForm({
      title: p ? `Edit ${p.name}` : 'Buat Phase',
      intro: p && p.locked ? 'Scope terkunci, namun tanggal tetap dapat disesuaikan.' : null,
      fields: [
        { name: 'name', label: 'Nama phase', required: true, maxlength: 80, value: p ? p.name : `Phase ${ps.length + 1}` },
        { name: 'goal', label: 'Tujuan / ringkasan scope', type: 'textarea', maxlength: 500, value: p ? p.goal : '' },
        { name: 'start', label: 'Mulai', type: 'date', required: true, value: start },
        { name: 'end', label: 'Selesai', type: 'date', required: true, value: end },
        {
          type: 'custom',
          render: (inputs) => {
            const setDur = (d) => {
              if (!inputs.start.value) inputs.start.value = todayStr();
              inputs.end.value = addDays(inputs.start.value, d - 1);
            };
            return h('div', { class: 'field' },
              h('span', {}, 'Durasi cepat'),
              h('div', { class: 'preset-row' },
                [[7, '1 Minggu'], [14, '2 Minggu'], [21, '3 Minggu'], [30, '1 Bulan']].map(([d, lbl]) =>
                  h('button', { type: 'button', class: 'btn xs', onclick: () => setDur(d) }, lbl))));
          },
        },
        { name: 'status', label: 'Status', type: 'select', options: PHASE_OPTIONS, value: p ? p.status : (ps.length === 0 ? 'active' : 'planned') },
        ...(p ? [{ name: 'cascade', label: 'Geser phase berikutnya mengikuti perubahan tanggal selesai', type: 'checkbox', value: ui.cascade }] : []),
      ],
      submit: p ? 'Simpan' : 'Buat Phase',
      onSubmit: (v) => (p ? mutate('PATCH', `/api/phases/${p.id}`, v) : mutate('POST', '/api/phases', v)),
      extraButtons: p ? [{
        label: 'Hapus Phase', danger: true,
        onClick: async () => {
          const count = tasksOf(p.id).length;
          if (!confirm(count ? `Hapus ${p.name} beserta ${count} item scope di dalamnya?` : `Hapus ${p.name}?`)) return false;
          await mutate('DELETE', `/api/phases/${p.id}`);
          return true;
        },
      }] : [],
    });
  }

  function taskDialog(ph, status = 'todo') {
    if (ph.locked) return crDialog(ph.id);
    return openForm({
      title: `Task Baru · ${ph.name}`,
      fields: [
        { name: 'title', label: 'Judul Scope / Ticket', required: true, maxlength: 200 },
        { name: 'desc', label: 'Deskripsi', type: 'textarea', maxlength: 4000, placeholder: 'Tulis deskripsi atau catatan spesifikasi...' },
        { name: 'priority', label: 'Prioritas', type: 'select', options: PRIO_OPTIONS, value: 'medium' },
        { name: 'assignee', label: 'PIC (bisa lebih dari satu, pisahkan koma)', placeholder: 'Contoh: meisy, zudev' },
        { name: 'due', label: 'Deadline', type: 'date' },
      ],
      submit: 'Tambah',
      onSubmit: (v) => {
        const assignees = (v.assignee || '').split(/[,;]+/).map((s) => s.trim()).filter(Boolean);
        return mutate('POST', '/api/tasks', { phaseId: ph.id, status, ...v, assignees });
      },
    });
  }

  function crDialog(phaseId) {
    const cur = phaseById(phaseId) || currentPhase();
    if (!cur) return toast('Buat phase terlebih dahulu', true);
    const me = (S.me && S.me.user) || '';
    return openForm({
      title: 'Ajukan Change Request (Tambahan Scope)',
      intro: 'Gunakan Change Request ketika ada permintaan fitur/perubahan baru di tengah phase agar dampaknya terhadap timeline tercatat jelas.',
      fields: [
        { name: 'title', label: 'Apa perubahan / fitur yang diminta?', required: true, maxlength: 200, placeholder: 'Contoh: Tambah ekspor laporan PDF di halaman transaksi' },
        { name: 'requestedBy', label: 'Diminta oleh (Stakeholder / Divisi)', maxlength: 80, value: me, placeholder: 'Contoh: Tim Finance / Product Owner' },
        { name: 'reason', label: 'Alasan & Dampak ke Timeline', type: 'textarea', maxlength: 1000, placeholder: 'Contoh: Dibutuhkan untuk audit akhir bulan, estimasi +2 hari kerja' },
        { name: 'desc', label: 'Detail spesifikasi / Link dokumen', type: 'textarea', maxlength: 4000, placeholder: 'Catatan detail atau link PRD / Figma...' },
        { name: 'phaseId', label: 'Diajukan pada Phase', type: 'select', options: phases().map((p) => [p.id, p.name + (p.locked ? ' (Scope Terkunci)' : '')]), value: cur.id },
      ],
      submit: 'Simpan ke Antrean CR',
      onSubmit: (v) => mutate('POST', '/api/changes', v),
    });
  }

  function decideDialog(c, decision) {
    const ph = phaseById(c.phaseId);
    const nxt = nextPhaseOf(c.phaseId);
    const cfg = {
      current: {
        title: `Setujui Masuk ${ph ? ph.name : 'Phase Ini'} (Scope Bertambah)`,
        intro: `"${c.title}" akan langsung masuk sebagai task baru berlabel CR di ${ph ? ph.name : 'phase ini'}. Kamu juga bisa memperpanjang durasi phase jika dibutuhkan.`,
        submit: 'Setujui & Masukkan ke Phase Ini',
      },
      next: {
        title: nxt ? `Geser ke ${nxt.name}` : 'Buat Phase Berikutnya & Geser',
        intro: nxt
          ? `"${c.title}" akan dimasukkan ke ${nxt.name} agar jadwal ${ph ? ph.name : 'phase sekarang'} tetap aman.`
          : `Belum ada phase setelah ${ph ? ph.name : 'ini'}. Phase berikutnya akan otomatis dibuatkan dan item "${c.title}" dimasukkan ke sana.`,
        submit: nxt ? `Geser ke ${nxt.name}` : 'Buat Phase Baru & Geser',
      },
      reject: {
        title: 'Tolak Change Request',
        intro: `"${c.title}" tidak akan dikerjakan dan tercatat sebagai ditolak di riwayat keputusan.`,
        submit: 'Tolak Permintaan',
      },
    }[decision];
    const fields = [{
      name: 'note', type: 'textarea', maxlength: 1000, required: decision === 'current',
      label: decision === 'current' ? 'Alasan kenapa wajib masuk di phase berjalan (Wajib)' : 'Catatan keputusan (opsional)',
      placeholder: decision === 'current' ? 'Contoh: Blocker regulasi / disetujui stakeholder dengan tambahan waktu 2 hari' : 'Catatan tambahan...',
    }];
    if (decision !== 'reject') fields.push({ name: 'priority', label: 'Prioritas Task', type: 'select', options: PRIO_OPTIONS, value: decision === 'current' ? 'high' : 'medium' });
    if (decision === 'current') {
      fields.push(
        { name: 'extendDays', label: 'Perpanjang durasi phase ini (hari)', type: 'number', min: 0, max: 365, step: 1, value: 0, hint: 'Isi 0 jika timeline tidak diperpanjang' },
        { name: 'cascade', label: 'Geser phase berikutnya otomatis sesuai perpanjangan', type: 'checkbox', value: true },
      );
    }
    openForm({
      ...cfg,
      fields,
      onSubmit: (v) => mutate('POST', `/api/changes/${c.id}/decide`, { decision, autoCreateNext: true, ...v }),
    });
  }

  const toggleLock = safe(async (p) => {
    if (!p.locked) {
      const n = tasksOf(p.id).length;
      if (!confirm(`Kunci scope ${p.name}?\n\n${n} item saat ini ditetapkan sebagai baseline. Penambahan baru harus melalui Change Request.`)) return;
    } else if (!confirm('Buka kunci scope phase ini?')) return;
    await mutate('POST', `/api/phases/${p.id}/lock`, { locked: !p.locked });
  });

  function logDialog() {
    const fmtTs = (ts) => new Date(ts).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' });
    infoDialog('Riwayat Perubahan', S.log.length
      ? h('ul', { class: 'log' }, S.log.map((l) => h('li', {}, h('time', {}, fmtTs(l.ts)), l.text)))
      : h('p', { class: 'empty' }, 'Belum ada riwayat.'));
  }

  /* ======================= CRYPTO-CHART INTERACTIVE TIMELINE ======================= */
  function setScalePreset(mode, px) {
    ui.scaleMode = mode;
    if (px) ui.pxPerDay = px;
    store.set('scaleMode', mode);
    if (px) store.set('pxPerDay', String(px));
    render();
  }

  function buildTimeAxis(t0, t1, pxPerDay) {
    const daysTotal = Math.round((t1 - t0) / DAY);
    const months = [];
    const ticks = [];
    const weekends = [];
    const nowT = T(todayStr());

    let stepDays = 1;
    if (pxPerDay >= 24) stepDays = 1;
    else if (pxPerDay >= 12) stepDays = 2;
    else if (pxPerDay >= 6) stepDays = 7;
    else stepDays = 30;

    let curMonthKey = '';
    const d = new Date(t0);
    d.setUTCHours(0, 0, 0, 0);

    for (let i = 0; i <= daysTotal; i++) {
      const t = t0 + i * DAY;
      const dt = new Date(t);
      const yr = dt.getUTCFullYear();
      const mo = dt.getUTCMonth();
      const dateNum = dt.getUTCDate();
      const dow = dt.getUTCDay();

      const mKey = `${yr}-${mo}`;
      if (mKey !== curMonthKey) {
        curMonthKey = mKey;
        months.push({ t, label: `${MON_FULL[mo]} ${yr}` });
      }

      if (pxPerDay >= 18 && (dow === 0 || dow === 6)) {
        weekends.push({ t });
      }

      if (stepDays === 1) {
        const lbl = pxPerDay >= 46 ? `${DOW[dow]} ${dateNum}` : `${dateNum}`;
        ticks.push({ t, label: lbl, major: dateNum === 1 || dow === 1, isToday: t === nowT });
      } else if (stepDays === 2) {
        if (i % 2 === 0) {
          ticks.push({ t, label: `${dateNum} ${MON[mo]}`, major: dateNum <= 2, isToday: t === nowT });
        }
      } else if (stepDays === 7) {
        if (dow === 1) {
          ticks.push({ t, label: `${dateNum} ${MON[mo]}`, major: true, isToday: false });
        }
      } else if (dateNum === 1) {
        ticks.push({ t, label: `${MON[mo]} '${String(yr).slice(2)}`, major: true, isToday: false });
      }
    }

    return { months, ticks, weekends, stepDays };
  }

  function attachBarDrag(barEl, canvasEl, p, spanMs) {
    let mode = null;
    let startX = 0;
    let moved = false;
    let deltaDays = 0;
    const origStart = p.start;
    const origEnd = p.end;
    const lblEl = barEl.querySelector('.g-bar-lbl');

    function onDown(e, m) {
      if (e.button !== 0) return;
      e.stopPropagation();
      mode = m;
      startX = e.clientX;
      moved = false;
      deltaDays = 0;
      dragging = true;
      barEl.classList.add('dragging-bar');
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    }

    function computeDates(d) {
      let s = origStart;
      let e = origEnd;
      if (mode === 'move') {
        s = addDays(origStart, d);
        e = addDays(origEnd, d);
      } else if (mode === 'start') {
        s = addDays(origStart, d);
        if (s > e) s = e;
      } else if (mode === 'end') {
        e = addDays(origEnd, d);
        if (e < s) e = s;
      }
      return { s, e };
    }

    function onMove(e) {
      const dx = e.clientX - startX;
      if (Math.abs(dx) > 3) moved = true;
      if (!moved) return;
      const trackWidth = canvasEl.getBoundingClientRect().width || 1;
      const totalDays = spanMs / DAY;
      const pxDay = trackWidth / totalDays;
      deltaDays = Math.round(dx / pxDay);
      const { s, e: endStr } = computeDates(deltaDays);
      const dur = days({ start: s, end: endStr });
      if (lblEl) lblEl.textContent = `${p.name} · ${fmtShort(s)} – ${fmtShort(endStr)} (${dur}h)`;

      if (mode === 'move') {
        barEl.style.transform = `translateX(${deltaDays * pxDay}px)`;
      } else if (mode === 'end') {
        barEl.style.width = `${Math.max(14, dur * pxDay)}px`;
      } else if (mode === 'start') {
        const shift = Math.round((T(s) - T(origStart)) / DAY);
        barEl.style.transform = `translateX(${shift * pxDay}px)`;
        barEl.style.width = `${Math.max(14, dur * pxDay)}px`;
      }
    }

    async function onUp() {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      barEl.classList.remove('dragging-bar');
      barEl.style.transform = '';
      dragging = false;

      if (!moved) {
        jumpToPhase(p.id);
        return;
      }
      const { s, e } = computeDates(deltaDays);
      if (s === origStart && e === origEnd) {
        render();
        return;
      }
      try {
        await mutate('PATCH', `/api/phases/${p.id}`, {
          name: p.name, goal: p.goal, status: p.status,
          start: s, end: e, cascade: ui.cascade,
        });
      } catch (err) {
        toast(err.message, true);
        render();
      }
    }

    barEl.querySelector('.g-handle.left').addEventListener('mousedown', (e) => onDown(e, 'start'));
    barEl.querySelector('.g-handle.right').addEventListener('mousedown', (e) => onDown(e, 'end'));
    barEl.addEventListener('mousedown', (e) => onDown(e, 'move'));
    barEl.addEventListener('dblclick', (e) => { e.stopPropagation(); phaseDialog(p); });
  }

  function ganttChart(ps) {
    const minP = Math.min(...ps.map((p) => T(p.start)));
    const maxP = Math.max(...ps.map((p) => T(p.end)));
    const now = T(todayStr());

    const padBefore = ui.scaleMode === 'fit' ? 2 * DAY : 5 * DAY;
    const padAfter = ui.scaleMode === 'fit' ? 3 * DAY : 10 * DAY;
    const t0 = minP - padBefore;
    const t1 = Math.max(maxP + padAfter, t0 + 14 * DAY);
    const span = t1 - t0;
    const totalDays = Math.round(span / DAY);

    const vpEstWidth = Math.max(520, Math.min(1360, window.innerWidth - 40) - 232);
    const effectivePxPerDay = ui.scaleMode === 'fit'
      ? Math.max(4, vpEstWidth / totalDays)
      : Math.max(4, Math.min(120, ui.pxPerDay));

    const canvasWidthStyle = ui.scaleMode === 'fit'
      ? '100%'
      : `${Math.max(vpEstWidth, Math.round(totalDays * effectivePxPerDay))}px`;

    const pct = (t) => ((t - t0) / span) * 100;
    const dayWidthPct = (DAY / span) * 100;
    const { months, ticks, weekends, stepDays } = buildTimeAxis(t0, t1, effectivePxPerDay);
    const showToday = now >= t0 && now <= t1;

    const timeHead = h('div', {
      class: 'g-time-head',
      title: 'Tarik kiri/kanan (drag) atau scroll untuk stretch skala hari seperti chart',
    },
    h('div', { class: 'g-months' },
      months.map((m) => h('span', { style: { left: pct(m.t) + '%' } }, m.label))),
    h('div', { class: 'g-axis' },
      ticks.map((k) => h('span', {
        class: k.isToday ? 'is-today' : '',
        style: { left: pct(k.t) + '%' },
      }, k.label)),
      showToday && stepDays > 1 && h('span', { class: 'today-flag', style: { left: pct(now) + '%' } }, 'Hari ini')));

    const canvas = h('div', { class: 'g-canvas', style: { width: canvasWidthStyle } },
      timeHead,
      h('div', { class: 'g-grid' },
        weekends.map((w) => h('div', { class: 'wknd', style: { left: pct(w.t) + '%', width: dayWidthPct + '%' } })),
        ticks.map((k) => h('i', { class: k.major ? 'major' : '', style: { left: pct(k.t) + '%' } })),
        showToday && h('div', { class: 'today-line', style: { left: pct(now + DAY * 0.5) + '%' } })));

    const rowsWrap = h('div', { class: 'g-rows' });
    ps.forEach((p) => {
      const st = stats(p);
      const dur = days(p);
      const barEl = h('div', {
        class: 'g-bar ' + p.status + (p.locked ? ' locked' : ''),
        title: `${p.name} (${fmtShort(p.start)} – ${fmtShort(p.end)} · ${dur} hari)\nDrag untuk geser, tarik tepi untuk ubah durasi, klik 2x untuk edit`,
        style: {
          left: pct(T(p.start)) + '%',
          width: Math.max(0.8, ((T(p.end) + DAY - T(p.start)) / span) * 100) + '%',
        },
      },
      h('div', { class: 'g-handle left', title: 'Ubah tanggal mulai' }),
      h('div', { class: 'g-fill', style: { width: st.pct + '%' } }),
      h('span', { class: 'g-bar-lbl' }, `${p.name} · ${fmtShort(p.start)} – ${fmtShort(p.end)} (${dur}h)`),
      h('span', { class: 'g-bar-pct' }, `${st.pct}%`),
      h('div', { class: 'g-handle right', title: 'Ubah tanggal selesai' }));

      attachBarDrag(barEl, canvas, p, span);
      rowsWrap.append(h('div', { class: 'g-track-row' }, barEl));
    });
    canvas.append(rowsWrap);

    const viewport = h('div', { class: 'g-viewport' }, canvas);

    timeHead.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startPx = effectivePxPerDay;
      const anchorRatio = (viewport.scrollLeft + (e.clientX - viewport.getBoundingClientRect().left)) / (canvas.getBoundingClientRect().width || 1);

      function onMove(ev) {
        const dx = ev.clientX - startX;
        const factor = Math.exp(dx * 0.006);
        const nextPx = Math.max(5, Math.min(110, Math.round(startPx * factor)));
        if (nextPx !== ui.pxPerDay || ui.scaleMode === 'fit') {
          ui.scaleMode = 'custom';
          ui.pxPerDay = nextPx;
          const newW = Math.max(vpEstWidth, Math.round(totalDays * nextPx));
          ui.scrollLeft = Math.max(0, anchorRatio * newW - (ev.clientX - viewport.getBoundingClientRect().left));
          render();
        }
      }
      function onUp() {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        store.set('scaleMode', ui.scaleMode);
        store.set('pxPerDay', String(ui.pxPerDay));
      }
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });

    viewport.addEventListener('wheel', (e) => {
      const onAxis = e.target.closest('.g-time-head');
      if (!onAxis && !e.ctrlKey && !e.metaKey && !e.altKey) return;
      if (Math.abs(e.deltaY) < Math.abs(e.deltaX)) return;
      e.preventDefault();
      const rect = viewport.getBoundingClientRect();
      const cursorX = e.clientX - rect.left;
      const oldW = canvas.getBoundingClientRect().width || 1;
      const anchorRatio = (viewport.scrollLeft + cursorX) / oldW;

      const factor = e.deltaY < 0 ? 1.15 : 0.87;
      const nextPx = Math.max(5, Math.min(110, Math.round(effectivePxPerDay * factor)));
      ui.scaleMode = 'custom';
      ui.pxPerDay = nextPx;
      store.set('scaleMode', 'custom');
      store.set('pxPerDay', String(nextPx));
      const newW = Math.max(vpEstWidth, Math.round(totalDays * nextPx));
      ui.scrollLeft = Math.max(0, anchorRatio * newW - cursorX);
      render();
    }, { passive: false });

    viewport.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || e.target.closest('.g-bar') || e.target.closest('.g-time-head')) return;
      const startX = e.clientX;
      const startScroll = viewport.scrollLeft;
      viewport.classList.add('panning');
      function onMove(ev) {
        viewport.scrollLeft = startScroll - (ev.clientX - startX);
        ui.scrollLeft = viewport.scrollLeft;
      }
      function onUp() {
        viewport.classList.remove('panning');
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      }
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });

    requestAnimationFrame(() => {
      if (ui.scrollLeft > 0 && ui.scaleMode !== 'fit') viewport.scrollLeft = ui.scrollLeft;
    });

    const sidebar = h('div', { class: 'g-sidebar' },
      h('div', { class: 'g-sidebar-head' },
        h('span', {}, 'Phase'),
        h('span', {}, `${ps.length}`)),
      ps.map((p) => {
        const dur = days(p);
        return h('div', { class: 'g-side-row', onclick: () => jumpToPhase(p.id) },
          h('div', { class: 'g-side-main' },
            h('div', { class: 'g-side-name' },
              h('span', { class: 'status-dot ' + p.status }),
              h('span', {}, p.name),
              p.locked && h('span', { class: 'muted small', title: 'Scope terkunci' }, '· Locked')),
            h('div', { class: 'g-side-dates' }, `${fmtShort(p.start)} – ${fmtShort(p.end)} · ${dur}h`)),
          h('div', { class: 'g-side-nudge', onclick: (e) => e.stopPropagation() },
            h('button', { class: 'btn xs', title: 'Mundur 1 hari', onclick: () => adjustPhaseDates(p, -1, -1) }, '−1h'),
            h('button', { class: 'btn xs', title: 'Maju 1 hari', onclick: () => adjustPhaseDates(p, 1, 1) }, '+1h')));
      }));

    return h('div', { class: 'gantt-outer' }, sidebar, viewport);
  }

  /* ======================= SCOPE ITEM ======================= */
  const setTaskStatus = safe(async (t, newStatus) => {
    if (t.status === newStatus) return;
    await mutate('POST', `/api/tasks/${t.id}/move`, { status: newStatus });
  });

  const deleteTaskQuick = safe(async (t) => {
    if (!confirm(`Hapus "${t.title}"?`)) return;
    if (ui.drawerTaskId === t.id) ui.drawerTaskId = null;
    await mutate('DELETE', `/api/tasks/${t.id}`);
  });

  function itemRow(t) {
    const over = t.due && t.status !== 'done' && t.due <= todayStr();
    const linksCount = (t.links || []).length;
    const commentsCount = (t.comments || []).length;
    const bCount = blockersOf(t).length;
    const pics = assigneesOf(t);

    return h('li', { class: 'scope-row' + (t.status === 'done' ? ' is-done' : '') + (bCount ? ' has-blocker' : '') },
      h('div', { class: 'scope-row-main' },
        h('div', { class: 'state-seg', role: 'group', 'aria-label': 'Status task' },
          STATUSES.map(([stKey, stLabel]) =>
            h('button', {
              type: 'button',
              class: t.status === stKey ? 'on' : '',
              dataset: { st: stKey },
              title: `Ubah ke ${stLabel}`,
              onclick: () => setTaskStatus(t, stKey),
            }, statusSvg(stKey), h('span', { class: 'st-txt' }, STATUS_SHORT[stKey])))),
        h('span', {
          class: 'scope-title',
          onclick: () => openTaskDrawer(t),
          title: 'Klik untuk buka detail ticket, blocker, dokumen & komentar',
        }, t.title),
        h('div', { class: 'scope-meta', onclick: () => openTaskDrawer(t), style: { cursor: 'pointer' } },
          bCount > 0 && badge(bCount > 1 ? `${bCount} Blocker` : 'Blocker', 'over'),
          commentsCount > 0 && badge(`${commentsCount} Komentar`, ''),
          linksCount > 0 && badge(`${linksCount} Link`, ''),
          t.origin === 'change' && badge('CR', 'cr'),
          t.priority === 'high' && badge('High', 'prio-high'),
          t.due && badge(fmtShort(t.due), over ? 'over' : ''),
          pics.length > 0 && h('span', { class: 'scope-assignee', title: `PIC: ${pics.join(', ')}` }, pics.join(', ')),
          h('button', {
            type: 'button', class: 'scope-del', title: 'Hapus item',
            onclick: (e) => { e.stopPropagation(); deleteTaskQuick(t); },
          }, '×'))));
  }

  function addItemComposer(p) {
    const titleIn = h('input', {
      class: 'composer-title',
      name: 'title',
      placeholder: 'Tambah item scope baru… (tekan Enter)',
      maxlength: 200,
      'aria-label': 'Tambah item scope',
    });
    const prioIn = h('select', { class: 'composer-pill', name: 'priority', 'aria-label': 'Prioritas', title: 'Prioritas' },
      PRIO_OPTIONS.map(([v, l]) => h('option', { value: v, selected: v === 'medium' }, l)));
    const picIn = h('select', { class: 'composer-pill', name: 'assignee', 'aria-label': 'PIC', title: 'Pilih PIC' },
      [['', 'PIC'], ...envUsers().map((u) => [u, u])].map(([v, l]) => h('option', { value: v }, l)));
    const dueIn = h('input', { class: 'composer-pill', name: 'due', type: 'date', 'aria-label': 'Deadline', title: 'Deadline' });

    if (ui.refocus === p.id) { ui.refocus = null; requestAnimationFrame(() => titleIn.focus()); }

    return h('form', {
      class: 'scope-composer',
      onsubmit: safe(async (e) => {
        e.preventDefault();
        const title = titleIn.value.trim();
        if (!title) return;
        ui.refocus = p.id;
        await mutate('POST', '/api/tasks', {
          phaseId: p.id,
          title,
          priority: prioIn.value,
          assignee: picIn.value,
          assignees: picIn.value ? [picIn.value] : [],
          due: dueIn.value,
        });
      }),
    },
    h('span', { class: 'composer-plus' }, '+'),
    titleIn,
    h('div', { class: 'composer-extras' },
      prioIn,
      picIn,
      dueIn,
      h('button', { class: 'btn xs', type: 'submit' }, 'Tambah')));
  }

  function phaseCard(p) {
    const st = stats(p);
    const items = tasksOf(p.id).sort((a, b) => a.order - b.order);
    const base = items.filter((t) => t.origin !== 'change');
    const chg = items.filter((t) => t.origin === 'change');
    const blockersCount = items.reduce((sum, t) => sum + blockersOf(t).length, 0);

    const statusSelect = h('select', {
      class: 'phase-status-sel st-' + p.status,
      'aria-label': 'Status phase',
      onchange: safe(async (e) => {
        await mutate('PATCH', `/api/phases/${p.id}`, { ...p, status: e.target.value, cascade: false });
      }),
    }, PHASE_OPTIONS.map(([v, l]) => h('option', { value: v, selected: v === p.status }, l)));

    return h('article', { class: 'panel phase ' + p.status, id: 'phase-' + p.id },
      h('div', { class: 'phase-top-bar' }, h('div', { style: { width: st.pct + '%' } })),
      h('div', { class: 'phase-header' },
        h('div', { class: 'phase-title-group' },
          h('h3', {}, p.name),
          statusSelect,
          p.locked && badge('Locked', 'lock'),
          blockersCount > 0 && badge(`${blockersCount} Blocker`, 'over'),
          h('div', { class: 'phase-meta-inline' },
            h('span', {}, `${fmt(p.start)} – ${fmt(p.end)} (${days(p)}h)`),
            h('span', {}, `· ${st.done}/${st.total} selesai (${st.pct}%)`))),
        h('div', { class: 'phase-actions' },
          h('button', { class: 'btn xs ghost', onclick: () => adjustPhaseDates(p, 0, -1), title: 'Kurangi durasi 1 hari' }, '−1h'),
          h('button', { class: 'btn xs ghost', onclick: () => adjustPhaseDates(p, 0, 1), title: 'Tambah durasi 1 hari' }, '+1h'),
          h('button', { class: 'btn small', onclick: () => openPhaseInKanban(p.id) }, 'Kanban →'),
          h('button', { class: 'btn small', onclick: () => toggleLock(p) }, p.locked ? 'Buka Kunci' : 'Kunci Scope'),
          h('button', { class: 'btn small ghost', onclick: () => phaseDialog(p) }, 'Edit'),
          h('button', { class: 'btn small ghost danger-text', onclick: () => deletePhaseDirect(p), title: 'Hapus Phase ini' }, 'Hapus'))),
      p.goal && h('div', { class: 'phase-goal' }, renderLinkedText(p.goal)),
      p.locked && h('div', { class: 'phase-lock-banner' },
        h('span', {}, `Baseline terkunci (${p.baselineCount} item · ${fmt(p.approvedAt.slice(0, 10))}). Permintaan baru wajib lewat Change Request.`),
        h('button', { class: 'btn xs', onclick: () => crDialog(p.id) }, '+ Change Request')),
      h('div', { class: 'scope-section-label' },
        h('span', {}, `SCOPE (${base.length})`),
        h('span', {}, 'Klik item untuk detail & komentar')),
      base.length
        ? h('ul', { class: 'scope-list' }, base.map(itemRow))
        : h('div', { class: 'empty', style: { padding: '14px' } }, 'Belum ada item scope.'),
      chg.length ? [
        h('div', { class: 'scope-section-label' }, h('span', {}, `TAMBAHAN DARI CHANGE REQUEST (${chg.length})`)),
        h('ul', { class: 'scope-list' }, chg.map(itemRow)),
      ] : null,
      !p.locked && addItemComposer(p));
  }

  /* ======================= UX-FRIENDLY CHANGE REQUEST PANEL ======================= */
  function crCard(c) {
    const ph = phaseById(c.phaseId);
    const nxt = ph ? nextPhaseOf(ph.id) : null;
    const phName = ph ? ph.name : (c.phaseName || 'Phase');

    return h('div', { class: 'cr' },
      h('div', { class: 'cr-top' },
        badge(`Target: ${phName}`, 'st-active'),
        h('button', {
          class: 'btn xs ghost', title: 'Batalkan / hapus pengajuan ini',
          onclick: safe(async () => { if (confirm('Hapus pengajuan Change Request ini?')) await mutate('DELETE', `/api/changes/${c.id}`); }),
        }, '×')),
      h('h4', {}, c.title),
      h('div', { class: 'meta' },
        c.requestedBy && h('span', {}, `Oleh: ${c.requestedBy}`),
        c.requestedBy && h('span', {}, '·'),
        h('span', {}, `Diajukan ${fmtShort(c.createdAt.slice(0, 10))}`)),
      c.desc && h('p', {}, renderLinkedText(c.desc)),
      c.reason && h('div', { class: 'cr-impact' }, `Alasan / Dampak: ${c.reason}`),
      h('div', { class: 'cr-decision-box' },
        h('span', { class: 'cr-decision-lbl' }, 'Putuskan Tindakan Scope:'),
        h('div', { class: 'btns' },
          ph && h('button', {
            class: 'btn xs primary',
            title: `Masukkan ke ${ph.name} sekarang (bisa disertai perpanjangan hari)`,
            onclick: () => decideDialog(c, 'current'),
          }, `+ Masuk ${ph.name}`),
          h('button', {
            class: 'btn xs',
            title: nxt ? `Jangan ganggu ${phName}, kerjakan di ${nxt.name}` : 'Otomatis buat phase berikutnya dan geser ke sana',
            onclick: () => decideDialog(c, 'next'),
          }, nxt ? `→ Geser ke ${nxt.name}` : '→ Buat Phase Baru & Geser'),
          h('button', {
            class: 'btn xs danger',
            title: 'Tolak permintaan perubahan ini',
            onclick: () => decideDialog(c, 'reject'),
          }, 'Tolak'))));
  }

  function crDone(c) {
    let outcome;
    let badgeCls = '';
    if (c.status === 'rejected') { outcome = 'Ditolak'; badgeCls = 'over'; }
    else if (c.decision === 'current') { outcome = `Masuk ${c.decidedPhaseName}${c.extendDays ? ` (+${c.extendDays}h)` : ''}`; badgeCls = 'st-active'; }
    else { outcome = `Digeser ke ${c.decidedPhaseName}`; badgeCls = 'st-done'; }

    return h('div', { class: 'cr done' },
      h('div', { class: 'cr-top' },
        h('h4', {}, c.title),
        badge(outcome, badgeCls)),
      h('div', { class: 'meta' },
        c.requestedBy && h('span', {}, `Oleh: ${c.requestedBy} · `),
        c.decidedAt && h('span', {}, `Diputuskan ${fmtShort(c.decidedAt.slice(0, 10))}`)),
      c.decisionNote && h('p', { class: 'why muted' }, `Catatan: ${c.decisionNote}`));
  }

  function changePanel() {
    const pending = S.changes.filter((c) => c.status === 'pending');
    const decided = S.changes.filter((c) => c.status !== 'pending').sort((a, b) => (b.decidedAt || '').localeCompare(a.decidedAt || ''));
    return h('aside', { class: 'panel changes' + (pending.length ? ' has-pending' : '') },
      h('div', { class: 'panel-head' },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
          h('h2', {}, 'Change Requests'),
          pending.length > 0 && h('span', { class: 'pill', style: { marginLeft: 0 } }, pending.length)),
        h('button', { class: 'btn xs primary', onclick: () => crDialog() }, '+ Ajukan CR')),
      h('div', { class: 'cr-explainer' },
        'Pintu kendali scope: catat permintaan tambahan fitur dari stakeholder di sini, lalu putuskan apakah wajib masuk phase berjalan, digeser ke phase berikutnya, atau ditolak.'),
      pending.length
        ? pending.map(crCard)
        : h('p', { class: 'empty', style: { padding: '14px 8px' } }, 'Tidak ada pengajuan perubahan yang menunggu keputusan.'),
      decided.length ? h('details', { open: !pending.length }, h('summary', {}, `Riwayat Keputusan (${decided.length})`), decided.map(crDone)) : null);
  }

  function timelineView() {
    const ps = phases();
    const totalTasks = S.tasks.length;
    const doneTasks = S.tasks.filter((t) => t.status === 'done').length;
    const pct = totalTasks ? Math.round((doneTasks / totalTasks) * 100) : 0;

    return h('div', { class: 'wrap' },
      h('section', { class: 'panel chart-panel' },
        h('div', { class: 'chart-toolbar' },
          h('div', { class: 'chart-title-group' },
            h('h2', {}, 'Timeline'),
            ps.length ? h('div', { class: 'chart-metrics' },
              h('span', {}, `${ps.length} Phase`),
              h('span', {}, `${doneTasks}/${totalTasks} selesai (${pct}%)`),
              h('span', {}, `${days({ start: ps[0].start, end: ps[ps.length - 1].end })} hari total`)) : null),
          h('div', { class: 'chart-controls' },
            h('label', { class: 'cascade-switch', title: 'Geser phase berikutnya otomatis saat jadwal berubah' },
              h('input', {
                type: 'checkbox', checked: ui.cascade,
                onchange: (e) => { ui.cascade = e.target.checked; store.set('cascade', ui.cascade ? '1' : '0'); },
              }),
              'Auto-cascade'),
            h('div', { class: 'seg-group', title: 'Resolusi skala timeline' },
              h('button', { class: ui.scaleMode === '1d' ? 'on' : '', onclick: () => setScalePreset('1d', 44) }, '1H'),
              h('button', { class: ui.scaleMode === '3d' ? 'on' : '', onclick: () => setScalePreset('3d', 20) }, '2H'),
              h('button', { class: ui.scaleMode === '1w' ? 'on' : '', onclick: () => setScalePreset('1w', 10) }, '1M'),
              h('button', { class: ui.scaleMode === 'fit' ? 'on' : '', onclick: () => setScalePreset('fit') }, 'Penuh')),
            h('button', { class: 'btn primary small', onclick: () => phaseDialog() }, '+ Phase'))),
        ps.length ? [
          ganttChart(ps),
          h('div', { class: 'chart-foot' },
            h('span', {}, 'Tarik header tanggal kiri/kanan untuk stretch skala waktu (1 hari penuh s/d bulanan) · Geser bar untuk ubah jadwal'),
            h('span', {}, ui.scaleMode === 'fit' ? 'Skala: Penuh (Fit)' : `Zoom: ${ui.pxPerDay}px / hari`)),
        ] : h('div', { class: 'empty' },
          h('p', { style: { marginBottom: '10px' } }, 'Belum ada phase.'),
          h('button', { class: 'btn primary small', onclick: () => phaseDialog() }, '+ Buat Phase Pertama'))),
      ps.length ? h('div', { class: 'split' }, h('div', { class: 'phases' }, ps.map(phaseCard)), changePanel()) : null);
  }

  /* ======================= KANBAN ======================= */
  const taskText = (t) => `${t.title} ${assigneesOf(t).join(' ')} ${t.desc} ${blockersOf(t).map((b) => b.text).join(' ')}`.toLowerCase();
  const moveTask = safe((id, status, index) => mutate('POST', `/api/tasks/${id}/move`, { status, index }));

  function clearDrop() { document.querySelectorAll('.drop-line').forEach((e) => e.remove()); }
  function dropIndex(body, y) {
    const cards = [...body.querySelectorAll('.tcard:not(.dragging)')];
    const i = cards.findIndex((c) => { const r = c.getBoundingClientRect(); return y < r.top + r.height / 2; });
    return { i: i < 0 ? cards.length : i, cards };
  }
  function showDrop(body, y) {
    clearDrop();
    const { i, cards } = dropIndex(body, y);
    const line = h('div', { class: 'drop-line' });
    if (cards[i]) body.insertBefore(line, cards[i]); else body.append(line);
  }

  function taskCard(t) {
    const over = t.due && t.status !== 'done' && t.due <= todayStr();
    const idx = STATUSES.findIndex((s) => s[0] === t.status);
    const linksCount = (t.links || []).length;
    const commentsCount = (t.comments || []).length;
    const bCount = blockersOf(t).length;
    const pics = assigneesOf(t);
    const mv = (to, label) => h('button', {
      title: 'Pindah ke ' + STATUSES[to][1], 'aria-label': label,
      onclick: (e) => { e.stopPropagation(); moveTask(t.id, STATUSES[to][0]); },
    }, label);

    return h('div', {
      class: 'tcard prio-' + t.priority + (bCount ? ' has-blocker' : ''),
      draggable: 'true',
      dataset: { id: t.id, q: taskText(t) },
      onclick: () => openTaskDrawer(t),
      ondragstart: (e) => {
        dragging = true; dragId = t.id;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', t.id);
        e.currentTarget.classList.add('dragging');
      },
      ondragend: (e) => { e.currentTarget.classList.remove('dragging'); dragging = false; dragId = null; clearDrop(); },
    },
    h('div', { class: 'tt' }, t.title),
    h('div', { class: 'tmeta' },
      bCount > 0 && badge(bCount > 1 ? `${bCount} Blocker` : 'Blocker', 'over'),
      commentsCount > 0 && badge(`${commentsCount} Komentar`, ''),
      linksCount > 0 && badge(`${linksCount} Link`, ''),
      t.origin === 'change' && badge('CR', 'cr'),
      t.priority === 'high' && badge('High', 'prio-high'),
      t.due && badge(fmtShort(t.due), over ? 'over' : ''),
      pics.length > 0 && h('div', { class: 'card-avatars', title: `PIC: ${pics.join(', ')}` },
        pics.map((p) => h('span', { class: 'avatar', title: `PIC: ${p}` }, initials(p))))),
    h('div', { class: 'mv' }, idx > 0 && mv(idx - 1, '←'), idx < STATUSES.length - 1 && mv(idx + 1, '→')));
  }

  function column(ph, [sid, label]) {
    const ts = tasksOf(ph.id).filter((t) => t.status === sid).sort((a, b) => a.order - b.order);
    const body = h('div', { class: 'col-body', dataset: { status: sid } }, ts.map(taskCard));
    body.addEventListener('dragover', (e) => {
      if (!dragId) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      showDrop(body, e.clientY);
    });
    body.addEventListener('dragleave', (e) => { if (!body.contains(e.relatedTarget)) clearDrop(); });
    body.addEventListener('drop', (e) => {
      e.preventDefault();
      const id = dragId;
      const { i } = dropIndex(body, e.clientY);
      clearDrop();
      dragging = false; dragId = null;
      if (id) moveTask(id, sid, i);
    });
    return h('section', { class: 'col' },
      h('div', { class: 'col-head' },
        statusSvg(sid),
        h('span', {}, label),
        h('span', { class: 'count' }, ts.length),
        h('button', { title: ph.locked ? 'Ajukan perubahan' : 'Tambah task', onclick: () => taskDialog(ph, sid) }, '+')),
      body);
  }

  function applyFilter() {
    const q = ui.q.trim().toLowerCase();
    document.querySelectorAll('.col').forEach((col) => {
      let n = 0;
      col.querySelectorAll('.tcard').forEach((c) => {
        const show = !q || c.dataset.q.includes(q);
        c.hidden = !show;
        if (show) n++;
      });
      const cnt = col.querySelector('.count');
      if (cnt) cnt.textContent = n;
    });
  }

  function kanbanView() {
    const ps = phases();
    if (!ps.length) {
      return h('div', { class: 'panel empty' },
        h('p', { style: { marginBottom: '10px' } }, 'Belum ada phase.'),
        h('button', { class: 'btn primary small', onclick: () => phaseDialog() }, '+ Buat Phase'));
    }
    const ph = ps.find((p) => p.id === ui.phaseId) || currentPhase();
    return h('div', {},
      h('div', { class: 'toolbar' },
        h('select', {
          'aria-label': 'Pilih phase',
          onchange: (e) => { ui.phaseId = e.target.value; store.set('phaseId', ui.phaseId); render(); },
        }, ps.map((p) => h('option', { value: p.id, selected: p.id === ph.id }, p.name + (p.status === 'active' ? ' · Berjalan' : p.status === 'done' ? ' · Selesai' : '')))),
        h('span', { class: 'muted small' }, `${fmt(ph.start)} – ${fmt(ph.end)} (${days(ph)}h)`),
        ph.locked && badge('Locked', 'lock'),
        h('button', { class: 'btn small ghost', onclick: () => { ui.view = 'timeline'; store.set('view', 'timeline'); render(); setTimeout(() => jumpToPhase(ph.id), 40); } }, '← Timeline'),
        h('input', {
          type: 'search', placeholder: 'Filter task / blocker…', value: ui.q, 'aria-label': 'Filter task',
          oninput: (e) => { ui.q = e.target.value; applyFilter(); },
        }),
        ph.locked
          ? h('button', { class: 'btn small', onclick: () => crDialog(ph.id) }, '+ Change Request')
          : h('button', { class: 'btn primary small', onclick: () => taskDialog(ph) }, '+ Task')),
      h('div', { class: 'board' }, STATUSES.map((s) => column(ph, s))));
  }

  /* ======================= RENDER & INIT ======================= */
  function render() {
    const y = window.scrollY;
    const drawerBody = document.querySelector('.drawer-body');
    const dy = drawerBody ? drawerBody.scrollTop : 0;

    updateUserButton();
    if (ui.needLogin) {
      $('#app').replaceChildren(loginView());
      renderDrawer();
      return;
    }

    $('#app').replaceChildren(ui.view === 'kanban' ? kanbanView() : timelineView());
    document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.view === ui.view));
    const pend = S.changes.filter((c) => c.status === 'pending').length;
    const pb = $('#pending-badge');
    pb.textContent = pend;
    pb.hidden = !pend;
    if (ui.view === 'kanban') applyFilter();
    renderDrawer();
    const newDrawerBody = document.querySelector('.drawer-body');
    if (newDrawerBody && dy) newDrawerBody.scrollTop = dy;
    window.scrollTo(0, y);
  }

  function init() {
    applyTheme();
    $('#btn-theme').addEventListener('click', () => {
      ui.theme = ui.theme === 'dark' ? 'light' : 'dark';
      store.set('theme', ui.theme);
      applyTheme();
    });
    $('#btn-user').addEventListener('click', () => {
      if (ui.needLogin) return;
      userDialog();
    });
    $('#tabs').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-view]');
      if (!b) return;
      ui.view = b.dataset.view;
      store.set('view', ui.view);
      render();
    });
    $('#btn-log').addEventListener('click', logDialog);
    $('#btn-export').addEventListener('click', () => { window.location.href = '/api/export'; });
    $('#btn-reset').addEventListener('click', resetDialog);
    $('#file-import').addEventListener('change', safe(async (e) => {
      const f = e.target.files[0];
      e.target.value = '';
      if (!f) return;
      let data;
      try { data = JSON.parse(await f.text()); } catch (_) { throw new Error('File bukan JSON yang valid'); }
      if (!confirm('Semua data saat ini akan diganti dengan isi file backup. Lanjutkan?')) return;
      await mutate('POST', '/api/import', data);
      toast('Backup berhasil dipulihkan');
    }));
    const dlg = $('#dlg');
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
    const backdrop = $('#drawer-backdrop');
    if (backdrop) backdrop.addEventListener('click', closeTaskDrawer);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && ui.drawerTaskId && !dlg.open) closeTaskDrawer();
    });
    document.addEventListener('dragend', () => { dragging = false; dragId = null; clearDrop(); }, true);

    setInterval(async () => {
      if (document.hidden || dragging || dlg.open || ui.drawerTaskId || ui.needLogin) return;
      const a = document.activeElement;
      if (a && a.closest && a.closest('#app') && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && a.value) return;
      try {
        const r = await api('GET', '/api/rev');
        if (r.rev !== S.rev) { S = await api('GET', '/api/state'); render(); }
      } catch (_) { /* abaikan */ }
    }, 15000);

    api('GET', '/api/state').then((d) => { S = d; render(); }).catch((e) => {
      if (!ui.needLogin) {
        $('#app').replaceChildren(h('p', { class: 'empty' }, 'Gagal memuat data: ' + e.message));
      }
    });
  }

  init();
})();
