'use strict';
(() => {
  /* ======================= konstanta & state ======================= */
  const DAY = 86400000;
  const STATUSES = [['todo', 'To Do'], ['doing', 'In Progress'], ['review', 'Review'], ['done', 'Done']];
  const STATUS_LABEL = Object.fromEntries(STATUSES);
  const PRIO_OPTIONS = [['low', 'Rendah'], ['medium', 'Sedang'], ['high', 'Tinggi']];
  const PHASE_OPTIONS = [['planned', 'Direncanakan'], ['active', 'Berjalan'], ['done', 'Selesai']];
  const PHASE_LABEL = Object.fromEntries(PHASE_OPTIONS);
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (_) { /* abaikan */ } },
  };

  let S = { rev: 0, phases: [], tasks: [], changes: [], log: [] };
  const ui = { view: store.get('view') === 'kanban' ? 'kanban' : 'timeline', phaseId: store.get('phaseId'), q: '', refocus: null };
  let dragging = false;
  let dragId = null;

  /* ======================= util DOM ======================= */
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
  const badge = (text, cls) => h('span', { class: 'badge ' + cls }, text);

  /* ======================= tanggal ======================= */
  const T = (s) => Date.parse(s + 'T00:00:00Z');
  const fmt = (s) => new Date(T(s)).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const fmtShort = (s) => new Date(T(s)).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  const pad = (n) => String(n).padStart(2, '0');
  const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const addDays = (s, n) => new Date(T(s) + n * DAY).toISOString().slice(0, 10);
  const days = (p) => Math.round((T(p.end) - T(p.start)) / DAY) + 1;

  /* ======================= data helper ======================= */
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
  const initials = (n) => n.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');

  /* ======================= API ======================= */
  async function api(method, url, body) {
    const opt = { method, headers: {} };
    if (method !== 'GET') { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body ?? {}); }
    const res = await fetch(url, opt);
    let data = null;
    try { data = await res.json(); } catch (_) { /* bukan JSON */ }
    if (!res.ok) throw new Error((data && data.error) || `Gagal (${res.status})`);
    return data;
  }
  async function mutate(method, url, body) { S = await api(method, url, body); render(); }

  let toastTimer;
  function toast(msg, isErr) {
    const el = $('#toast');
    el.textContent = msg;
    el.className = 'show' + (isErr ? ' err' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.className = ''; }, 4000);
  }
  const safe = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, true); } };

  /* ======================= dialog ======================= */
  function openForm({ title, intro, fields, submit = 'Simpan', onSubmit, extraButtons = [] }) {
    const dlg = $('#dlg');
    const err = h('div', { class: 'form-err', role: 'alert', hidden: true });
    const inputs = {};
    const showErr = (m) => { err.textContent = m; err.hidden = false; };

    const rows = fields.map((f) => {
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

    const values = () => Object.fromEntries(fields.map((f) => {
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

    dlg.replaceChildren(h('div', { class: 'dlg-in' }, h('h2', {}, title), intro && h('p', { class: 'intro' }, intro), form));
    dlg.showModal();
    setTimeout(() => { const f = form.querySelector('input:not([type=checkbox]),textarea,select'); if (f) f.focus(); }, 0);
  }

  function infoDialog(title, content) {
    const dlg = $('#dlg');
    dlg.replaceChildren(h('div', { class: 'dlg-in wide' }, h('h2', {}, title), content, h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => dlg.close() }, 'Tutup'))));
    dlg.showModal();
  }

  /* ---- dialog spesifik ---- */
  function phaseDialog(p) {
    const ps = phases();
    const last = ps[ps.length - 1];
    const start = p ? p.start : (last ? addDays(last.end, 1) : todayStr());
    openForm({
      title: p ? `Edit ${p.name}` : 'Phase baru',
      intro: p && p.locked ? 'Scope phase ini terkunci, tapi tanggal tetap bisa disesuaikan. Perubahan tercatat di riwayat.' : null,
      fields: [
        { name: 'name', label: 'Nama phase', required: true, maxlength: 80, value: p ? p.name : `Phase ${ps.length + 1}` },
        { name: 'goal', label: 'Tujuan / ringkasan scope', type: 'textarea', maxlength: 500, value: p ? p.goal : '' },
        { name: 'start', label: 'Mulai', type: 'date', required: true, value: start },
        { name: 'end', label: 'Selesai', type: 'date', required: true, value: p ? p.end : addDays(start, 13) },
        { name: 'status', label: 'Status', type: 'select', options: PHASE_OPTIONS, value: p ? p.status : 'planned' },
        ...(p ? [{ name: 'cascade', label: 'Geser phase berikutnya mengikuti perubahan tanggal selesai', type: 'checkbox', value: false }] : []),
      ],
      submit: p ? 'Simpan' : 'Buat phase',
      onSubmit: (v) => (p ? mutate('PATCH', `/api/phases/${p.id}`, v) : mutate('POST', '/api/phases', v)),
      extraButtons: p ? [{
        label: 'Hapus phase', danger: true,
        onClick: async () => { if (!confirm(`Hapus ${p.name}?`)) return false; await mutate('DELETE', `/api/phases/${p.id}`); return true; },
      }] : [],
    });
  }

  function taskDialog(ph, status = 'todo') {
    if (ph.locked) return crDialog(ph.id);
    return openForm({
      title: `Task baru · ${ph.name}`,
      fields: [
        { name: 'title', label: 'Judul', required: true, maxlength: 200 },
        { name: 'desc', label: 'Deskripsi', type: 'textarea', maxlength: 4000 },
        { name: 'priority', label: 'Prioritas', type: 'select', options: PRIO_OPTIONS, value: 'medium' },
        { name: 'assignee', label: 'PIC', maxlength: 60 },
        { name: 'due', label: 'Deadline', type: 'date' },
      ],
      submit: 'Tambah',
      onSubmit: (v) => mutate('POST', '/api/tasks', { phaseId: ph.id, status, ...v }),
    });
  }

  function editTaskDialog(t) {
    const cr = t.crId ? S.changes.find((c) => c.id === t.crId) : null;
    openForm({
      title: 'Edit task',
      intro: t.origin === 'change' ? `Masuk lewat change request${cr && cr.requestedBy ? ' dari ' + cr.requestedBy : ''}${cr && cr.decisionNote ? ' — ' + cr.decisionNote : ''}.` : null,
      fields: [
        { name: 'title', label: 'Judul', required: true, maxlength: 200, value: t.title },
        { name: 'desc', label: 'Deskripsi', type: 'textarea', maxlength: 4000, value: t.desc },
        { name: 'status', label: 'Status', type: 'select', options: STATUSES, value: t.status },
        { name: 'priority', label: 'Prioritas', type: 'select', options: PRIO_OPTIONS, value: t.priority },
        { name: 'assignee', label: 'PIC', maxlength: 60, value: t.assignee },
        { name: 'due', label: 'Deadline', type: 'date', value: t.due },
        { name: 'phaseId', label: 'Phase', type: 'select', options: phases().map((p) => [p.id, p.name + (p.locked ? ' 🔒' : '')]), value: t.phaseId },
      ],
      onSubmit: (v) => mutate('PATCH', `/api/tasks/${t.id}`, v),
      extraButtons: [{
        label: 'Hapus', danger: true,
        onClick: async () => { if (!confirm('Hapus task ini?')) return false; await mutate('DELETE', `/api/tasks/${t.id}`); return true; },
      }],
    });
  }

  function crDialog(phaseId) {
    const cur = phaseById(phaseId) || currentPhase();
    if (!cur) return toast('Buat phase dulu', true);
    return openForm({
      title: 'Ajukan perubahan',
      intro: 'Catat permintaan dari stakeholder. Setelah itu putuskan: wajib masuk phase ini, digeser ke phase berikutnya, atau ditolak.',
      fields: [
        { name: 'title', label: 'Apa yang diminta', required: true, maxlength: 200 },
        { name: 'desc', label: 'Detail', type: 'textarea', maxlength: 4000 },
        { name: 'requestedBy', label: 'Diminta oleh', maxlength: 80 },
        { name: 'reason', label: 'Alasan / dampak ke timeline', type: 'textarea', maxlength: 1000 },
        { name: 'phaseId', label: 'Diajukan saat phase', type: 'select', options: phases().map((p) => [p.id, p.name]), value: cur.id },
      ],
      submit: 'Ajukan',
      onSubmit: (v) => mutate('POST', '/api/changes', v),
    });
  }

  function decideDialog(c, decision) {
    const ph = phaseById(c.phaseId);
    const nxt = nextPhaseOf(c.phaseId);
    const cfg = {
      current: { title: `Wajib masuk ${ph ? ph.name : 'phase ini'}`, intro: `"${c.title}" akan jadi task baru di ${ph ? ph.name : 'phase ini'} (ditandai CR). Scope baseline tidak diubah.`, submit: 'Setujui & masukkan' },
      next: { title: `Geser ke ${nxt ? nxt.name : 'phase berikutnya'}`, intro: `"${c.title}" masuk ${nxt ? nxt.name : 'phase berikutnya'} sebagai task baru (ditandai CR). Phase sekarang tidak terganggu.`, submit: 'Geser' },
      reject: { title: 'Tolak perubahan', intro: `"${c.title}" tidak dikerjakan.`, submit: 'Tolak' },
    }[decision];
    const fields = [{
      name: 'note', type: 'textarea', maxlength: 1000, required: decision === 'current',
      label: decision === 'current' ? 'Alasan kenapa wajib masuk sekarang' : 'Catatan keputusan (opsional)',
    }];
    if (decision !== 'reject') fields.push({ name: 'priority', label: 'Prioritas task', type: 'select', options: PRIO_OPTIONS, value: decision === 'current' ? 'high' : 'medium' });
    if (decision === 'current') {
      fields.push(
        { name: 'extendDays', label: 'Perpanjang timeline phase (hari)', type: 'number', min: 0, max: 365, step: 1, value: 0, hint: '0 = tanpa perpanjangan' },
        { name: 'cascade', label: 'Geser juga phase berikutnya sebanyak itu', type: 'checkbox', value: true },
      );
    }
    openForm({ ...cfg, fields, onSubmit: (v) => mutate('POST', `/api/changes/${c.id}/decide`, { decision, ...v }) });
  }

  const toggleLock = safe(async (p) => {
    if (!p.locked) {
      const n = tasksOf(p.id).length;
      if (!confirm(`Kunci scope ${p.name}?\n\n${n} item saat ini menjadi baseline yang disetujui. Item baru setelah ini harus lewat Change Request.`)) return;
    } else if (!confirm('Buka kunci scope? Ini akan tercatat di riwayat.')) return;
    await mutate('POST', `/api/phases/${p.id}/lock`, { locked: !p.locked });
  });

  function logDialog() {
    const fmtTs = (ts) => new Date(ts).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' });
    infoDialog('Riwayat scope & timeline', S.log.length
      ? h('ul', { class: 'log' }, S.log.map((l) => h('li', {}, h('time', {}, fmtTs(l.ts)), l.text)))
      : h('p', { class: 'empty' }, 'Belum ada riwayat.'));
  }

  /* ======================= TIMELINE ======================= */
  function ticks(t0, t1) {
    const out = [];
    const span = (t1 - t0) / DAY;
    if (span <= 75) {
      const d = new Date(t0);
      d.setUTCHours(0, 0, 0, 0);
      while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
      for (; +d <= t1; d.setUTCDate(d.getUTCDate() + 7)) out.push({ t: +d, label: `${d.getUTCDate()} ${MON[d.getUTCMonth()]}` });
    } else {
      const s = new Date(t0);
      const d = new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth() + 1, 1));
      for (; +d <= t1; d.setUTCMonth(d.getUTCMonth() + 1)) out.push({ t: +d, label: `${MON[d.getUTCMonth()]} ${String(d.getUTCFullYear()).slice(2)}` });
    }
    return out;
  }

  function gantt(ps) {
    const t0 = Math.min(...ps.map((p) => T(p.start))) - 2 * DAY;
    const t1 = Math.max(...ps.map((p) => T(p.end))) + 3 * DAY;
    const span = t1 - t0;
    const pct = (t) => ((t - t0) / span) * 100;
    const tk = ticks(t0, t1);
    const now = T(todayStr());
    const jump = (id) => { const el = document.getElementById('phase-' + id); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); };

    return h('div', { class: 'gantt' },
      h('div', { class: 'g-axis' }, tk.map((k) => h('span', { style: { left: pct(k.t) + '%' } }, k.label))),
      h('div', { class: 'g-body' },
        h('div', { class: 'g-lines' },
          tk.map((k) => h('i', { style: { left: pct(k.t) + '%' } })),
          now >= t0 && now <= t1 && h('b', { class: 'today', title: 'Hari ini', style: { left: pct(now) + '%' } })),
        ps.map((p) => {
          const st = stats(p);
          return h('div', { class: 'g-row' },
            h('button', { class: 'g-label', title: p.name, onclick: () => jump(p.id) }, p.name, p.locked ? ' 🔒' : ''),
            h('div', { class: 'g-track' },
              h('div', {
                class: 'g-bar ' + p.status + (p.locked ? ' locked' : ''),
                title: `${p.name}: ${fmt(p.start)} → ${fmt(p.end)} · ${st.done}/${st.total} selesai`,
                style: { left: pct(T(p.start)) + '%', width: ((T(p.end) + DAY - T(p.start)) / span) * 100 + '%' },
                onclick: () => jump(p.id),
              }, h('div', { class: 'g-fill', style: { width: st.pct + '%' } }), h('span', {}, st.pct + '%'))));
        })));
  }

  function itemRow(t) {
    return h('li', { class: t.status === 'done' ? 'is-done' : '', onclick: () => editTaskDialog(t), title: STATUS_LABEL[t.status] },
      h('span', { class: 'dot ' + t.status }),
      h('span', { class: 't' }, t.title),
      t.priority === 'high' && badge('Tinggi', 'prio-high'),
      t.assignee && h('span', { class: 'muted small' }, t.assignee),
      h('span', { class: 'muted small' }, STATUS_LABEL[t.status]));
  }

  function itemsList(title, items) {
    return h('div', { class: 'items' },
      h('h4', {}, `${title} (${items.length})`),
      items.length ? h('ul', {}, items.map(itemRow)) : h('p', { class: 'muted small' }, 'Belum ada item.'));
  }

  function addItemInput(p) {
    const input = h('input', { placeholder: 'Tambah item scope lalu Enter…', maxlength: 200, 'aria-label': 'Tambah item scope' });
    if (ui.refocus === p.id) { ui.refocus = null; requestAnimationFrame(() => input.focus()); }
    return h('form', {
      class: 'add-item',
      onsubmit: safe(async (e) => {
        e.preventDefault();
        const title = input.value.trim();
        if (!title) return;
        ui.refocus = p.id;
        await mutate('POST', '/api/tasks', { phaseId: p.id, title });
      }),
    }, input, h('button', { class: 'btn', type: 'submit' }, 'Tambah'));
  }

  function phaseCard(p) {
    const st = stats(p);
    const items = tasksOf(p.id).sort((a, b) => a.order - b.order);
    const base = items.filter((t) => t.origin !== 'change');
    const chg = items.filter((t) => t.origin === 'change');
    return h('article', { class: 'panel phase ' + p.status, id: 'phase-' + p.id },
      h('div', { class: 'phase-head' },
        h('div', {},
          h('h3', {}, p.name, ' ', badge(PHASE_LABEL[p.status], 'st-' + p.status), ' ', p.locked && badge('🔒 Scope terkunci', 'lock')),
          h('div', { class: 'muted' }, `${fmt(p.start)} → ${fmt(p.end)} · ${days(p)} hari`)),
        h('div', { class: 'btns' },
          h('button', { class: 'btn small', onclick: () => phaseDialog(p) }, 'Edit'),
          h('button', { class: 'btn small', onclick: () => toggleLock(p), title: p.locked ? 'Buka kunci scope' : 'Setujui & kunci scope phase ini' }, p.locked ? 'Buka kunci' : '🔒 Kunci scope'))),
      p.goal && h('p', { class: 'goal' }, p.goal),
      h('div', { class: 'progress' }, h('div', { style: { width: st.pct + '%' } })),
      h('div', { class: 'muted small' }, `${st.done}/${st.total} selesai (${st.pct}%)`),
      p.locked && h('p', { class: 'lock-note' }, `Disetujui ${fmt(p.approvedAt.slice(0, 10))} · ${p.baselineCount} item baseline. Item baru harus lewat Change Request.`),
      itemsList('Scope disetujui', base),
      chg.length ? itemsList('Perubahan masuk (CR)', chg) : null,
      p.locked
        ? h('div', { class: 'add-item' }, h('button', { class: 'btn small', onclick: () => crDialog(p.id) }, '+ Ajukan perubahan'))
        : addItemInput(p));
  }

  function crCard(c) {
    const ph = phaseById(c.phaseId);
    const nxt = ph ? nextPhaseOf(ph.id) : null;
    return h('div', { class: 'cr' },
      h('h4', {}, c.title),
      h('div', { class: 'meta' }, `${c.requestedBy ? 'Dari ' + c.requestedBy + ' · ' : ''}saat ${ph ? ph.name : c.phaseName} · ${fmt(c.createdAt.slice(0, 10))}`),
      c.desc && h('p', {}, c.desc),
      c.reason && h('p', { class: 'why muted' }, 'Alasan/dampak: ' + c.reason),
      h('div', { class: 'btns' },
        ph && h('button', { class: 'btn small primary', onclick: () => decideDialog(c, 'current'), title: 'Masuk phase sekarang karena wajib' }, `Wajib: ${ph.name}`),
        h('button', {
          class: 'btn small', disabled: !nxt, onclick: () => decideDialog(c, 'next'),
          title: nxt ? 'Masuk phase berikutnya' : 'Belum ada phase berikutnya — buat dulu di Timeline',
        }, nxt ? `Geser ke ${nxt.name}` : 'Geser (belum ada phase)'),
        h('button', { class: 'btn small danger', onclick: () => decideDialog(c, 'reject') }, 'Tolak'),
        h('button', {
          class: 'btn small ghost', title: 'Tarik / hapus permintaan',
          onclick: safe(async () => { if (confirm('Hapus permintaan ini?')) await mutate('DELETE', `/api/changes/${c.id}`); }),
        }, '×')));
  }

  function crDone(c) {
    let outcome;
    if (c.status === 'rejected') outcome = 'Ditolak';
    else if (c.decision === 'current') outcome = `Masuk ${c.decidedPhaseName} (wajib${c.extendDays ? `, +${c.extendDays} hari` : ''})`;
    else outcome = `Digeser ke ${c.decidedPhaseName}`;
    return h('div', { class: 'cr done' },
      h('h4', {}, c.title),
      h('div', { class: 'meta' }, `${outcome}${c.decidedAt ? ' · ' + fmt(c.decidedAt.slice(0, 10)) : ''}`),
      c.decisionNote && h('p', { class: 'why muted' }, c.decisionNote));
  }

  function changePanel() {
    const pending = S.changes.filter((c) => c.status === 'pending');
    const decided = S.changes.filter((c) => c.status !== 'pending').sort((a, b) => (b.decidedAt || '').localeCompare(a.decidedAt || ''));
    return h('aside', { class: 'panel changes' },
      h('div', { class: 'panel-head' }, h('h2', {}, `Permintaan perubahan${pending.length ? ` (${pending.length})` : ''}`), h('button', { class: 'btn small', onclick: () => crDialog() }, '+ Ajukan')),
      pending.length ? pending.map(crCard) : h('p', { class: 'empty' }, 'Tidak ada yang menunggu keputusan.'),
      decided.length ? h('details', {}, h('summary', {}, `Riwayat keputusan (${decided.length})`), decided.map(crDone)) : null);
  }

  function timelineView() {
    const ps = phases();
    return h('div', { class: 'wrap' },
      h('section', { class: 'panel' },
        h('div', { class: 'panel-head' }, h('h2', {}, 'Timeline phase'), h('button', { class: 'btn primary small', onclick: () => phaseDialog() }, '+ Phase')),
        ps.length ? gantt(ps) : h('p', { class: 'empty' }, 'Belum ada phase. Buat phase pertama dulu.')),
      h('div', { class: 'split' }, h('div', { class: 'phases' }, ps.map(phaseCard)), changePanel()));
  }

  /* ======================= KANBAN ======================= */
  const taskText = (t) => `${t.title} ${t.assignee} ${t.desc}`.toLowerCase();
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
    const over = t.due && t.status !== 'done' && t.due < todayStr();
    const idx = STATUSES.findIndex((s) => s[0] === t.status);
    const mv = (to, label) => h('button', {
      title: 'Pindah ke ' + STATUSES[to][1], 'aria-label': label,
      onclick: (e) => { e.stopPropagation(); moveTask(t.id, STATUSES[to][0]); },
    }, label);
    return h('div', {
      class: 'tcard prio-' + t.priority, draggable: 'true', dataset: { id: t.id, q: taskText(t) },
      onclick: () => editTaskDialog(t),
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
      t.origin === 'change' && badge('CR', 'cr'),
      t.priority === 'high' && badge('Tinggi', 'prio-high'),
      t.due && badge(fmtShort(t.due), over ? 'over' : ''),
      t.assignee && h('span', { class: 'avatar', title: t.assignee }, initials(t.assignee))),
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
      h('div', { class: 'col-head' }, label, h('span', { class: 'count' }, ts.length),
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
    if (!ps.length) return h('div', { class: 'panel' }, h('p', { class: 'empty' }, 'Belum ada phase.'), h('button', { class: 'btn primary', onclick: () => phaseDialog() }, '+ Phase'));
    const ph = ps.find((p) => p.id === ui.phaseId) || currentPhase();
    return h('div', {},
      h('div', { class: 'toolbar' },
        h('select', {
          'aria-label': 'Pilih phase',
          onchange: (e) => { ui.phaseId = e.target.value; store.set('phaseId', ui.phaseId); render(); },
        }, ps.map((p) => h('option', { value: p.id, selected: p.id === ph.id }, p.name + (p.status === 'active' ? ' (berjalan)' : p.status === 'done' ? ' (selesai)' : '')))),
        h('span', { class: 'muted' }, `${fmt(ph.start)} → ${fmt(ph.end)}`),
        ph.locked && badge('🔒 Scope terkunci', 'lock'),
        h('input', {
          type: 'search', placeholder: 'Cari task…', value: ui.q, 'aria-label': 'Cari task',
          oninput: (e) => { ui.q = e.target.value; applyFilter(); },
        }),
        ph.locked
          ? h('button', { class: 'btn', onclick: () => crDialog(ph.id), title: 'Scope terkunci, tambahan harus lewat change request' }, '+ Ajukan perubahan')
          : h('button', { class: 'btn primary', onclick: () => taskDialog(ph) }, '+ Task')),
      h('div', { class: 'board' }, STATUSES.map((s) => column(ph, s))));
  }

  /* ======================= render & init ======================= */
  function render() {
    const y = window.scrollY;
    $('#app').replaceChildren(ui.view === 'kanban' ? kanbanView() : timelineView());
    document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.view === ui.view));
    const pend = S.changes.filter((c) => c.status === 'pending').length;
    const pb = $('#pending-badge');
    pb.textContent = pend;
    pb.hidden = !pend;
    if (ui.view === 'kanban') applyFilter();
    window.scrollTo(0, y);
  }

  function init() {
    $('#tabs').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-view]');
      if (!b) return;
      ui.view = b.dataset.view;
      store.set('view', ui.view);
      render();
    });
    $('#btn-log').addEventListener('click', logDialog);
    $('#btn-export').addEventListener('click', () => { window.location.href = '/api/export'; });
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
    document.addEventListener('dragend', () => { dragging = false; dragId = null; clearDrop(); }, true);

    // sinkronisasi ringan jika ada orang lain yang mengubah data
    setInterval(async () => {
      if (document.hidden || dragging || dlg.open) return;
      const a = document.activeElement;
      if (a && a.closest && a.closest('#app') && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && a.value) return;
      try {
        const r = await api('GET', '/api/rev');
        if (r.rev !== S.rev) { S = await api('GET', '/api/state'); render(); }
      } catch (_) { /* coba lagi di putaran berikutnya */ }
    }, 15000);

    api('GET', '/api/state').then((d) => { S = d; render(); }).catch((e) => {
      $('#app').replaceChildren(h('p', { class: 'empty' }, 'Gagal memuat data: ' + e.message));
    });
  }

  init();
})();
