/* global pdfjsLib */
pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

// ── State ─────────────────────────────────────────────────────────────────
const state = {
  p1: {
    city: null,
    offenders: [],
    dupId: [],
    missing: [],          // currently-displayed dataset
    missingAll: [],       // city-wide
    missingPerFile: {},   // {stem: [rows...]}
    pages: { offenders: 1, dupId: 1, missing: 1 },
    perPage: 10,
  },
  p2Sample: { active: false, items: [], info: null },
  p2All: { active: false, items: [] },
  p2: {
    city: null,
    stem: null,
    pdfFilename: null,
    rows: [],
    validations: {},
    selectedRow: null,
    verdict: null,
    detailColumns: [],
    detailOriginal: [],    // original values for change tracking
    detailEdited: {},      // column -> new value (only changed)
  },
  pdf: {
    doc: null,
    url: null,
    currentPage: 1,
    totalPages: 0,
    rendering: false,
    rotation: 0,
    adjust: 0,          // offset added to source_page when opening a row
    sourcePage: null,   // source_page of the currently selected row
  },
};

// ── API helpers ───────────────────────────────────────────────────────────
const api = {
  get: (url) => fetch(url).then((r) => r.json()),
  post: (url, body) =>
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => r.json()),
};

function showToast(msg, ms = 2500) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => el.classList.add('hidden'), ms);
}

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Tab switching ─────────────────────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    const target = btn.dataset.page;
    document.querySelectorAll('.page').forEach((p) => {
      p.classList.toggle('active', p.id === target);
      p.classList.toggle('hidden', p.id !== target);
    });
    if (target === 'page4') loadInstructions();
    if (target === 'page2') loadCommonNotes();
  });
});

// ── Instructions (Page 4) — rendered from ValidationsTool/README.md ──
async function loadInstructions() {
  const el = document.getElementById('instructions-content');
  try {
    const res = await fetch('/api/instructions', { cache: 'no-store' });
    const md = await res.text();
    if (!res.ok) {
      el.innerHTML = `<p class="empty-state">${escHtml(md)}</p>`;
      return;
    }
    if (typeof marked !== 'undefined') {
      el.innerHTML = marked.parse(md);
    } else {
      el.innerHTML = `<pre>${escHtml(md)}</pre>`;
    }
  } catch (e) {
    el.innerHTML = `<p class="empty-state">Failed to load instructions: ${escHtml(String(e))}</p>`;
  }
}

// ── City loader ───────────────────────────────────────────────────────────
async function loadCities() {
  const cities = await api.get('/api/cities');
  ['p1-city-select', 'p2-city-select', 'p3-city-select'].forEach((id) => {
    const sel = document.getElementById(id);
    sel.innerHTML = '<option value="">— select —</option>';
    cities.forEach((c) => {
      const opt = document.createElement('option');
      opt.value = c; opt.textContent = c;
      sel.appendChild(opt);
    });
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Page 1
// ═══════════════════════════════════════════════════════════════════════════
const p1City = document.getElementById('p1-city-select');
const p1RunBtn = document.getElementById('p1-run-btn');
const p1Spinner = document.getElementById('p1-spinner');
const p1Content = document.getElementById('p1-content');
const p1Empty = document.getElementById('p1-empty');

p1City.addEventListener('change', () => { p1RunBtn.disabled = !p1City.value; });

async function runP1Validation() {
  const city = p1City.value;
  if (!city) return;
  p1RunBtn.disabled = true;
  p1Spinner.classList.remove('hidden');
  p1Content.classList.add('hidden');
  p1Empty.classList.add('hidden');
  try {
    const extra = (document.getElementById('p1-extra-cols').value || '').trim();
    const url = `/api/cities/${encodeURIComponent(city)}/validate`
      + (extra ? `?extra=${encodeURIComponent(extra)}` : '');
    const data = await api.get(url);
    renderPage1(data, city);
    p1Content.classList.remove('hidden');
    // Now that the section is visible, check if file list overflows
    setTimeout(() => {
      const listEl = document.getElementById('p1-csv-list');
      const toggleBtn = document.getElementById('p1-csv-toggle');
      const overflows = listEl.scrollHeight > listEl.clientHeight + 2;
      toggleBtn.classList.toggle('hidden', !overflows);
    }, 50);
  } catch (e) {
    p1Empty.textContent = 'Error running validation. Check the console.';
    p1Empty.classList.remove('hidden');
    console.error(e);
  } finally {
    p1Spinner.classList.add('hidden');
    p1RunBtn.disabled = false;
  }
}

p1RunBtn.addEventListener('click', runP1Validation);
document.getElementById('p1-extra-apply').addEventListener('click', () => {
  if (p1City.value) runP1Validation();
});

function renderPage1(data, city) {
  state.p1.city = city;
  state.p1.offenders = data.pass1.offenders || [];
  state.p1.dupId = (data.duplicates && data.duplicates.by_id) || [];
  state.p1.missingAll = data.missing_by_column || [];
  state.p1.missingPerFile = data.missing_by_column_per_file || {};
  state.p1.missing = state.p1.missingAll;
  state.p1.pages = { offenders: 1, dupId: 1, missing: 1 };
  // Populate scope dropdown
  const scopeSel = document.getElementById('p1-missing-scope');
  const stems = Object.keys(state.p1.missingPerFile).sort();
  scopeSel.innerHTML = '<option value="__all__">All files combined</option>'
    + stems.map((s) => `<option value="${escHtml(s)}">${escHtml(s)}</option>`).join('');
  scopeSel.value = '__all__';
  document.getElementById('p1-missing-scope-info').textContent = '';

  // Section A — Load Summary
  document.getElementById('p1-csv-count').textContent = data.csv_files.length;
  document.getElementById('p1-total-rows').textContent = data.total_rows.toLocaleString();
  document.getElementById('p1-distinct-projects').textContent =
    (data.unique_project_ids ?? 0).toLocaleString();
  const p2d = data.pass2 || {};
  document.getElementById('p1-year-range').textContent =
    p2d.plan_year_range && p2d.plan_year_range[0]
      ? `${p2d.plan_year_range[0]} – ${p2d.plan_year_range[1]}` : '—';

  // Files: strip .csv suffix
  const listEl = document.getElementById('p1-csv-list');
  const toggleBtn = document.getElementById('p1-csv-toggle');
  listEl.innerHTML = data.csv_files
    .map((f) => `<span>${escHtml(f.replace(/\.csv$/i, ''))}</span>`)
    .join('  ·  ');
  listEl.classList.add('collapsed');
  toggleBtn.textContent = 'Show more';
  toggleBtn.classList.add('hidden');
  toggleBtn.onclick = () => {
    listEl.classList.toggle('collapsed');
    toggleBtn.textContent = listEl.classList.contains('collapsed') ? 'Show more' : 'Show less';
  };

  // Section B — Pass 1
  const p1 = data.pass1;
  document.getElementById('p1-rows-with-total').textContent = p1.rows_with_total.toLocaleString();
  document.getElementById('p1-rows-missing-total').textContent = p1.rows_missing_total.toLocaleString();
  document.getElementById('p1-metadata-only').textContent = p1.metadata_only.toLocaleString();
  const b = p1.residual_buckets;
  const residualGt2 = (b['2_100'] || 0) + (b['100_1000'] || 0) + (b['gt1000'] || 0);
  document.getElementById('p1-residual-gt2').textContent = residualGt2.toLocaleString();

  // Flagged rows by CIP year — two-column layout, per-cell highlight
  const years = p1.flagged_by_year;
  const half = Math.ceil(years.length / 2);
  const cellsFor = (r, isRight) => {
    if (!r) {
      const empty = isRight ? '<td class="col-divider"></td>' : '<td></td>';
      return empty + '<td></td><td></td><td></td><td></td>';
    }
    const flagCls = r.flagged > 0 ? ' flagged-cell' : '';
    const firstCls = ((isRight ? 'col-divider' : '') + flagCls).trim();
    const tdFirst = firstCls ? ` class="${firstCls}"` : '';
    const td = flagCls ? ' class="flagged-cell"' : '';
    return `<td${tdFirst}>${r.cip_year}</td>` +
      `<td${td}>${escHtml(r.time_period) || '—'}</td>` +
      `<td${td}>${r.flagged}</td>` +
      `<td${td}>${r.total}</td>` +
      `<td${td}>${r.pct.toFixed(1)}%</td>`;
  };
  const rowsHtml = [];
  for (let i = 0; i < half; i++) {
    rowsHtml.push(`<tr>${cellsFor(years[i], false)}${cellsFor(years[i + half], true)}</tr>`);
  }
  document.querySelector('#p1-year-table tbody').innerHTML = rowsHtml.join('');

  renderPaginatedTable('offenders');

  // Section C — Column Completeness (paginated, two-column layout)
  renderMissingTable();

  // Section D — Duplicates (by ID only)
  const dup = data.duplicates || { by_id_groups: 0, by_id_rows: 0, by_id: [] };
  document.getElementById('p1-dup-id-groups').textContent = dup.by_id_groups.toLocaleString();
  document.getElementById('p1-dup-id-rows').textContent = dup.by_id_rows.toLocaleString();
  renderPaginatedTable('dupId');
}

// Render a validation_label cell; hovering shows the note (if any) via title.
function labelCell(label, note) {
  const lbl = (label || '').trim();
  const n = (note || '').trim();
  if (!lbl && !n) return '<td>—</td>';
  const title = n ? ` title="${escHtml(n)}"` : '';
  const cls = n ? ' class="has-note"' : '';
  return `<td><span${cls}${title}>${escHtml(lbl) || '—'}</span></td>`;
}

function renderPaginatedTable(which) {
  const cfg = {
    offenders: {
      data: state.p1.offenders,
      tbody: '#p1-offenders-table tbody',
      pag: '[data-pag="offenders"]',
      empty: '#p1-no-offenders',
      rowFn: (r) => {
        const res = r.residual != null ? r.residual.toFixed(1) : '—';
        return `<tr class="flagged">
          <td>${r.cip_year ?? '—'}</td>
          <td>${r.source_page ?? '—'}</td>
          <td>${escHtml(r.project_id) || '—'}</td>
          <td><span class="top10-link" data-city="${state.p1.city}" data-year="${r.cip_year}"
                    data-proj="${encodeURIComponent(r.project_id ?? '')}">${escHtml(r.project_name) || '—'}</span></td>
          ${labelCell(r.validation_label, r.notes)}
          <td>${escHtml(r.previous_appropriations) || '—'}</td>
          <td>${escHtml(r.project_total) || '—'}</td>
          <td>${r.year_sum != null ? r.year_sum.toFixed(1) : '—'}</td>
          <td>${res}</td>
        </tr>`;
      },
      wireLinks: (tbody) => {
        tbody.querySelectorAll('.top10-link').forEach((el) => {
          el.addEventListener('click', () =>
            navigateToPage2(el.dataset.city, el.dataset.year, decodeURIComponent(el.dataset.proj)));
        });
      },
    },
    dupId: {
      data: state.p1.dupId,
      tbody: '#p1-dup-id-table tbody',
      pag: '[data-pag="dupId"]',
      empty: '#p1-no-dup-id',
      rowFn: (r) => `<tr class="flagged">
        <td>${escHtml(r.cip_year)}</td>
        <td><span class="top10-link" data-city="${state.p1.city}" data-year="${r.cip_year}"
                  data-proj="${encodeURIComponent(r.project_id)}">${escHtml(r.project_id)}</span></td>
        <td>${escHtml(r.project_name)}</td>
        ${labelCell(r.labels, r.notes)}
        <td>${r.count}</td>
        <td>${escHtml(r.source_pages)}</td>
      </tr>`,
      wireLinks: (tbody) => {
        tbody.querySelectorAll('.top10-link').forEach((el) => {
          el.addEventListener('click', () =>
            navigateToPage2(el.dataset.city, el.dataset.year, decodeURIComponent(el.dataset.proj)));
        });
      },
    },
  };
  const c = cfg[which];
  if (!c) return;
  const total = c.data.length;
  const perPage = state.p1.perPage;
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  let page = state.p1.pages[which];
  if (page > totalPages) page = totalPages;
  state.p1.pages[which] = page;

  const tbodyEl = document.querySelector(c.tbody);
  const emptyEl = document.querySelector(c.empty);
  if (total === 0) {
    tbodyEl.innerHTML = '';
    emptyEl.classList.remove('hidden');
  } else {
    emptyEl.classList.add('hidden');
    const slice = c.data.slice((page - 1) * perPage, page * perPage);
    tbodyEl.innerHTML = slice.map(c.rowFn).join('');
    c.wireLinks(tbodyEl);
  }

  const pagEl = document.querySelector(c.pag);
  pagEl.querySelector('.page-current').textContent = page;
  pagEl.querySelector('.page-total').textContent = totalPages;
  pagEl.querySelector('.page-count').textContent = `(${total.toLocaleString()} total)`;
  pagEl.querySelector(`[data-pg="${which}-prev"]`).disabled = page <= 1;
  pagEl.querySelector(`[data-pg="${which}-next"]`).disabled = page >= totalPages;
}

// Pagination button wiring
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-pg]');
  if (!btn) return;
  const [which, dir] = btn.dataset.pg.split('-');
  if (!state.p1.pages[which]) return;
  state.p1.pages[which] += dir === 'next' ? 1 : -1;
  if (state.p1.pages[which] < 1) state.p1.pages[which] = 1;
  if (which === 'missing') renderMissingTable();
  else renderPaginatedTable(which);
});

// ── Section C: column-completeness two-column renderer ─────────────────────
function renderMissingTable() {
  const data = state.p1.missing;
  const perPage = state.p1.perPage;
  const total = data.length;
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  let page = state.p1.pages.missing || 1;
  if (page > totalPages) page = totalPages;
  state.p1.pages.missing = page;

  const slice = data.slice((page - 1) * perPage, page * perPage);
  const half = Math.ceil(slice.length / 2);

  const cellsFor = (m, isRight) => {
    if (!m) {
      const empty = isRight ? '<td class="col-divider"></td>' : '<td></td>';
      return empty + '<td></td><td></td><td></td>';
    }
    const flag = m.pct >= 50 ? ' flagged-cell' : '';
    const firstCls = ((isRight ? 'col-divider' : '') + flag).trim();
    const tdFirst = firstCls ? ` class="${firstCls}"` : '';
    const td = flag ? ' class="flagged-cell"' : '';
    const pctNum = Number(m.pct) || 0;
    return `<td${tdFirst}>${escHtml(m.column)}</td>` +
      `<td${td}>${m.missing.toLocaleString()}</td>` +
      `<td${td}>${m.total.toLocaleString()}</td>` +
      `<td${td}>${pctNum.toFixed(1)}%</td>`;
  };

  const tbodyEl = document.querySelector('#p1-missing-table tbody');
  const emptyEl = document.getElementById('p1-no-missing');
  if (total === 0) {
    tbodyEl.innerHTML = '';
    emptyEl.classList.remove('hidden');
  } else {
    emptyEl.classList.add('hidden');
    const rows = [];
    for (let i = 0; i < half; i++) {
      rows.push(`<tr>${cellsFor(slice[i], false)}${cellsFor(slice[i + half], true)}</tr>`);
    }
    tbodyEl.innerHTML = rows.join('');
  }

  const pag = document.querySelector('[data-pag="missing"]');
  pag.querySelector('.page-current').textContent = page;
  pag.querySelector('.page-total').textContent = totalPages;
  pag.querySelector('.page-count').textContent = `(${total.toLocaleString()} total)`;
  pag.querySelector('[data-pg="missing-prev"]').disabled = page <= 1;
  pag.querySelector('[data-pg="missing-next"]').disabled = page >= totalPages;
}

// Scope switcher + Prev/Next file buttons
function applyScope() {
  const sel = document.getElementById('p1-missing-scope');
  const scope = sel.value;
  const info = document.getElementById('p1-missing-scope-info');
  if (scope === '__all__') {
    state.p1.missing = state.p1.missingAll;
    info.textContent = '';
  } else {
    state.p1.missing = state.p1.missingPerFile[scope] || [];
    const total = state.p1.missing[0]?.total ?? 0;
    info.textContent = `Showing ${scope} only · ${total.toLocaleString()} rows`;
  }
  state.p1.pages.missing = 1;
  renderMissingTable();
}

document.getElementById('p1-missing-scope').addEventListener('change', applyScope);

function cycleScope(dir) {
  const sel = document.getElementById('p1-missing-scope');
  const opts = [...sel.options];
  if (opts.length <= 1) return;
  const cur = opts.findIndex((o) => o.value === sel.value);
  const next = (cur + dir + opts.length) % opts.length;
  sel.value = opts[next].value;
  applyScope();
}
document.getElementById('p1-scope-prev-btn').addEventListener('click', () => cycleScope(-1));
document.getElementById('p1-scope-next-btn').addEventListener('click', () => cycleScope(1));

async function navigateToPage2(city, cipYear, projectId) {
  document.querySelector('[data-page="page2"]').click();
  const p2CityEl = document.getElementById('p2-city-select');
  p2CityEl.value = city;
  await onP2CityChange(city);
  const files = await api.get(`/api/cities/${encodeURIComponent(city)}/files`);
  const match = files.find((f) => f.stem.startsWith(String(cipYear)));
  if (!match) return;
  const p2FileEl = document.getElementById('p2-file-select');
  p2FileEl.value = match.stem;
  await onP2FileChange(match.stem);
  if (projectId) {
    // Populate the Project ID filter so the user sees every matching row
    const idFilter = document.getElementById('p2-id-filter');
    idFilter.value = projectId;
    renderRowList();
    // If only one row matches, auto-select it (offender case)
    const matches = state.p2.rows.filter(
      (r) => r.project_id.toLowerCase() === projectId.toLowerCase()
    );
    if (matches.length === 1) selectRow(matches[0].index);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Page 2
// ═══════════════════════════════════════════════════════════════════════════
const p2CitySelect = document.getElementById('p2-city-select');
const p2FileSelect = document.getElementById('p2-file-select');
const p2NameFilter = document.getElementById('p2-name-filter');
const p2IdFilter = document.getElementById('p2-id-filter');

p2CitySelect.addEventListener('change', () => onP2CityChange(p2CitySelect.value));
p2FileSelect.addEventListener('change', () => {
  // Picking a file manually exits sample mode
  if (state.p2Sample.active) {
    state.p2Sample = { active: false, items: [], info: null };
    updateSampleUi();
  }
  onP2FileChange(p2FileSelect.value);
});
p2NameFilter.addEventListener('input', renderRowList);
p2IdFilter.addEventListener('input', renderRowList);

// ── Validation Label multi-select filter ──────────────────────────────────
const p2LabelFilter = new Set();
const p2LabelFilterBtn = document.getElementById('p2-label-filter-btn');
const p2LabelFilterMenu = document.getElementById('p2-label-filter-menu');

function updateLabelFilterBtn() {
  p2LabelFilterBtn.textContent = p2LabelFilter.size === 0
    ? 'All'
    : [...p2LabelFilter].join(', ');
}

p2LabelFilterBtn.addEventListener('click', (e) => {
  e.preventDefault();
  if (p2LabelFilterBtn.disabled) return;
  p2LabelFilterMenu.classList.toggle('hidden');
});
p2LabelFilterMenu.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
  cb.addEventListener('change', () => {
    if (cb.checked) p2LabelFilter.add(cb.value);
    else p2LabelFilter.delete(cb.value);
    updateLabelFilterBtn();
    renderRowList();
  });
});
// Close the menu when clicking outside
document.addEventListener('click', (e) => {
  if (!e.target.closest('.label-filter-box')) p2LabelFilterMenu.classList.add('hidden');
});

async function onP2CityChange(city) {
  state.p2.city = city || null;
  state.p2.stem = null;
  state.p2.rows = [];
  state.p2.validations = {};
  state.p2.selectedRow = null;
  // Reset cross-file modes on city change
  state.p2Sample = { active: false, items: [], info: null };
  state.p2All = { active: false, items: [] };
  updateSampleUi();

  p2FileSelect.innerHTML = '<option value="">— select —</option>';
  p2FileSelect.disabled = !city;
  p2NameFilter.disabled = true;
  p2IdFilter.disabled = true;
  // Reset the label filter on city change
  p2LabelFilter.clear();
  p2LabelFilterMenu.querySelectorAll('input[type="checkbox"]').forEach((cb) => { cb.checked = false; });
  p2LabelFilterMenu.classList.add('hidden');
  updateLabelFilterBtn();
  p2LabelFilterBtn.disabled = true;
  document.getElementById('p2-sample-btn').disabled = !city;
  clearRowDetail();
  resetPdf();
  renderRowList();

  if (!city) return;
  const files = await api.get(`/api/cities/${encodeURIComponent(city)}/files`);
  // Default to "All files" so every project shows on city select
  p2FileSelect.innerHTML = '<option value="__all__">All files</option>';
  files.forEach((f) => {
    const opt = document.createElement('option');
    opt.value = f.stem; opt.textContent = f.stem;
    p2FileSelect.appendChild(opt);
  });
  p2FileSelect.disabled = false;
  p2FileSelect.value = '__all__';
  await loadAllFiles();
}

async function loadAllFiles() {
  const city = state.p2.city;
  if (!city) return;
  state.p2Sample = { active: false, items: [], info: null };
  updateSampleUi();
  state.p2.stem = null;
  state.p2.selectedRow = null;
  state.p2.verdict = null;
  clearRowDetail();
  resetPdf();
  const items = await api.get(`/api/cities/${encodeURIComponent(city)}/all_rows`);
  state.p2All = { active: true, items };
  p2NameFilter.disabled = false;
  p2IdFilter.disabled = false;
  p2LabelFilterBtn.disabled = false;
  p2NameFilter.value = '';
  p2IdFilter.value = '';
  renderRowList();
}

async function onP2FileChange(stem) {
  if (stem === '__all__') { await loadAllFiles(); return; }
  if (!stem) return;
  state.p2All = { active: false, items: [] };
  state.p2.stem = stem;
  state.p2.selectedRow = null;
  state.p2.verdict = null;
  clearRowDetail();
  resetPdf();

  const city = state.p2.city;
  const [rows, validations] = await Promise.all([
    api.get(`/api/cities/${encodeURIComponent(city)}/csv/${encodeURIComponent(stem)}/rows`),
    api.get(`/api/validations/${encodeURIComponent(city)}/${encodeURIComponent(stem)}`),
  ]);

  state.p2.rows = rows;
  state.p2.validations = {};
  validations.forEach((v) => {
    state.p2.validations[v.row_index] = { status: v.status, notes: v.notes, edited: (v.edits || []).length > 0 };
  });

  p2NameFilter.disabled = false;
  p2IdFilter.disabled = false;
  p2LabelFilterBtn.disabled = false;
  p2NameFilter.value = '';
  p2IdFilter.value = '';
  renderRowList();

  const files = await api.get(`/api/cities/${encodeURIComponent(city)}/files`);
  const match = files.find((f) => f.stem === stem);
  if (match) state.p2.pdfFilename = match.pdf;
}

// Derive the display label for a row's validation record (mirrors backend compute_label)
function labelFor(v) {
  if (!v) return '';
  if (v.status === 'deleted') return 'deleted';
  if (v.edited) return 'edited';
  if (v.status === 'correct') return 'validated';
  if (v.status === 'incorrect') return 'incorrect';
  return '';
}
const LABEL_GLYPH = { validated: '✓', incorrect: '✗', edited: '✎', deleted: '🗑' };
function badgeHtml(v) {
  const label = labelFor(v);
  if (!label) return '';
  return `<span class="badge ${label}">${LABEL_GLYPH[label]}</span>`;
}

// Shared cross-file list renderer (used by both Sample and All-files modes).
// Uses event delegation so thousands of rows don't each get a listener.
function renderCrossFileList(items, emptyMsg) {
  const listEl = document.getElementById('p2-row-list');
  const nameQ = p2NameFilter.value.toLowerCase();
  const idQ = p2IdFilter.value.toLowerCase();
  const filtered = items.filter((r) => {
    if (nameQ && !(r.project_name || '').toLowerCase().includes(nameQ)) return false;
    if (idQ && !(r.project_id || '').toLowerCase().includes(idQ)) return false;
    if (p2LabelFilter.size) {
      // Live label for the loaded file; otherwise the label stored on the item
      const lbl = state.p2.stem === r.file_stem
        ? labelFor(state.p2.validations[r.row_index])
        : (r.validation_label || '');
      if (!p2LabelFilter.has(lbl)) return false;
    }
    return true;
  });
  if (filtered.length === 0) {
    listEl.innerHTML = `<div class="empty-state">${emptyMsg}</div>`;
    return;
  }
  listEl.innerHTML = filtered.map((r) => {
    const isSel = state.p2.stem === r.file_stem && state.p2.selectedRow === r.row_index;
    const sel = isSel ? ' selected' : '';
    const v = state.p2.stem === r.file_stem ? state.p2.validations[r.row_index] : null;
    const delCls = labelFor(v) === 'deleted' ? ' deleted' : '';
    return `<div class="row-item sample-item${sel}${delCls}"
          data-stem="${escHtml(r.file_stem)}" data-idx="${r.row_index}">
      <span class="file-tag">${escHtml(r.file_stem)}</span>
      ${badgeHtml(v)}
      <span class="row-name" title="${escHtml(r.project_name)}">${escHtml(r.project_name) || '(unnamed)'}</span>
      <span class="row-page">p.${escHtml(r.source_page)}</span>
    </div>`;
  }).join('');
}

function renderRowList() {
  const listEl = document.getElementById('p2-row-list');
  const nameQ = p2NameFilter.value.toLowerCase();
  const idQ = p2IdFilter.value.toLowerCase();

  // Cross-file modes (Sample / All files)
  if (state.p2Sample.active) {
    renderCrossFileList(state.p2Sample.items, 'No sampled rows match the filter.');
    return;
  }
  if (state.p2All.active) {
    renderCrossFileList(state.p2All.items, 'No rows match the filter.');
    return;
  }

  // Normal (single-file) mode
  const filtered = state.p2.rows.filter((r) => {
    if (nameQ && !r.project_name.toLowerCase().includes(nameQ)) return false;
    if (idQ && !r.project_id.toLowerCase().includes(idQ)) return false;
    if (p2LabelFilter.size && !p2LabelFilter.has(labelFor(state.p2.validations[r.index]))) return false;
    return true;
  });

  if (filtered.length === 0) {
    listEl.innerHTML = '<div class="empty-state">No rows match the filter.</div>';
    return;
  }

  listEl.innerHTML = filtered.map((r) => {
    const v = state.p2.validations[r.index];
    const delCls = labelFor(v) === 'deleted' ? ' deleted' : '';
    const sel = state.p2.selectedRow === r.index ? ' selected' : '';
    return `<div class="row-item${sel}${delCls}" data-idx="${r.index}">
      ${badgeHtml(v)}
      <span class="row-name" title="${escHtml(r.project_name)}">${escHtml(r.project_name) || '(unnamed)'}</span>
      <span class="row-page">p.${r.source_page}</span>
    </div>`;
  }).join('');

  listEl.querySelectorAll('.row-item').forEach((el) => {
    el.addEventListener('click', () => selectRow(Number(el.dataset.idx)));
  });
}

// Delegated click handler for cross-file rows (Sample / All files) — set up once.
document.getElementById('p2-row-list').addEventListener('click', (e) => {
  const item = e.target.closest('.row-item.sample-item');
  if (!item) return;
  selectSampleItem(item.dataset.stem, Number(item.dataset.idx));
});

function updateSampleUi() {
  const sampleBtn = document.getElementById('p2-sample-btn');
  const regenBtn = document.getElementById('p2-sample-regen-btn');
  const exitBtn = document.getElementById('p2-sample-exit-btn');
  const info = document.getElementById('p2-sample-info');
  const active = state.p2Sample.active;
  sampleBtn.classList.toggle('hidden', active);
  regenBtn.classList.toggle('hidden', !active);
  exitBtn.classList.toggle('hidden', !active);
  if (active && state.p2Sample.info) {
    const i = state.p2Sample.info;
    info.textContent = `Sample: ${i.sample_size} of ${i.total_rows} (${i.percent}%)`;
    info.classList.remove('hidden');
  } else {
    info.textContent = '';
    info.classList.add('hidden');
  }
}

async function loadSample(force) {
  const city = state.p2.city;
  if (!city) return;
  const pctInput = document.getElementById('p2-sample-pct');
  let percent = parseFloat(pctInput.value);
  if (!isFinite(percent) || percent <= 0) percent = 5;
  if (percent > 100) percent = 100;
  pctInput.value = percent;
  const data = await api.post(
    `/api/cities/${encodeURIComponent(city)}/sample`,
    { force: !!force, percent }
  );
  if (!data.items || data.items.length === 0) {
    showToast('No data to sample');
    return;
  }
  state.p2Sample = {
    active: true,
    items: data.items,
    info: { sample_size: data.sample_size, total_rows: data.total_rows, percent: data.percent },
  };
  // Reset filters so the full sample is visible
  p2NameFilter.value = '';
  p2IdFilter.value = '';
  p2NameFilter.disabled = false;
  p2IdFilter.disabled = false;
  p2LabelFilterBtn.disabled = false;
  updateSampleUi();
  renderRowList();
  showToast(force ? 'Sample regenerated' : `Sample loaded (${data.sample_size} of ${data.total_rows})`);
}

async function selectSampleItem(stem, rowIndex) {
  if (state.p2.stem !== stem) {
    // Load the file under the hood without clobbering sample mode
    const city = state.p2.city;
    state.p2.stem = stem;
    state.p2.selectedRow = null;
    state.p2.verdict = null;
    clearRowDetail();
    resetPdf();
    const [rows, validations] = await Promise.all([
      api.get(`/api/cities/${encodeURIComponent(city)}/csv/${encodeURIComponent(stem)}/rows`),
      api.get(`/api/validations/${encodeURIComponent(city)}/${encodeURIComponent(stem)}`),
    ]);
    state.p2.rows = rows;
    state.p2.validations = {};
    validations.forEach((v) => {
      state.p2.validations[v.row_index] = { status: v.status, notes: v.notes, edited: (v.edits || []).length > 0 };
    });
    // (Dropdown stays on the current mode — "All files" / sample — not the clicked file.)
    // Find matching PDF
    const files = await api.get(`/api/cities/${encodeURIComponent(city)}/files`);
    const match = files.find((f) => f.stem === stem);
    if (match) state.p2.pdfFilename = match.pdf;
  }
  selectRow(rowIndex);
}

document.getElementById('p2-sample-btn').addEventListener('click', () => loadSample(false));
document.getElementById('p2-sample-regen-btn').addEventListener('click', () => loadSample(true));
document.getElementById('p2-sample-exit-btn').addEventListener('click', () => {
  state.p2Sample = { active: false, items: [], info: null };
  updateSampleUi();
  // Return to the dropdown's current selection (defaults to All files)
  onP2FileChange(p2FileSelect.value || '__all__');
});

async function selectRow(idx) {
  state.p2.selectedRow = idx;
  state.p2.verdict = null;
  state.p2.detailEdited = {};
  resetDeleteConfirm();
  renderRowList();

  const { city, stem } = state.p2;
  const data = await api.get(
    `/api/cities/${encodeURIComponent(city)}/csv/${encodeURIComponent(stem)}/row/${idx}`);

  state.p2.detailColumns = data.columns;
  state.p2.detailOriginal = data.values;

  const tbody = document.querySelector('#p2-detail-table tbody');
  tbody.innerHTML = data.columns.map((col, i) => {
    if (col === 'validation_label' || col === 'notes') return '';  // meta columns, not user-editable
    const val = data.values[i] ?? '';
    const isLong = val.length > 60;
    const inputEl = isLong
      ? `<textarea class="editable" data-col="${escHtml(col)}" rows="2">${escHtml(val)}</textarea>`
      : `<input class="editable" data-col="${escHtml(col)}" type="text" value="${escHtml(val)}">`;
    return `<tr><td>${escHtml(col)}</td><td>${inputEl}</td></tr>`;
  }).join('');

  // Track edits
  tbody.querySelectorAll('.editable').forEach((el, i) => {
    el.addEventListener('input', () => {
      const col = el.dataset.col;
      const orig = state.p2.detailOriginal[state.p2.detailColumns.indexOf(col)] ?? '';
      const current = el.value;
      if (current !== orig) {
        state.p2.detailEdited[col] = current;
        el.classList.add('changed');
      } else {
        delete state.p2.detailEdited[col];
        el.classList.remove('changed');
      }
      document.getElementById('p2-save-edits-btn').disabled =
        Object.keys(state.p2.detailEdited).length === 0;
    });
  });

  document.getElementById('p2-row-detail').classList.remove('hidden');
  document.getElementById('p2-row-detail-empty').classList.add('hidden');
  document.getElementById('p2-save-edits-btn').disabled = true;

  // Validation panel
  document.getElementById('p2-validation').classList.remove('hidden');

  const existing = state.p2.validations[idx];
  const correctBtn = document.getElementById('p2-correct-btn');
  const incorrectBtn = document.getElementById('p2-incorrect-btn');
  const notesEl = document.getElementById('p2-notes');

  correctBtn.classList.remove('active');
  incorrectBtn.classList.remove('active');
  notesEl.value = '';

  if (existing) {
    state.p2.verdict = existing.status;
    notesEl.value = existing.notes || '';
    if (existing.status === 'correct') correctBtn.classList.add('active');
    else incorrectBtn.classList.add('active');
  }

  // PDF: jump to source_page (+ page-adjust offset)
  const sourcePage = parseInt(data.source_page, 10);
  state.pdf.sourcePage = isNaN(sourcePage) ? null : sourcePage;
  if (state.p2.pdfFilename) {
    const pdfUrl = `/api/cities/${encodeURIComponent(city)}/pdf/${encodeURIComponent(state.p2.pdfFilename)}`;
    if (!state.pdf.doc || state.pdf.url !== pdfUrl) await loadPdf(pdfUrl);
    if (state.pdf.sourcePage != null) gotoPage(state.pdf.sourcePage + (state.pdf.adjust || 0));
  }
}

// Save edited row values back to CSV
document.getElementById('p2-open-csv-btn').addEventListener('click', async () => {
  const { city, stem } = state.p2;
  if (!city || !stem) { showToast('Select a project first'); return; }
  const res = await api.post(`/api/cities/${encodeURIComponent(city)}/open_source`, { stem, kind: 'csv' });
  if (!res.ok) showToast(res.error || 'Could not open CSV');
});

document.getElementById('p2-save-edits-btn').addEventListener('click', async () => {
  const { city, stem, selectedRow, detailEdited } = state.p2;
  if (selectedRow == null || Object.keys(detailEdited).length === 0) return;
  const result = await api.post(
    `/api/cities/${encodeURIComponent(city)}/csv/${encodeURIComponent(stem)}/row/${selectedRow}`,
    { updates: detailEdited }
  );
  if (result.ok) {
    // Update internal state
    Object.entries(detailEdited).forEach(([col, val]) => {
      const idx = state.p2.detailColumns.indexOf(col);
      if (idx >= 0) state.p2.detailOriginal[idx] = val;
    });
    state.p2.detailEdited = {};
    document.querySelectorAll('#p2-detail-table .editable').forEach((el) => el.classList.remove('changed'));
    document.getElementById('p2-save-edits-btn').disabled = true;

    // Mark this row as edited so its label/badge flips to ✎ (unless already deleted)
    const prev = state.p2.validations[selectedRow] || {};
    state.p2.validations[selectedRow] = { ...prev, edited: true };

    // Refresh row metadata shown in the list if it changed
    const refreshKeys = ['project_name', 'project_id', 'source_page'];
    const row = state.p2.rows.find((r) => r.index === selectedRow);
    if (row) {
      if ('project_name' in detailEdited) row.project_name = detailEdited.project_name;
      if ('project_id' in detailEdited) row.project_id = detailEdited.project_id;
      if ('source_page' in detailEdited) row.source_page = detailEdited.source_page;
    }
    renderRowList();
    showToast(`Saved ${result.changed.length} change${result.changed.length === 1 ? '' : 's'} to CSV`);
  } else {
    showToast('Save failed');
  }
});

// Auto-save validation: triggered when verdict is clicked or notes lose focus
async function saveValidation() {
  const { city, stem, selectedRow, verdict, rows } = state.p2;
  if (selectedRow == null || !verdict) return;
  const row = rows.find((r) => r.index === selectedRow);
  const notes = document.getElementById('p2-notes').value.trim();
  await api.post('/api/validations', {
    city, file_stem: stem, row_index: selectedRow,
    project_name: row ? row.project_name : '',
    project_id: row ? row.project_id : '',
    source_page: row ? parseInt(row.source_page, 10) : null,
    status: verdict, notes,
  });
  const prev = state.p2.validations[selectedRow] || {};
  state.p2.validations[selectedRow] = { ...prev, status: verdict, notes };
  renderRowList();
  showToast(`Saved as "${verdict}"`);
}

document.getElementById('p2-correct-btn').addEventListener('click', () => {
  state.p2.verdict = 'correct';
  document.getElementById('p2-correct-btn').classList.add('active');
  document.getElementById('p2-incorrect-btn').classList.remove('active');
  saveValidation();
});
document.getElementById('p2-incorrect-btn').addEventListener('click', () => {
  state.p2.verdict = 'incorrect';
  document.getElementById('p2-incorrect-btn').classList.add('active');
  document.getElementById('p2-correct-btn').classList.remove('active');
  saveValidation();
});

// Notes: save on blur if a verdict already exists and the notes actually changed
document.getElementById('p2-notes').addEventListener('blur', () => {
  const { selectedRow, verdict, validations } = state.p2;
  if (selectedRow == null || !verdict) return;
  const current = document.getElementById('p2-notes').value.trim();
  const prev = (validations[selectedRow] && validations[selectedRow].notes) || '';
  if (current !== prev) saveValidation();
});

// ── Common notes (quick-pick from common_notes.md) ─────────────────────────
async function loadCommonNotes() {
  let notes = [];
  try {
    const data = await fetch('/api/common_notes', { cache: 'no-store' }).then((r) => r.json());
    notes = data.notes || [];
  } catch (e) { /* leave empty */ }
  ['p2-notes-common', 'p2-delete-common'].forEach((id) => {
    const sel = document.getElementById(id);
    if (!sel) return;
    sel.innerHTML = '<option value="">+ Common note…</option>'
      + notes.map((n) => `<option value="${escHtml(n)}">${escHtml(n)}</option>`).join('');
  });
}

function insertCommonNote(textarea, note) {
  const cur = textarea.value.trim();
  textarea.value = cur ? `${cur}; ${note}` : note;
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

document.getElementById('p2-notes-common').addEventListener('change', (e) => {
  if (!e.target.value) return;
  insertCommonNote(document.getElementById('p2-notes'), e.target.value);
  e.target.value = '';  // reset to placeholder
  if (state.p2.verdict) saveValidation();  // persist if a verdict already exists
});
document.getElementById('p2-delete-common').addEventListener('change', (e) => {
  if (!e.target.value) return;
  insertCommonNote(document.getElementById('p2-delete-note'), e.target.value);
  e.target.value = '';
});

function clearRowDetail() {
  document.getElementById('p2-row-detail').classList.add('hidden');
  document.getElementById('p2-row-detail-empty').classList.remove('hidden');
  document.getElementById('p2-validation').classList.add('hidden');
  document.querySelector('#p2-detail-table tbody').innerHTML = '';
  resetDeleteConfirm();
}

// ── Delete project (soft delete: marks validation_label = 'deleted') ──────────
function resetDeleteConfirm() {
  const box = document.getElementById('p2-delete-confirm');
  const moreSel = document.getElementById('p2-more-select');
  const note = document.getElementById('p2-delete-note');
  const confirmBtn = document.getElementById('p2-delete-confirm-btn');
  if (box) box.classList.add('hidden');
  if (moreSel) moreSel.value = '';
  if (note) note.value = '';
  if (confirmBtn) confirmBtn.disabled = true;
}

document.getElementById('p2-more-select').addEventListener('change', (e) => {
  if (e.target.value === 'delete') {
    document.getElementById('p2-delete-confirm').classList.remove('hidden');
    document.getElementById('p2-delete-note').focus();
  }
  e.target.value = '';  // reset back to the "More ▾" label
});
document.getElementById('p2-delete-cancel').addEventListener('click', resetDeleteConfirm);
document.getElementById('p2-delete-note').addEventListener('input', () => {
  document.getElementById('p2-delete-confirm-btn').disabled =
    document.getElementById('p2-delete-note').value.trim() === '';
});
document.getElementById('p2-delete-confirm-btn').addEventListener('click', async () => {
  const { city, stem, selectedRow } = state.p2;
  if (selectedRow == null) return;
  const note = document.getElementById('p2-delete-note').value.trim();
  if (!note) return;
  const result = await api.post(
    `/api/cities/${encodeURIComponent(city)}/csv/${encodeURIComponent(stem)}/row/${selectedRow}/delete`,
    { note }
  );
  if (result && result.ok) {
    const prev = state.p2.validations[selectedRow] || {};
    state.p2.validations[selectedRow] = { ...prev, status: 'deleted', notes: note };
    resetDeleteConfirm();
    renderRowList();
    showToast('Project marked deleted');
  } else {
    showToast((result && result.error) || 'Delete failed');
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// PDF viewer
// ═══════════════════════════════════════════════════════════════════════════
const pdfCanvas = document.getElementById('pdf-canvas');
const pdfPlaceholder = document.getElementById('pdf-placeholder');
const pdfPageInput = document.getElementById('pdf-page-input');
const pdfTotalPages = document.getElementById('pdf-total-pages');
const pdfPrev = document.getElementById('pdf-prev');
const pdfNext = document.getElementById('pdf-next');
const pdfRotate = document.getElementById('pdf-rotate');
const pdfAdjust = document.getElementById('pdf-adjust');
const pdfOpenBtn = document.getElementById('pdf-open-btn');

async function loadPdf(url) {
  state.pdf.url = url;
  state.pdf.doc = null;
  state.pdf.currentPage = 1;
  state.pdf.totalPages = 0;
  state.pdf.rotation = 0;
  pdfCanvas.style.display = 'none';
  pdfPlaceholder.classList.remove('hidden');
  pdfPlaceholder.textContent = 'Loading PDF…';
  setPdfNavEnabled(false);
  try {
    const doc = await pdfjsLib.getDocument({ url, withCredentials: false }).promise;
    state.pdf.doc = doc;
    state.pdf.totalPages = doc.numPages;
    pdfTotalPages.textContent = doc.numPages;
    setPdfNavEnabled(true);
    pdfPlaceholder.classList.add('hidden');
    pdfCanvas.style.display = 'block';
  } catch (e) {
    pdfPlaceholder.textContent = 'Failed to load PDF.';
    console.error(e);
  }
}

async function renderPage(num) {
  if (!state.pdf.doc || state.pdf.rendering) return;
  const n = Math.max(1, Math.min(num, state.pdf.totalPages));
  state.pdf.currentPage = n;
  pdfPageInput.value = n;
  pdfPrev.disabled = n <= 1;
  pdfNext.disabled = n >= state.pdf.totalPages;
  state.pdf.rendering = true;
  try {
    const page = await state.pdf.doc.getPage(n);
    const container = document.querySelector('.pdf-container');
    const containerWidth = container.clientWidth - 36;
    const rot = state.pdf.rotation || 0;
    const unscaled = page.getViewport({ scale: 1, rotation: rot });
    const scale = Math.min(containerWidth / unscaled.width, 2.5);
    const vp = page.getViewport({ scale, rotation: rot });
    pdfCanvas.width = vp.width;
    pdfCanvas.height = vp.height;
    await page.render({ canvasContext: pdfCanvas.getContext('2d'), viewport: vp }).promise;
  } finally { state.pdf.rendering = false; }
}

function gotoPage(n) { renderPage(n); }

function setPdfNavEnabled(enabled) {
  pdfPageInput.disabled = !enabled;
  pdfPrev.disabled = !enabled || state.pdf.currentPage <= 1;
  pdfNext.disabled = !enabled || state.pdf.currentPage >= state.pdf.totalPages;
  pdfRotate.disabled = !enabled;
  pdfOpenBtn.disabled = !enabled;
}

function resetPdf() {
  state.pdf.doc = null;
  state.pdf.url = null;
  state.pdf.currentPage = 1;
  state.pdf.totalPages = 0;
  state.pdf.rotation = 0;
  pdfCanvas.style.display = 'none';
  pdfPlaceholder.classList.remove('hidden');
  pdfPlaceholder.textContent = 'PDF will appear here.';
  pdfTotalPages.textContent = '—';
  pdfPageInput.value = 1;
  setPdfNavEnabled(false);
}

pdfPrev.addEventListener('click', () => renderPage(state.pdf.currentPage - 1));
pdfNext.addEventListener('click', () => renderPage(state.pdf.currentPage + 1));
pdfRotate.addEventListener('click', () => {
  if (!state.pdf.doc) return;
  state.pdf.rotation = ((state.pdf.rotation || 0) + 90) % 360;
  renderPage(state.pdf.currentPage);
});
// Page adjust: offset applied to a row's source_page when opening it
pdfAdjust.addEventListener('change', () => {
  const v = parseInt(pdfAdjust.value, 10);
  state.pdf.adjust = isNaN(v) ? 0 : v;
  pdfAdjust.value = state.pdf.adjust;
  if (state.pdf.doc && state.pdf.sourcePage != null) {
    renderPage(state.pdf.sourcePage + state.pdf.adjust);
  }
});
// Open the current PDF in the OS default app
pdfOpenBtn.addEventListener('click', async () => {
  const { city, stem } = state.p2;
  if (!city || !stem) { showToast('Select a project first'); return; }
  const res = await api.post(`/api/cities/${encodeURIComponent(city)}/open_source`, { stem, kind: 'pdf' });
  if (!res.ok) showToast(res.error || 'Could not open PDF');
});
pdfPageInput.addEventListener('change', () => {
  const n = parseInt(pdfPageInput.value, 10);
  if (!isNaN(n)) renderPage(n);
});
pdfPageInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const n = parseInt(pdfPageInput.value, 10);
    if (!isNaN(n)) renderPage(n);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Resizable panels
// ═══════════════════════════════════════════════════════════════════════════
function setupResizers() {
  // Vertical resizer between left panel and PDF (main-horizontal)
  const vRes = document.querySelector('[data-resize="main-horizontal"]');
  const leftPanel = document.getElementById('p2-left-panel');
  if (vRes && leftPanel) {
    vRes.addEventListener('mousedown', (e) => {
      e.preventDefault();
      vRes.classList.add('dragging');
      const startX = e.clientX;
      const startWidth = leftPanel.getBoundingClientRect().width;
      const onMove = (ev) => {
        const w = Math.max(220, Math.min(window.innerWidth - 200, startWidth + (ev.clientX - startX)));
        leftPanel.style.width = w + 'px';
      };
      const onUp = () => {
        vRes.classList.remove('dragging');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        // Re-render PDF to fit new width
        if (state.pdf.doc) renderPage(state.pdf.currentPage);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  // Horizontal resizer between row list and row detail
  const hRes = document.querySelector('[data-resize="left-vertical-1"]');
  const rowListSection = document.getElementById('p2-row-list-section');
  if (hRes && rowListSection) {
    hRes.addEventListener('mousedown', (e) => {
      e.preventDefault();
      hRes.classList.add('dragging');
      const startY = e.clientY;
      const startHeight = rowListSection.getBoundingClientRect().height;
      const onMove = (ev) => {
        const h = Math.max(100, Math.min(700, startHeight + (ev.clientY - startY)));
        rowListSection.style.flex = `0 0 ${h}px`;
      };
      const onUp = () => {
        hRes.classList.remove('dragging');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Page 3 — Combine
// ═══════════════════════════════════════════════════════════════════════════
const p3City = document.getElementById('p3-city-select');
const p3RunBtn = document.getElementById('p3-run-btn');
const p3Spinner = document.getElementById('p3-spinner');
const p3Result = document.getElementById('p3-result');
const p3ReportCard = document.getElementById('p3-report-card');
let p3OutputPath = null;
let p3ReportPath = null;

p3City.addEventListener('change', () => { p3RunBtn.disabled = !p3City.value; });

p3RunBtn.addEventListener('click', async () => {
  const city = p3City.value;
  if (!city) return;
  p3RunBtn.disabled = true;
  p3Spinner.classList.remove('hidden');
  p3Result.classList.add('hidden');
  p3ReportCard.classList.add('hidden');
  try {
    const data = await api.post(
      `/api/cities/${encodeURIComponent(city)}/combine`, {}
    );
    if (data.error) {
      showToast(data.error);
      return;
    }
    p3OutputPath = data.output_path;
    p3ReportPath = data.report_path;

    document.getElementById('p3-output-name').textContent = data.output_file;
    document.getElementById('p3-open-md').classList.toggle('hidden', !data.report_path);

    // Render the just-produced markdown report inline
    if (data.report_markdown && typeof marked !== 'undefined') {
      document.getElementById('p3-report').innerHTML = marked.parse(data.report_markdown);
      p3ReportCard.classList.remove('hidden');
    } else if (data.report_markdown) {
      document.getElementById('p3-report').innerHTML = `<pre>${escHtml(data.report_markdown)}</pre>`;
      p3ReportCard.classList.remove('hidden');
    }

    p3Result.classList.remove('hidden');
    showToast(`Saved ${data.output_file}`);
  } catch (e) {
    showToast('Combine failed — see console');
    console.error(e);
  } finally {
    p3Spinner.classList.add('hidden');
    p3RunBtn.disabled = false;
  }
});

async function openFile(path) {
  if (!path) return;
  const res = await api.post('/api/open', { path });
  if (!res.ok) showToast(res.error || 'Could not open file');
}
document.getElementById('p3-open-csv').addEventListener('click', () => openFile(p3OutputPath));
document.getElementById('p3-open-md').addEventListener('click', () => openFile(p3ReportPath));

// ── Boot ──────────────────────────────────────────────────────────────────
loadCities();
setupResizers();
loadCommonNotes();
