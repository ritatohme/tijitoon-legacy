// ── STATE ──────────────────────────────────────────────
let allEntries = [];
let activeFilter = 'all';
let searchQ = '';
let viewMode = localStorage.getItem(VIEW_KEY) || 'cards';

// ── CONTINUE WATCHING ──────────────────────────────────
// Reads per-series keys: tijitoon:progress:<id> → { season, ep }
function buildContinueWatching(data) {
  const entries = [];
  for (const key of progressKeys()) {
    const seriesId = key.slice(PROGRESS_PREFIX.length);
    const show = data[seriesId];
    if (!show || show.disabled) continue;
    try {
      const { season, ep } = JSON.parse(localStorage.getItem(key));
      const s = show.seasons[season];
      const epObj = s?.episodes[ep];
      if (!s || !epObj) continue;
      entries.push({ seriesId, show, season, ep, s, epObj });
    } catch (_) {}
  }

  const wrap = document.getElementById('continue-watching');
  const strip = document.getElementById('cw-strip');
  strip.innerHTML = '';

  if (!entries.length) { wrap.style.display = 'none'; return; }
  wrap.style.display = 'block';

  const expandBtn = document.getElementById('cw-expand');
  let expanded = false;
  let firstRowLimit = null;

  function computeLimit() {
    const cards = Array.from(strip.querySelectorAll('.cw-card'));
    if (!cards.length) return 0;
    const tops = cards.map(c => c.getBoundingClientRect().top);
    const firstTop = tops[0];
    const count = tops.filter(t => Math.abs(t - firstTop) < 4).length;
    return count || cards.length;
  }

  function updateExpand() {
    const isMobile = window.matchMedia('(max-width: 600px)').matches;
    const cards = Array.from(strip.querySelectorAll('.cw-card'));
    if (!isMobile) {
      cards.forEach(c => c.classList.remove('cw-hidden'));
      expandBtn.style.display = 'none';
      return;
    }
    if (firstRowLimit === null) firstRowLimit = computeLimit();
    if (cards.length <= firstRowLimit) {
      cards.forEach(c => c.classList.remove('cw-hidden'));
      expandBtn.style.display = 'none';
      return;
    }
    cards.forEach((c, i) => c.classList.toggle('cw-hidden', !expanded && i >= firstRowLimit));
    expandBtn.style.display = '';
    expandBtn.innerHTML = expanded
      ? '<i class="fa-solid fa-caret-up"></i> réduire'
      : `<i class="fa-solid fa-caret-down"></i> ${cards.length - firstRowLimit} de plus`;
  }

  expandBtn.onclick = () => { expanded = !expanded; updateExpand(); };

  entries.forEach(({ seriesId, show, season, ep, s, epObj }) => {
    const label = epLabel(s, season, epObj.num);

    const card = document.createElement('div');
    card.className = 'cw-card';

    const removeBtn = document.createElement('button');
    removeBtn.innerHTML = '<i class="fa-solid fa-xmark"></i>';
    removeBtn.className = 'cw-remove-btn';
    removeBtn.addEventListener('click', () => {
      localStorage.removeItem(progressKey(seriesId));
      card.remove();
      if (!strip.querySelectorAll('.cw-card').length) wrap.style.display = 'none';
      else { firstRowLimit = null; requestAnimationFrame(updateExpand); }
    });

    const inner = document.createElement('a');
    inner.className = 'cw-card-link';
    inner.href = `show?series=${encodeURIComponent(seriesId)}&season=${season + 1}&ep=${ep + 1}`;
    inner.innerHTML = `
      <div class="cw-card-title">${esc(show.title)}</div>
      <div class="cw-meta">
        <span class="ep-badge">${esc(label)}</span>
        <span class="ch-mini ${esc(show.channel)}">${chLabel(show.channel)}</span>
      </div>`;

    card.appendChild(removeBtn);
    card.appendChild(inner);
    strip.appendChild(card);
  });

  requestAnimationFrame(updateExpand);
}

document.getElementById('cw-clear').addEventListener('click', () => {
  if (!confirm('Effacer tout l\'historique de visionnage ?')) return;
  progressKeys().forEach(k => localStorage.removeItem(k));
  document.getElementById('continue-watching').style.display = 'none';
  document.getElementById('cw-strip').innerHTML = '';
});

// ── BUILD ITEMS ────────────────────────────────────────
function buildCard(id, show) {
  const disabled = !!show.disabled;
  const el = document.createElement(disabled ? 'div' : 'a');
  el.className = 'card' + (disabled ? ' disabled' : '');
  if (!disabled) el.href = `show?series=${encodeURIComponent(id)}`;
  el.dataset.channel = show.channel;
  el.dataset.tag = show.tag || '';
  el.dataset.search = normalize(`${show.title} ${show.alt_title || ''}`);
  el.innerHTML = `
    <div class="card-title">${esc(show.title)}</div>
    <div class="card-bottom">
      ${show.tag ? `<span class="card-tag ${tagCls(show.tag)}">${esc(show.tag)}</span>` : ''}
      <span class="card-ch ${esc(show.channel)}">${chLabel(show.channel)}</span>
    </div>`;
  return el;
}

function buildRow(id, show, idx) {
  const disabled = !!show.disabled;
  const el = document.createElement(disabled ? 'div' : 'a');
  el.className = 'trow' + (disabled ? ' disabled' : '');
  if (!disabled) el.href = `show?series=${encodeURIComponent(id)}`;
  el.dataset.channel = show.channel;
  el.dataset.tag = show.tag || '';
  el.dataset.search = normalize(`${show.title} ${show.alt_title || ''}`);
  el.innerHTML = `
    <span class="trow-num">${String(idx + 1).padStart(2,'0')}</span>
    <span class="trow-title">${esc(show.title)}</span>
    <span class="trow-tag ${tagCls(show.tag || '')}">${esc(show.tag || '-')}</span>
    <span class="trow-ch ${esc(show.channel)}">${chLabel(show.channel)}</span>`;
  return el;
}

// ── RENDER ─────────────────────────────────────────────
function renderAll(data) {
  const cardGrid = document.getElementById('card-grid');
  const listRows = document.getElementById('list-rows');
  cardGrid.innerHTML = '';
  listRows.innerHTML = '';

  allEntries = Object.entries(data)
    .sort((a,b) => normalize(a[1].title).localeCompare(normalize(b[1].title)));

  allEntries.forEach(([id, show], i) => {
    cardGrid.appendChild(buildCard(id, show));
    listRows.appendChild(buildRow(id, show, i));
  });

  document.getElementById('meta-count').textContent = `> ${allEntries.length} séries`;
  const channelCount = new Set(allEntries.map(([, show]) => show.channel)).size;
  document.getElementById('meta-channels').textContent = `> ${channelCount} chaînes`;
  applyFilter();
  applyView();
}

// ── FILTER ─────────────────────────────────────────────
function matchesFilter(el) {
  const matchesChip = activeFilter === 'all' || el.dataset.channel === activeFilter || el.dataset.tag === activeFilter;
  return matchesChip && (!searchQ || el.dataset.search.includes(searchQ));
}

function applyFilter() {
  let visible = 0;

  document.querySelectorAll('#card-grid .card').forEach(el => {
    const show = matchesFilter(el);
    el.classList.toggle('hidden', !show);
    if (show) visible++;
  });

  document.querySelectorAll('.trow').forEach(el => {
    el.classList.toggle('hidden', !matchesFilter(el));
  });

  document.getElementById('fb-count').textContent = `${visible}`;
  document.getElementById('no-results').classList.toggle('visible', visible === 0);
}

// ── VIEW MODE ──────────────────────────────────────────
function applyView() {
  const isCards = viewMode === 'cards';
  document.getElementById('card-grid').classList.toggle('list-mode', !isCards);
  document.getElementById('list-view').classList.toggle('active', !isCards);
  document.getElementById('btn-cards').classList.toggle('active', isCards);
  document.getElementById('btn-list').classList.toggle('active', !isCards);
}

function setView(mode) {
  viewMode = mode;
  localStorage.setItem(VIEW_KEY, mode);
  applyView();
}
document.getElementById('btn-cards').addEventListener('click', () => setView('cards'));
document.getElementById('btn-list').addEventListener('click', () => setView('list'));

// ── FILTER BUTTON TOGGLE ──────────────────────────────
const filterBtn = document.getElementById('filter-btn');
const filterDropdown = document.getElementById('filter-dropdown');
const filterBackdrop = document.getElementById('filter-backdrop');

function closeFilter() {
  filterDropdown.classList.remove('open');
  filterBtn.classList.remove('open');
  filterBackdrop.classList.remove('active');
}

filterBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const isOpen = filterDropdown.classList.toggle('open');
  filterBtn.classList.toggle('open', isOpen);
  filterBackdrop.classList.toggle('active', isOpen);
});

filterBackdrop.addEventListener('click', closeFilter);
document.addEventListener('click', closeFilter);

filterDropdown.addEventListener('click', e => e.stopPropagation());

const filterClear = document.getElementById('filter-clear');

function setFilter(f, label) {
  activeFilter = f;
  document.querySelectorAll('.fb-chip').forEach(c =>
    c.classList.toggle('active', c.dataset.f === activeFilter)
  );
  filterBtn.classList.toggle('has-filter', activeFilter !== 'all');
  filterBtn.innerHTML = `${label} <span class="filter-btn-arrow"><i class="fa-solid fa-caret-down"></i></span>`;
  filterClear.style.display = activeFilter !== 'all' ? 'inline-block' : 'none';
  closeFilter();
  applyFilter();
}

filterClear.addEventListener('click', (e) => {
  e.stopPropagation();
  setFilter('all', 'FILTRES');
});

// ── FILTER CHIPS ───────────────────────────────────────
document.querySelectorAll('.fb-chip').forEach(chip => {
  chip.addEventListener('click', () => setFilter(chip.dataset.f, chip.textContent.trim()));
});

// ── SEARCH ─────────────────────────────────────────────
const searchInput = document.getElementById('search-input');
const searchClear = document.getElementById('search-clear');

searchInput.addEventListener('input', () => {
  searchQ = normalize(searchInput.value.trim());
  searchClear.classList.toggle('visible', !!searchQ);
  applyFilter();
});
searchClear.addEventListener('click', () => {
  searchInput.value = ''; searchQ = '';
  searchClear.classList.remove('visible');
  applyFilter();
  searchInput.focus();
});

// ── BACK TO TOP ────────────────────────────────────────
const backTop = document.getElementById('back-top');
backTop.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
window.addEventListener('scroll', () =>
  backTop.classList.toggle('visible', window.scrollY > 500)
, { passive: true });

window.addEventListener('pageshow', e => {
  if (e.persisted) { searchInput.value = ''; searchQ = ''; searchClear.classList.remove('visible'); applyFilter(); }
});

// ── FETCH ──────────────────────────────────────────────
// Network/HTTP failures show the error message; bugs in the render path are not
// swallowed here — they surface in the console as uncaught errors.
fetchJson('data.json')
  .catch(err => {
    console.error(err);
    document.getElementById('card-grid').innerHTML =
      '<div class="grid-msg">Erreur de chargement.</div>';
  })
  .then(data => {
    if (!data) return;
    renderAll(data);
    buildContinueWatching(data);
  });
