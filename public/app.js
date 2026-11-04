import { analyzeGarment, toFractions, fromFractions } from './detect.js';
import { PRESETS, DEFAULT_PRESET, garmentKind, defaultDepictedSize, sizeTable, computeLayout } from './layout.js';

const $ = (id) => document.getElementById(id);
const fmt = (n) => (Math.round(n * 100) / 100).toString();
const signed = (n) => (n > 0 ? '+' : n < 0 ? '−' : '') + fmt(Math.abs(n));
const snap = (n) => Math.round(n * 16) / 16;

const state = {
  config: null,
  styles: [],
  overrides: { styles: {} },
  style: null,
  colorName: null,
  view: 'front',
  preset: 'full-front',
  presetChosen: false,
  sizeTyped: false,
  widthIn: PRESETS['full-front'].defaultWidthIn,
  heightIn: null,
  lastEdited: 'w',
  size: null,
  nudge: { dxIn: 0, dyIn: 0 },
  logo: null,
  guides: true,
  layout: null,
};

// ---------- helpers ----------

async function api(path, opts = {}) {
  let res;
  try {
    res = await fetch(path, { credentials: 'same-origin', ...opts });
  } catch {
    throw new Error('Couldn’t reach the server. If you’ve been away a while, reload the page to sign in again.');
  }
  if (!res.ok) {
    let msg = `The server returned an error (${res.status}).`;
    try {
      const j = await res.json();
      if (j.error) msg = j.error;
    } catch { /* not JSON */ }
    throw new Error(msg);
  }
  return res;
}

const imgCache = new Map();
function loadImage(src) {
  if (!imgCache.has(src)) {
    imgCache.set(src, new Promise((resolve, reject) => {
      const im = new Image();
      im.decoding = 'async';
      im.onload = () => resolve(im);
      im.onerror = () => { imgCache.delete(src); reject(new Error('Couldn’t load this garment image.')); };
      im.src = src;
    }));
  }
  return imgCache.get(src);
}

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

function luminance(hex) {
  if (!hex || !/^#[0-9a-f]{6}$/i.test(hex)) return 128;
  const n = parseInt(hex.slice(1), 16);
  return 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
}

function showError(msg) {
  const el = $('error');
  el.textContent = msg;
  el.hidden = !msg;
}

// ---------- garment geometry ----------

const geoCache = new Map();
function getGeometry(style, view) {
  const key = `${style.id}:${view}`;
  if (!geoCache.has(key)) {
    geoCache.set(key, (async () => {
      const candidates = style.colors.filter((c) => c[view]);
      if (!candidates.length) return { ok: false, reason: 'There’s no image for this view.' };
      // Measure on the darkest color: it separates cleanly from a white background,
      // and every color of a style is photographed the same way.
      const darkest = [...candidates].sort((a, b) => luminance(a.hex) - luminance(b.hex))[0];
      const im = await loadImage(darkest[view]);
      const scale = Math.min(1, 700 / Math.max(im.naturalWidth, im.naturalHeight));
      const c = makeCanvas(im.naturalWidth * scale, im.naturalHeight * scale);
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(im, 0, 0, c.width, c.height);
      return toFractions(analyzeGarment(ctx.getImageData(0, 0, c.width, c.height)));
    })());
  }
  return geoCache.get(key);
}

const pixelCache = new WeakMap();
function shirtPixels(img) {
  if (!pixelCache.has(img)) {
    const c = makeCanvas(img.naturalWidth, img.naturalHeight);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    pixelCache.set(img, ctx.getImageData(0, 0, c.width, c.height));
  }
  return pixelCache.get(img);
}

// Draws the print and lets the shirt's folds and shadows show through it.
function drawPrint(ctx, img, art, rect, shade) {
  const x = Math.round(rect.x), y = Math.round(rect.y);
  const w = Math.max(1, Math.round(rect.w)), h = Math.max(1, Math.round(rect.h));
  const tmp = makeCanvas(w, h);
  const tc = tmp.getContext('2d', { willReadFrequently: true });
  tc.imageSmoothingQuality = 'high';
  tc.drawImage(art, 0, 0, w, h);
  if (shade) {
    const sp = shirtPixels(img);
    const S = sp.data, SW = sp.width, SH = sp.height;
    const ld = tc.getImageData(0, 0, w, h);
    const L = ld.data;
    const lumAt = (sx, sy) => { const p = (sy * SW + sx) * 4; return 0.299 * S[p] + 0.587 * S[p + 1] + 0.114 * S[p + 2]; };
    let sum = 0, n = 0;
    for (let j = 0; j < h; j += 2) {
      const sy = y + j; if (sy < 0 || sy >= SH) continue;
      for (let i = 0; i < w; i += 2) {
        const sx = x + i; if (sx < 0 || sx >= SW || L[(j * w + i) * 4 + 3] < 16) continue;
        sum += lumAt(sx, sy); n++;
      }
    }
    if (n) {
      const base = Math.max(12, sum / n);
      for (let j = 0; j < h; j++) {
        const sy = y + j; if (sy < 0 || sy >= SH) continue;
        for (let i = 0; i < w; i++) {
          const sx = x + i; const q = (j * w + i) * 4;
          if (sx < 0 || sx >= SW || L[q + 3] === 0) continue;
          const f = Math.min(1.12, Math.max(0.72, 1 + (lumAt(sx, sy) / base - 1) * 0.6));
          L[q] *= f; L[q + 1] *= f; L[q + 2] *= f;
        }
      }
      tc.putImageData(ld, 0, 0);
    }
  }
  ctx.drawImage(tmp, x, y);
}

// ---------- artwork ----------

function cornersOpaqueWhite(c) {
  const ctx = c.getContext('2d', { willReadFrequently: true });
  const pts = [[0, 0], [c.width - 1, 0], [0, c.height - 1], [c.width - 1, c.height - 1]];
  return pts.every(([x, y]) => {
    const [r, g, b, a] = ctx.getImageData(x, y, 1, 1).data;
    return a > 240 && Math.min(r, g, b) > 230;
  });
}

// Clears white connected to the edges, so white inside the logo is kept.
function removeWhite(src, mode = 'outer', tol = 28) {
  const c = makeCanvas(src.width, src.height);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(src, 0, 0);
  const id = ctx.getImageData(0, 0, c.width, c.height);
  const d = id.data, w = c.width, h = c.height;
  const seen = new Uint8Array(w * h);
  const white = (i) => d[i * 4 + 3] > 0 && Math.min(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]) >= 255 - tol;
  const stack = [];
  if (mode === 'all') {
    for (let i = 0; i < w * h; i++) stack.push(i);
  } else {
    for (let x = 0; x < w; x++) stack.push(x, (h - 1) * w + x);
    for (let y = 0; y < h; y++) stack.push(y * w, y * w + w - 1);
  }
  while (stack.length) {
    const i = stack.pop();
    if (seen[i] || !white(i)) continue;
    seen[i] = 1;
    d[i * 4 + 3] = 0;
    const x = i % w;
    if (x > 0) stack.push(i - 1);
    if (x < w - 1) stack.push(i + 1);
    if (i >= w) stack.push(i - w);
    if (i < w * (h - 1)) stack.push(i + w);
  }
  // Soften the light fringe left around the edges.
  for (let i = 0; i < w * h; i++) {
    if (seen[i] || d[i * 4 + 3] === 0) continue;
    const x = i % w;
    const touches = (x > 0 && seen[i - 1]) || (x < w - 1 && seen[i + 1]) || (i >= w && seen[i - w]) || (i < w * (h - 1) && seen[i + w]);
    if (!touches) continue;
    const m = Math.min(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]);
    if (m > 255 - tol * 3) d[i * 4 + 3] = Math.round(d[i * 4 + 3] * Math.max(0, (255 - m) / (tol * 3)));
  }
  ctx.putImageData(id, 0, 0);
  return c;
}

function trim(src) {
  const ctx = src.getContext('2d', { willReadFrequently: true });
  const { data: d, width: w, height: h } = ctx.getImageData(0, 0, src.width, src.height);
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (d[(y * w + x) * 4 + 3] > 8) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) throw new Error('The artwork is empty. If it’s white art on a white background, choose “Keep white.”');
  const c = makeCanvas(maxX - minX + 1, maxY - minY + 1);
  c.getContext('2d').drawImage(src, minX, minY, c.width, c.height, 0, 0, c.width, c.height);
  return { canvas: c, scaleFromSource: 1 };
}

async function svgToCanvas(file) {
  const text = await file.text();
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  const svg = doc.documentElement;
  if (svg.nodeName.toLowerCase() !== 'svg') throw new Error('This SVG file couldn’t be read.');
  const vb = (svg.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number);
  let w = parseFloat(svg.getAttribute('width')) || vb[2] || 1000;
  let h = parseFloat(svg.getAttribute('height')) || vb[3] || 1000;
  const s = 3000 / Math.max(w, h);
  w *= s; h *= s;
  svg.setAttribute('width', String(w));
  svg.setAttribute('height', String(h));
  const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(doc)], { type: 'image/svg+xml' }));
  try {
    const im = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('This SVG file couldn’t be drawn.'));
      i.src = url;
    });
    const c = makeCanvas(w, h);
    c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
    return c;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function bitmapToCanvas(bmp, maxSide = 6000) {
  const s = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const c = makeCanvas(bmp.width * s, bmp.height * s);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  return { canvas: c, scale: s };
}

async function loadArtwork(file) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  const maxMb = state.config?.maxUploadMb || 25;
  if (file.size > maxMb * 1024 * 1024) throw new Error(`That file is over ${maxMb} MB.`);
  let raw, vector = false, sourceScale = 1;
  if (ext === 'svg') {
    raw = await svgToCanvas(file);
    vector = true;
  } else if (['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext)) {
    const r = await bitmapToCanvas(await createImageBitmap(file));
    raw = r.canvas; sourceScale = r.scale;
  } else if (['ai', 'pdf', 'eps'].includes(ext)) {
    $('dropText').textContent = 'Converting…';
    const res = await api('/api/convert', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
    raw = (await bitmapToCanvas(await createImageBitmap(await res.blob()))).canvas;
    vector = true;
  } else {
    throw new Error('Use a PNG, JPG, SVG, AI, PDF or EPS file.');
  }
  const whiteBg = cornersOpaqueWhite(raw);
  state.logo = { name: file.name, raw, vector, sourceScale, whiteBg, canvas: null };
  processArtwork();
}

function processArtwork() {
  const L = state.logo;
  if (!L) return;
  const mode = $('removeBg').value;
  L.canvas = trim(L.whiteBg && mode !== 'keep' ? removeWhite(L.raw, mode) : L.raw).canvas;
  $('bgWrap').hidden = !L.whiteBg;
  $('dropText').textContent = L.name;
  const info = $('artInfo');
  info.hidden = false;
  info.textContent = L.vector
    ? 'Vector artwork: sharp at any print size.'
    : `${Math.round(L.canvas.width / L.sourceScale)} × ${Math.round(L.canvas.height / L.sourceScale)} pixels after trimming.`;
}

// ---------- catalog and controls ----------

function savedEntry(styleId) {
  return state.overrides.styles?.[styleId] || { placements: {} };
}
function savedOffset(styleId, preset) {
  return savedEntry(styleId).placements?.[preset] || { dxIn: 0, dyIn: 0 };
}
function depictedName(style, sizes) {
  const wanted = savedEntry(style.id).depictedSize || style.depictedSize || defaultDepictedSize(style);
  if (sizes.some((s) => s.name === wanted)) return wanted;
  return sizes[Math.floor((sizes.length - 1) / 2)]?.name;
}

function renderSource(cfg, cat) {
  const st = cfg.status || {};
  let text;
  if (cat.source !== 'ss') {
    if (!cfg.ssConfigured) text = 'Showing sample garments. Add your S&S account and API key to load real styles.';
    else if (st.state === 'error') text = `Showing sample garments. S&S problem: ${st.lastError}`;
    else if (st.state === 'syncing') text = 'Showing sample garments while your starting styles download from S&S.';
    else text = 'Showing sample garments. Search under Style to add your first S&S style.';
  } else {
    const n = cat.styles.length;
    text = `${n} S&S style${n === 1 ? '' : 's'}.`;
    if (cat.syncedAt) text += ` Refreshed ${new Date(cat.syncedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}.`;
    if (st.unmatched?.length) text += ` Not found at S&S: ${st.unmatched.join(', ')}.`;
    if (st.lastError) text += ` ${st.state === 'error' ? 'Last refresh failed: ' : ''}${st.lastError}`;
  }
  $('source').textContent = text;
}

function buildStyleSelect() {
  const sel = $('style');
  sel.replaceChildren(...state.styles.map((s) => new Option(`${s.brand} ${s.name}${s.title ? ` — ${s.title}` : ''}`, s.id)));
}

function buildPresetSelect() {
  $('preset').replaceChildren(...Object.entries(PRESETS).map(([k, p]) => new Option(p.label, k)));
}

function buildSwatches() {
  const s = state.style;
  const box = $('swatches');
  box.replaceChildren(...s.colors.map((c) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'swatch';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-label', c.name);
    b.title = c.name;
    if (c.swatch) b.style.backgroundImage = `url("${c.swatch}")`;
    else b.style.backgroundColor = c.hex || '#999';
    b.addEventListener('click', () => {
      state.colorName = c.name;
      if (state.view === 'back' && !c.back) setPreset(DEFAULT_PRESET[garmentKind(s)]);
      syncSwatches();
      render();
    });
    return b;
  }));
  syncSwatches();
}

function syncSwatches() {
  const s = state.style;
  [...$('swatches').children].forEach((b, i) => b.setAttribute('aria-checked', String(s.colors[i].name === state.colorName)));
  $('colorName').textContent = state.colorName || '';
  const color = currentColor();
  document.querySelector('[data-view="back"]').disabled = !color?.back;
}

function buildSizeSelects() {
  const s = state.style;
  const { sizes } = sizeTable(s, garmentKind(s));
  const opts = () => sizes.map((z) => new Option(`${z.name} (${fmt(z.widthIn)}″ wide)`, z.name));
  $('size').replaceChildren(...opts());
  $('depicted').replaceChildren(...opts());
  const dep = depictedName(s, sizes);
  if (!sizes.some((z) => z.name === state.size)) state.size = dep;
  $('size').value = state.size;
  $('depicted').value = dep;
}

function currentColor() {
  return state.style?.colors.find((c) => c.name === state.colorName) || state.style?.colors[0];
}

function setPreset(key, { chosen = false } = {}) {
  const changed = key !== state.preset;
  state.preset = key;
  if (chosen) state.presetChosen = true;
  state.view = PRESETS[key].view;
  // Picking a placement starts from its standard size; switching garments keeps the size you typed.
  if (chosen || !state.sizeTyped) {
    state.widthIn = PRESETS[key].defaultWidthIn;
    state.lastEdited = 'w';
    state.sizeTyped = false;
  }
  if (changed) state.nudge = { dxIn: 0, dyIn: 0 };
  $('preset').value = key;
  $('w').value = fmt(state.lastEdited === 'w' ? state.widthIn : $('w').value);
  document.querySelectorAll('[data-view]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === state.view)));
}

function selectStyle(id) {
  const s = state.styles.find((x) => x.id === id);
  if (!s || !s.colors.length) return showError('This style has no product images.');
  state.style = s;
  $('style').value = id;
  if (!s.colors.some((c) => c.name === state.colorName)) state.colorName = s.colors[0].name;
  buildSwatches();
  buildSizeSelects();
  if (!state.presetChosen) setPreset(DEFAULT_PRESET[garmentKind(s)]);
  if (state.view === 'back' && !currentColor().back) setPreset(DEFAULT_PRESET[garmentKind(s)]);
  $('removeStyle').hidden = !s.id.startsWith('ss-');
  render();
}

// ---------- adding styles from S&S ----------

async function refreshCatalog(selectId) {
  const [cfg, cat] = await Promise.all([api('/api/config').then((r) => r.json()), api('/api/catalog').then((r) => r.json())]);
  state.config = cfg;
  state.styles = (cat.styles || []).filter((s) => s.colors?.length);
  renderSource(cfg, cat);
  buildStyleSelect();
  const keep = [selectId, state.style?.id].find((id) => id && state.styles.some((s) => s.id === id));
  if (keep || state.styles.length) selectStyle(keep || state.styles[0].id);
}

function resultButton(r) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'result';
  const name = document.createElement('b');
  name.textContent = `${r.brand} ${r.name}`;
  const title = document.createElement('small');
  title.textContent = r.title || '';
  const tag = document.createElement('span');
  tag.className = r.added ? 'tag done' : 'tag';
  tag.textContent = r.added ? 'Added' : r.adding ? 'Adding…' : 'Add';
  b.append(name, tag, title);
  b.addEventListener('click', async () => {
    if (r.added) return selectStyle(`ss-${r.styleID}`);
    if (r.adding) return;
    try {
      showError('');
      await api('/api/styles/add', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ styleID: r.styleID }) });
      r.adding = true;
      tag.textContent = 'Adding…';
      pollJobs();
    } catch (err) { showError(err.message); }
  });
  return b;
}

let searchTimer = 0;
let searchSeq = 0;
function onSearchInput() {
  clearTimeout(searchTimer);
  const q = $('styleSearch').value.trim();
  const list = $('searchResults');
  const note = $('searchNote');
  if (q.length < 2) { list.hidden = true; note.hidden = true; return; }
  searchTimer = setTimeout(async () => {
    const seq = ++searchSeq;
    note.hidden = false;
    note.textContent = 'Searching S&S…';
    try {
      const { results } = await (await api(`/api/styles/search?q=${encodeURIComponent(q)}`)).json();
      if (seq !== searchSeq) return;
      list.replaceChildren(...results.map((r) => { const li = document.createElement('li'); li.append(resultButton(r)); return li; }));
      list.hidden = !results.length;
      note.textContent = results.length ? '' : 'No S&S styles match that. Try the brand and style number, like “Gildan 5000”.';
      note.hidden = !!results.length;
    } catch (err) {
      if (seq === searchSeq) { list.hidden = true; note.textContent = err.message; }
    }
  }, 300);
}

let pollTimer = 0;
let adding = new Set();
async function pollJobs() {
  clearTimeout(pollTimer);
  let jobs;
  try {
    ({ jobs } = await (await api('/api/styles/jobs')).json());
  } catch {
    pollTimer = setTimeout(pollJobs, 5000);
    return;
  }
  $('jobs').replaceChildren(...jobs.map((j) => {
    const li = document.createElement('li');
    if (j.state === 'error') { li.className = 'failed'; li.textContent = `Couldn’t add ${j.brand} ${j.name}. ${j.error}`; }
    else li.textContent = `Adding ${j.brand} ${j.name}… getting its colors and sizes from S&S.`;
    return li;
  }));
  const now = new Set(jobs.filter((j) => j.state === 'adding').map((j) => j.styleID));
  const finished = [...adding].filter((id) => !now.has(id) && !jobs.some((j) => j.styleID === id && j.state === 'error'));
  adding = now;
  if (finished.length) {
    try { await refreshCatalog(`ss-${finished[finished.length - 1]}`); } catch (err) { showError(err.message); }
    if ($('styleSearch').value.trim().length >= 2) onSearchInput();
  }
  if (now.size) pollTimer = setTimeout(pollJobs, 2000);
}

async function removeCurrentStyle() {
  const s = state.style;
  if (!s?.id.startsWith('ss-')) return;
  if (!confirm(`Remove ${s.brand} ${s.name} from your styles? You can add it again any time.`)) return;
  try {
    await api('/api/styles/remove', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: s.id }) });
    state.style = null;
    await refreshCatalog();
  } catch (err) { showError(err.message); }
}

// ---------- rendering ----------

let renderToken = 0;
let rafPending = false;
function scheduleFast() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => { rafPending = false; render({ fast: true }); });
}

async function render({ fast = false } = {}) {
  const token = ++renderToken;
  const s = state.style;
  if (!s) return;
  const color = currentColor();
  const src = color?.[state.view];
  if (!src) return showError('This color doesn’t have an image for this view.');

  let img, geoF;
  // A color picked for the first time downloads from S&S, which takes a moment.
  const slow = setTimeout(() => {
    if (token === renderToken) $('readout').textContent = 'Loading this color’s photo from S&S…';
  }, 300);
  try {
    [img, geoF] = await Promise.all([loadImage(src), getGeometry(s, state.view)]);
  } catch (e) {
    return showError(e.message);
  } finally {
    clearTimeout(slow);
  }
  if (token !== renderToken) return;

  const W = img.naturalWidth, H = img.naturalHeight;
  let geo;
  if (geoF.ok) {
    geo = fromFractions(geoF, W, H);
    showError('');
  } else {
    geo = { ok: false, cx: W / 2, topY: H * 0.15, bottomY: H * 0.85, bodyW: W * 0.45, armY: -1 };
    showError(`${geoF.reason} Placement and size are approximate.`);
  }

  const kind = garmentKind(s);
  const { sizes, typical } = sizeTable(s, kind);
  const depicted = sizes.find((z) => z.name === depictedName(s, sizes));
  const selected = sizes.find((z) => z.name === state.size) || depicted;
  const aspect = state.logo ? state.logo.canvas.height / state.logo.canvas.width : 1;
  const saved = savedOffset(s.id, state.preset);
  const offset = { dxIn: saved.dxIn + state.nudge.dxIn, dyIn: saved.dyIn + state.nudge.dyIn };

  const L = computeLayout({
    geo, kind, depicted, selected, preset: state.preset, aspect,
    widthIn: state.lastEdited === 'w' ? state.widthIn : null,
    heightIn: state.lastEdited === 'h' ? state.heightIn : null,
    offset, limits: state.config,
  });
  state.layout = { ...L, img, geo, selected, typical };

  const other = state.lastEdited === 'w' ? $('h') : $('w');
  if (document.activeElement !== other) other.value = fmt(state.lastEdited === 'w' ? L.sizeIn.h : L.sizeIn.w);

  const canvas = $('shirt');
  if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  ctx.drawImage(img, 0, 0);
  if (state.logo) drawPrint(ctx, img, state.logo.canvas, L.rect, !fast);

  drawOverlay();
  drawRulers();
  updateText();
  $('export').disabled = !state.logo;
}

function displayScale() {
  const c = $('shirt');
  return c.getBoundingClientRect().width / c.width;
}

function drawOverlay() {
  const L = state.layout;
  const ov = $('overlay');
  const r = $('shirt').getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  ov.width = Math.round(r.width * dpr);
  ov.height = Math.round(r.height * dpr);
  const ctx = ov.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, r.width, r.height);
  if (!L) return;
  const k = displayScale();
  const reg = getComputedStyle(document.documentElement).getPropertyValue('--reg').trim() || '#0089a8';
  const rx = L.rect.x * k, ry = L.rect.y * k, rw = L.rect.w * k, rh = L.rect.h * k;

  if (!state.logo) {
    ctx.fillStyle = 'rgba(0,137,168,0.10)';
    ctx.fillRect(rx, ry, rw, rh);
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = reg;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(rx + 0.5, ry + 0.5, rw, rh);
    ctx.setLineDash([]);
  } else if (dragging) {
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = reg;
    ctx.lineWidth = 1;
    ctx.strokeRect(rx + 0.5, ry + 0.5, rw, rh);
    ctx.setLineDash([]);
  }
  if (!state.guides) return;

  // Center line and shoulder line.
  ctx.strokeStyle = reg;
  ctx.globalAlpha = 0.55;
  ctx.lineWidth = 1;
  ctx.setLineDash([6, 5]);
  ctx.beginPath();
  ctx.moveTo(L.centerX * k + 0.5, L.hpsY * k);
  ctx.lineTo(L.centerX * k + 0.5, L.geo.bottomY * k);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo((L.centerX - 2 * L.ppi) * k, L.hpsY * k + 0.5);
  ctx.lineTo((L.centerX + 2 * L.ppi) * k, L.hpsY * k + 0.5);
  ctx.stroke();
  ctx.globalAlpha = 1;

  // Registration mark at the standard print position.
  const ax = L.anchor.x * k, ay = L.anchor.y * k;
  ctx.lineWidth = 1.25;
  ctx.beginPath();
  ctx.arc(ax, ay, 6, 0, Math.PI * 2);
  ctx.moveTo(ax - 11, ay); ctx.lineTo(ax + 11, ay);
  ctx.moveTo(ax, ay - 11); ctx.lineTo(ax, ay + 11);
  ctx.stroke();
}

function drawRulers() {
  const L = state.layout;
  $('frame').classList.toggle('no-guides', !state.guides);
  if (!L) return;
  const r = $('shirt').getBoundingClientRect();
  const k = displayScale();
  const step = L.ppi * k;
  const dpr = window.devicePixelRatio || 1;
  const css = getComputedStyle(document.documentElement);
  const ink = css.getPropertyValue('--muted').trim() || '#5c6b7a';
  const paper = css.getPropertyValue('--paper').trim() || '#fff';

  const draw = (canvas, length, origin, horizontal) => {
    canvas.style.width = horizontal ? `${length}px` : '28px';
    canvas.style.height = horizontal ? '28px' : `${length}px`;
    canvas.width = Math.round((horizontal ? length : 28) * dpr);
    canvas.height = Math.round((horizontal ? 28 : length) * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = paper;
    ctx.fillRect(0, 0, horizontal ? length : 28, horizontal ? 28 : length);
    ctx.strokeStyle = ink;
    ctx.fillStyle = ink;
    ctx.font = '10px system-ui, sans-serif';
    ctx.lineWidth = 1;
    const quarter = step / 4 >= 4;
    const every = [1, 2, 5, 10, 20].find((n) => n * step >= (horizontal ? 22 : 26)) || 20;
    const first = Math.ceil(-origin / (step / 4));
    const last = Math.floor((length - origin) / (step / 4));
    ctx.beginPath();
    for (let q = first; q <= last; q++) {
      const pos = Math.round(origin + (q * step) / 4) + 0.5;
      const whole = q % 4 === 0, half = q % 2 === 0;
      if (!whole && !half && !quarter) continue;
      const len = whole ? 12 : half ? 8 : 5;
      if (horizontal) { ctx.moveTo(pos, 28); ctx.lineTo(pos, 28 - len); } else { ctx.moveTo(28, pos); ctx.lineTo(28 - len, pos); }
      if (whole && (q / 4) % every === 0) {
        const label = String(Math.abs(q / 4));
        if (horizontal) ctx.fillText(label, pos + 2, 11);
        else { ctx.save(); ctx.translate(11, pos + 2); ctx.rotate(-Math.PI / 2); ctx.fillText(label, -ctx.measureText(label).width, 0); ctx.restore(); }
      }
    }
    ctx.stroke();
  };
  draw($('rulerTop'), r.width, L.centerX * k, true);
  draw($('rulerLeft'), r.height, L.hpsY * k, false);
}

function updateText() {
  const L = state.layout;
  const s = state.style;
  const readout = $('readout');
  const sizeLine = `${fmt(L.sizeIn.w)}″ × ${fmt(L.sizeIn.h)}″ on a size ${L.selected.name}`;
  const sub = [];
  if (!state.logo) sub.push('Add artwork to see it on the shirt. The outline shows the print size.');
  if (L.typical) sub.push('No size chart for this style, so typical measurements are used.');
  sub.push(...L.notes);
  readout.replaceChildren(document.createTextNode(state.logo ? sizeLine : `Print area ${sizeLine}`));
  for (const t of sub) { const sm = document.createElement('small'); sm.textContent = t; readout.append(sm); }

  const warnings = [...L.warnings];
  if (state.logo && !state.logo.vector) {
    const ppiArt = state.logo.canvas.width / state.logo.sourceScale / L.sizeIn.w;
    if (ppiArt < 150) warnings.push(`The artwork has ${Math.round(ppiArt)} pixels per inch at this size and may print soft. Aim for 300, or use vector art.`);
  }
  $('warnings').replaceChildren(...warnings.map((w) => { const li = document.createElement('li'); li.textContent = w; return li; }));

  const saved = savedOffset(s.id, state.preset);
  const hasSaved = saved.dxIn !== 0 || saved.dyIn !== 0;
  const moved = state.nudge.dxIn !== 0 || state.nudge.dyIn !== 0;
  let info = 'Drag the logo or use the arrow keys to fine-tune it.';
  if (moved) info = `Moved ${signed(state.nudge.dxIn)}″ across and ${signed(state.nudge.dyIn)}″ down. This carries over when you change garments.`;
  if (hasSaved) info += ` A saved position for this style is applied (${signed(saved.dxIn)}″ across, ${signed(saved.dyIn)}″ down).`;
  $('posInfo').textContent = info;
  $('resetPos').disabled = !moved;
  $('savePos').disabled = !moved;
  $('clearSaved').hidden = !hasSaved;
}

// ---------- interaction ----------

let dragging = null;

function toImagePoint(e) {
  const r = $('overlay').getBoundingClientRect();
  const k = displayScale();
  return { x: (e.clientX - r.left) / k, y: (e.clientY - r.top) / k };
}
function insidePrint(pt) {
  const L = state.layout;
  if (!L || !state.logo) return false;
  const pad = 8 / displayScale();
  const r = L.rect;
  return pt.x >= r.x - pad && pt.x <= r.x + r.w + pad && pt.y >= r.y - pad && pt.y <= r.y + r.h + pad;
}

async function postOverride(body) {
  const res = await api('/api/overrides', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  state.overrides = await res.json();
}

function bind() {
  const fileInput = $('file');
  const drop = $('drop');
  const handleFile = async (file) => {
    if (!file) return;
    try {
      showError('');
      await loadArtwork(file);
      render();
    } catch (e) {
      $('dropText').textContent = state.logo?.name || 'Drop a logo here or choose a file';
      showError(e.message);
    }
  };
  fileInput.addEventListener('change', () => handleFile(fileInput.files[0]));
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); handleFile(e.dataTransfer.files[0]); });
  $('removeBg').addEventListener('change', () => { try { processArtwork(); render(); } catch (e) { showError(e.message); } });

  $('style').addEventListener('change', (e) => selectStyle(e.target.value));
  $('styleSearch').addEventListener('input', onSearchInput);
  $('removeStyle').addEventListener('click', removeCurrentStyle);
  document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.view === state.view) return;
    setPreset(b.dataset.view === 'back' ? 'full-back' : DEFAULT_PRESET[garmentKind(state.style)], { chosen: true });
    render();
  }));
  $('preset').addEventListener('change', (e) => {
    const key = e.target.value;
    if (PRESETS[key].view === 'back' && !currentColor()?.back) { $('preset').value = state.preset; return showError('This color doesn’t have a back image.'); }
    setPreset(key, { chosen: true });
    render();
  });

  const dimInput = (which) => (e) => {
    const v = parseFloat(e.target.value);
    if (!(v > 0) || v > 30) return;
    state.lastEdited = which;
    state.sizeTyped = true;
    if (which === 'w') state.widthIn = v; else state.heightIn = v;
    render();
  };
  $('w').addEventListener('input', dimInput('w'));
  $('h').addEventListener('input', dimInput('h'));
  $('size').addEventListener('change', (e) => { state.size = e.target.value; render(); });
  $('depicted').addEventListener('change', async (e) => {
    const s = state.style;
    const isDefault = e.target.value === (s.depictedSize || defaultDepictedSize(s));
    try { await postOverride({ styleId: s.id, depictedSize: isDefault ? null : e.target.value }); render(); } catch (err) { showError(err.message); }
  });

  $('resetPos').addEventListener('click', () => { state.nudge = { dxIn: 0, dyIn: 0 }; render(); });
  $('savePos').addEventListener('click', async () => {
    const s = state.style;
    const saved = savedOffset(s.id, state.preset);
    try {
      await postOverride({ styleId: s.id, placement: { preset: state.preset, dxIn: saved.dxIn + state.nudge.dxIn, dyIn: saved.dyIn + state.nudge.dyIn } });
      state.nudge = { dxIn: 0, dyIn: 0 };
      render();
    } catch (err) { showError(err.message); }
  });
  $('clearSaved').addEventListener('click', async () => {
    try { await postOverride({ styleId: state.style.id, placement: { preset: state.preset, clear: true } }); render(); } catch (err) { showError(err.message); }
  });
  $('guides').addEventListener('change', (e) => { state.guides = e.target.checked; drawOverlay(); drawRulers(); });

  const ov = $('overlay');
  ov.addEventListener('pointerdown', (e) => {
    const pt = toImagePoint(e);
    if (!insidePrint(pt)) return;
    dragging = { x: pt.x, y: pt.y, dx: state.nudge.dxIn, dy: state.nudge.dyIn };
    ov.setPointerCapture(e.pointerId);
    ov.style.cursor = 'grabbing';
    e.preventDefault();
  });
  ov.addEventListener('pointermove', (e) => {
    const pt = toImagePoint(e);
    if (!dragging) { ov.style.cursor = insidePrint(pt) ? 'grab' : 'default'; return; }
    const ppi = state.layout.ppi;
    state.nudge = { dxIn: snap(dragging.dx + (pt.x - dragging.x) / ppi), dyIn: snap(dragging.dy + (pt.y - dragging.y) / ppi) };
    scheduleFast();
  });
  const end = () => { if (!dragging) return; dragging = null; ov.style.cursor = 'grab'; render(); };
  ov.addEventListener('pointerup', end);
  ov.addEventListener('pointercancel', end);

  $('art').addEventListener('keydown', (e) => {
    const moves = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (!moves[e.key] || !state.logo) return;
    e.preventDefault();
    const stepIn = e.shiftKey ? 0.5 : 0.125;
    state.nudge = { dxIn: snap(state.nudge.dxIn + moves[e.key][0] * stepIn), dyIn: snap(state.nudge.dyIn + moves[e.key][1] * stepIn) };
    render();
  });

  $('export').addEventListener('click', exportPng);
  const redrawGuides = () => { if (state.layout) { drawOverlay(); drawRulers(); } };
  new ResizeObserver(redrawGuides).observe($('shirt'));
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', redrawGuides);
}

function exportPng() {
  const L = state.layout;
  if (!L || !state.logo) return;
  const c = makeCanvas(L.img.naturalWidth, L.img.naturalHeight);
  const ctx = c.getContext('2d');
  ctx.drawImage(L.img, 0, 0);
  drawPrint(ctx, L.img, state.logo.canvas, L.rect, true);
  const s = state.style;
  const name = [s.brand, s.name, state.colorName, state.view, L.selected.name].join('-').replace(/[^\w-]+/g, '_');
  c.toBlob((blob) => {
    if (!blob) return showError('Couldn’t create the PNG.');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${name}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }, 'image/png');
}

// ---------- start ----------

async function init() {
  try {
    const [cfg, cat, ov] = await Promise.all([
      api('/api/config').then((r) => r.json()),
      api('/api/catalog').then((r) => r.json()),
      api('/api/overrides').then((r) => r.json()),
    ]);
    state.config = cfg;
    state.styles = (cat.styles || []).filter((s) => s.colors?.length);
    state.overrides = ov;
    renderSource(cfg, cat);
    buildStyleSelect();
    buildPresetSelect();
    bind();
    $('w').value = fmt(state.widthIn);
    // Always visible so people know it exists; waits on the S&S key until it's set.
    $('ssAdd').hidden = false;
    if (!cfg.ssConfigured) {
      $('styleSearch').disabled = true;
      $('styleSearch').placeholder = 'Waiting for S&S to be connected';
      $('searchNote').hidden = false;
      $('searchNote').textContent = 'To search S&S styles, add your S&S account number and API key in the Unraid container settings.';
    }
    if (state.styles.length) selectStyle(state.styles[0].id);
    else showError('No garments are available yet. Search under Style to add one.');
    if (cfg.ssConfigured) pollJobs();
  } catch (e) {
    showError(e.message);
  }
}
init();
