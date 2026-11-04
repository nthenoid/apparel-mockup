// Your garment library. You search S&S from inside the tool and add the styles
// you want; each one's photos and size chart are downloaded once and kept in
// catalog.json. The nightly sync refreshes only the styles you've added.
// Only read (GET) requests are ever made to S&S: this code can't place orders.
import { mkdir, readFile, writeFile, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { config, ssEnabled } from './config.js';
import { demoCatalog } from './demo.js';
import { UserError } from './convert.js';

const status = { state: 'idle', lastSync: null, lastError: null, unmatched: [], styleCount: 0 };
let catalog = null; // { source: 'ss', syncedAt, seeded, styles: [] }
let styleIndex = null; // { fetchedAt, styles: [every S&S style, slimmed] }
let indexLoading = null;
let queue = Promise.resolve();
const jobs = new Map(); // styleID -> { styleID, brand, name, state: 'adding' | 'error', error, at }

const DAY = 24 * 3600 * 1000;
const MAX_ADDING = 3;
const catalogFile = () => path.join(config.dataDir, 'catalog.json');
const indexFile = () => path.join(config.dataDir, 'ss-styles.json');
const imageDir = () => path.join(config.dataDir, 'images', 'ss');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const sid = (style) => String(style.styleID ?? String(style.id || '').replace(/^ss-/, ''));
const byName = (a, b) => `${a.brand} ${a.name}`.localeCompare(`${b.brand} ${b.name}`, undefined, { numeric: true });

async function writeJson(file, data) {
  await mkdir(config.dataDir, { recursive: true });
  await writeFile(`${file}.tmp`, JSON.stringify(data));
  await rename(`${file}.tmp`, file);
}

async function loadCatalog() {
  if (catalog) return catalog;
  try {
    const c = JSON.parse(await readFile(catalogFile(), 'utf8'));
    if (c && Array.isArray(c.styles)) catalog = c;
  } catch {
    /* no catalog yet */
  }
  return catalog;
}

// Every change to the library goes through this queue, so adding a style while
// the nightly sync runs can't overwrite one or the other.
function mutateCatalog(change) {
  const job = queue.then(async () => {
    const next = structuredClone((await loadCatalog()) || { source: 'ss', styles: [] });
    change(next);
    next.styles.sort(byName);
    await writeJson(catalogFile(), next);
    catalog = next;
    status.styleCount = next.styles.length;
    return next;
  });
  queue = job.catch(() => {});
  return job;
}

export function getStatus() {
  return { ...status, source: ssEnabled() && catalog?.styles.length ? 'ss' : 'demo' };
}

// Sample garments show until S&S is connected and at least one style is added.
export async function getCatalog() {
  if (!ssEnabled()) return { source: 'demo', styles: demoCatalog() };
  const c = await loadCatalog();
  if (!c || !c.styles.length) return { source: 'demo', styles: demoCatalog() };
  return c;
}

// ---------- measurement parsing ----------

export function parseInches(v) {
  if (typeof v === 'number') return v;
  const s = String(v ?? '')
    .trim()
    .replace(/["”″]|inches|inch|in\.?$/gi, '')
    .trim();
  let m = s.match(/^(\d+(?:\.\d+)?)(?:[\s-]+(\d+)\/(\d+))?$/);
  if (m) return Number(m[1]) + (m[2] ? Number(m[2]) / Number(m[3]) : 0);
  m = s.match(/^(\d+)\/(\d+)$/);
  if (m) return Number(m[1]) / Number(m[2]);
  return NaN;
}

function classify(name) {
  const n = String(name || '').toLowerCase();
  if (/sleeve|shoulder|neck|hem|bottom|cuff|hood|pocket|waist|hip|inseam|rise/.test(n)) return null;
  if (/body width|chest width|1\/2 chest|half chest|chest \(flat\)|flat chest|^width$|^chest width/.test(n)) return 'widthIn';
  if (/body length|full length|hps|^length$|front length|center back length/.test(n)) return 'lengthIn';
  return null;
}

// S&S spec rows are matched by name so small wording differences still work.
export function specsToSizes(specs, sizeOrder = []) {
  const bySize = new Map();
  const put = (size, field, value) => {
    const v = parseInches(value);
    const ok = field === 'widthIn' ? v >= 8 && v <= 45 : v >= 12 && v <= 50;
    if (!size || !ok) return;
    const row = bySize.get(size) || { name: size };
    if (row[field] == null) row[field] = v;
    bySize.set(size, row);
  };
  for (const item of Array.isArray(specs) ? specs : []) {
    const size = item.sizeName || item.size;
    if (item.specName || item.name) {
      const field = classify(item.specName || item.name);
      if (field) put(size, field, item.value);
    } else {
      for (const [k, v] of Object.entries(item)) {
        const field = classify(k);
        if (field) put(size, field, v);
      }
    }
  }
  const order = (n) => {
    const i = sizeOrder.indexOf(n);
    return i < 0 ? 999 : i;
  };
  return [...bySize.values()].filter((r) => r.widthIn && r.lengthIn).sort((a, b) => order(a.name) - order(b.name));
}

// ---------- S&S API ----------

class FatalSSError extends Error {}

async function ssGet(pathAndQuery) {
  const auth = Buffer.from(`${config.ss.account}:${config.ss.apiKey}`).toString('base64');
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(config.ss.apiBase + pathAndQuery, {
      headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(90_000),
    });
    if (res.status === 429) {
      await sleep(15_000 * (attempt + 1));
      continue;
    }
    if (res.status === 401 || res.status === 403) throw new FatalSSError('S&S rejected the account number or API key.');
    if (res.status === 404) return [];
    if (!res.ok) throw new Error(`S&S request ${pathAndQuery.split('?')[0]} failed with ${res.status}.`);
    await sleep(config.ss.requestGapMs); // stay well under the S&S rate limit
    return res.json();
  }
  throw new FatalSSError('S&S is limiting requests right now. Try again in a few minutes.');
}

// The full list of S&S styles, kept on disk and refreshed at most once a day.
async function getStyleIndex({ maxAgeMs = DAY } = {}) {
  if (!styleIndex) {
    try {
      styleIndex = JSON.parse(await readFile(indexFile(), 'utf8'));
    } catch {
      styleIndex = null;
    }
  }
  if (styleIndex && Date.now() - styleIndex.fetchedAt < maxAgeMs) return styleIndex.styles;

  indexLoading ||= (async () => {
    const all = await ssGet('/styles/');
    const styles = (Array.isArray(all) ? all : [])
      .filter((s) => s && s.styleID != null)
      .map((s) => ({
        styleID: String(s.styleID),
        partNumber: s.partNumber || '',
        brandName: s.brandName || '',
        styleName: s.styleName || '',
        title: s.title || '',
        baseCategory: s.baseCategory || '',
        categories: s.categories || '',
      }));
    if (!styles.length) throw new Error('S&S returned an empty style list.');
    styleIndex = { fetchedAt: Date.now(), styles };
    await writeJson(indexFile(), styleIndex);
  })().finally(() => {
    indexLoading = null;
  });

  try {
    await indexLoading;
  } catch (err) {
    if (styleIndex) return styleIndex.styles; // an old list beats no list
    throw err;
  }
  return styleIndex.styles;
}

const SAFE_IMAGE = /^Images\/[A-Za-z0-9_./-]+\.(jpe?g|png)$/i;

async function cacheImage(rel) {
  if (!rel || !SAFE_IMAGE.test(rel) || rel.includes('..')) return null;
  const candidates = [rel.replace(/_fm\.(jpe?g|png)$/i, '_fl.$1'), rel];
  for (const candidate of [...new Set(candidates)]) {
    const file = path.basename(candidate);
    const local = path.join(imageDir(), file);
    try {
      const s = await stat(local);
      if (Date.now() - s.mtimeMs < 30 * DAY) return `/img/ss/${file}`;
    } catch {
      /* not cached yet */
    }
    try {
      const res = await fetch(`${config.ss.imageBase}/${candidate}`, { signal: AbortSignal.timeout(60_000) });
      const type = res.headers.get('content-type') || '';
      if (!res.ok || !type.startsWith('image/')) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 15 * 1024 * 1024) continue;
      await writeFile(`${local}.tmp`, buf);
      await rename(`${local}.tmp`, local);
      return `/img/ss/${file}`;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function buildStyle(s) {
  await mkdir(imageDir(), { recursive: true });
  const products = await ssGet(`/products/?style=${encodeURIComponent(s.styleID)}`);
  let specs = [];
  try {
    specs = await ssGet(`/specs/?style=${encodeURIComponent(s.styleID)}`);
  } catch (err) {
    if (err instanceof FatalSSError) throw err;
    specs = [];
  }

  const list = Array.isArray(products) ? products : [];
  const sizeOrder = [...new Map(list.map((p) => [p.sizeName, p.sizeOrder || ''])).entries()]
    .sort((a, b) => String(a[1]).localeCompare(String(b[1])))
    .map(([n]) => n);

  const colors = new Map();
  for (const p of list) {
    if (!p.colorName || colors.has(p.colorName)) continue;
    colors.set(p.colorName, p);
  }

  // Several colors download at once so a big style finishes in a minute or two.
  const built = await mapLimit([...colors.values()], 4, async (p) => {
    const front = await cacheImage(p.colorFrontImage);
    if (!front) return null;
    return {
      name: p.colorName,
      hex: /^#[0-9a-f]{6}$/i.test(p.color1 || '') ? p.color1 : null,
      swatch: await cacheImage(p.colorSwatchImage),
      front,
      back: await cacheImage(p.colorBackImage),
    };
  });

  return {
    id: `ss-${s.styleID}`,
    styleID: String(s.styleID),
    brand: s.brandName,
    name: s.styleName,
    title: s.title || '',
    category: [s.baseCategory, s.categories].filter(Boolean).join(' '),
    depictedSize: null, // the app assumes a default per garment type; override per style in the app
    sizes: specsToSizes(specs, sizeOrder),
    sizeNames: sizeOrder,
    colors: built.filter(Boolean),
  };
}

function requireSS() {
  if (!ssEnabled()) throw new UserError('Add your S&S account number and API key in the container settings first.', 409);
}

async function indexOrUserError() {
  try {
    return await getStyleIndex();
  } catch (err) {
    throw new UserError(`Couldn’t get the style list from S&S. ${err.message}`, 502);
  }
}

// ---------- search, add, remove ----------

export async function searchStyles(query) {
  requireSS();
  const q = String(query || '').trim().slice(0, 100);
  const tokens = q.split(/\s+/).map(norm).filter(Boolean).slice(0, 6);
  if (!tokens.length) return [];
  const all = await indexOrUserError();
  const have = new Set(((await loadCatalog())?.styles || []).map(sid));
  const key = norm(q);
  const rank = (s) => {
    if (s.styleID === q || norm(s.styleName) === key || norm(`${s.brandName}${s.styleName}`) === key || norm(s.partNumber) === key) return 0;
    if (norm(`${s.brandName}${s.styleName}`).includes(key)) return 1;
    return 2;
  };
  const hits = all.filter((s) => {
    if (s.styleID === q) return true;
    // Fields stay separate so numbers can't run together into false matches
    // ("18500" + "01800" must not match "5000").
    const hay = [s.brandName, s.styleName, s.partNumber, ...String(s.title).split(/\s+/)].map(norm).join(' ');
    return tokens.every((t) => hay.includes(t));
  });
  hits.sort((a, b) => rank(a) - rank(b) || byName({ brand: a.brandName, name: a.styleName }, { brand: b.brandName, name: b.styleName }));
  return hits.slice(0, 25).map((s) => ({
    styleID: s.styleID,
    brand: s.brandName,
    name: s.styleName,
    title: s.title,
    added: have.has(s.styleID),
    adding: jobs.get(s.styleID)?.state === 'adding',
  }));
}

export function listJobs() {
  for (const [id, j] of jobs) if (j.state === 'error' && Date.now() - j.at > 10 * 60 * 1000) jobs.delete(id);
  return [...jobs.values()];
}

// Starts downloading a style and returns right away; the tool checks back
// with listJobs() until it's done.
export async function addStyle(styleID) {
  requireSS();
  const id = String(styleID ?? '').trim();
  if (!/^\d{1,10}$/.test(id)) throw new UserError('Unknown style.');
  const existing = jobs.get(id);
  if (existing?.state === 'adding') return existing;
  if ([...jobs.values()].filter((j) => j.state === 'adding').length >= MAX_ADDING) {
    throw new UserError(`${MAX_ADDING} styles are already downloading. Try again when one finishes.`, 503);
  }
  const all = await indexOrUserError();
  const s = all.find((x) => x.styleID === id);
  if (!s) throw new UserError('S&S doesn’t list that style any more.', 404);

  const job = { styleID: id, brand: s.brandName, name: s.styleName, state: 'adding', error: null, at: Date.now() };
  jobs.set(id, job);
  // Kept off the JSON the tool sees; tests await it.
  Object.defineProperty(job, 'done', { enumerable: false, value: (async () => {
    try {
      const built = await buildStyle(s);
      if (!built.colors.length) throw new Error('S&S has no product photos for this style.');
      await mutateCatalog((c) => {
        c.styles = c.styles.filter((x) => sid(x) !== id);
        c.styles.push(built);
      });
      jobs.delete(id);
      console.log(`Added ${s.brandName} ${s.styleName} (${built.colors.length} colors)`);
    } catch (err) {
      Object.assign(job, { state: 'error', error: err.message, at: Date.now() });
      console.error(`Couldn’t add ${s.brandName} ${s.styleName}:`, err.message);
    }
  })() });
  return job;
}

export async function removeStyle(id) {
  requireSS();
  const key = String(id ?? '').replace(/^ss-/, '');
  if (!/^\d{1,10}$/.test(key)) throw new UserError('Unknown style.');
  const c = await mutateCatalog((cat) => {
    cat.styles = cat.styles.filter((x) => sid(x) !== key);
  });
  return { removed: key, styleCount: c.styles.length };
}

// ---------- nightly refresh ----------

function matchWanted(all, wanted) {
  const key = norm(wanted);
  return all.find((s) => s.styleID === wanted || norm(`${s.brandName} ${s.styleName}`) === key || (s.partNumber && norm(s.partNumber) === key));
}

export async function syncNow() {
  if (!ssEnabled() || status.state === 'syncing') return;
  status.state = 'syncing';
  try {
    const all = await getStyleIndex({ maxAgeMs: 12 * 3600 * 1000 });
    const current = await loadCatalog();
    const ids = (current?.styles || []).map(sid);

    // SS_STYLES is only a starting list, used the very first time.
    const seedIds = new Set();
    const unmatched = [];
    if (!current?.seeded) {
      for (const w of config.ss.styles) {
        const hit = matchWanted(all, w);
        if (hit) seedIds.add(hit.styleID);
        else unmatched.push(w);
      }
    }

    let failed = 0;
    for (const id of [...new Set([...ids, ...seedIds])]) {
      const s = all.find((x) => x.styleID === id);
      if (!s) continue; // discontinued at S&S: keep what we have
      let built;
      try {
        built = await buildStyle(s);
      } catch (err) {
        if (err instanceof FatalSSError) throw err;
        failed++;
        continue;
      }
      if (!built.colors.length) {
        failed++;
        continue;
      }
      await mutateCatalog((c) => {
        const i = c.styles.findIndex((x) => sid(x) === id);
        if (i >= 0) c.styles[i] = built;
        else if (seedIds.has(id)) c.styles.push(built); // a style removed during the sync stays removed
      });
    }

    const done = await mutateCatalog((c) => {
      c.seeded = true;
      c.syncedAt = new Date().toISOString();
    });
    Object.assign(status, {
      state: 'idle',
      lastSync: done.syncedAt,
      lastError: failed ? `${failed} style${failed === 1 ? '' : 's'} couldn’t be refreshed and kept their previous data.` : null,
      unmatched,
      styleCount: done.styles.length,
    });
    console.log(`S&S sync finished: ${done.styles.length} styles${unmatched.length ? `, not found: ${unmatched.join(', ')}` : ''}`);
  } catch (err) {
    Object.assign(status, { state: 'error', lastError: err.message });
    console.error('S&S sync failed:', err.message);
  }
}

export async function startSyncSchedule() {
  if (!ssEnabled()) {
    console.log('S&S not configured: showing sample garments.');
    return;
  }
  const existing = await loadCatalog();
  if (existing) {
    status.lastSync = existing.syncedAt || null;
    status.styleCount = existing.styles.length;
  }
  const age = existing?.syncedAt ? Date.now() - Date.parse(existing.syncedAt) : Infinity;
  if (age > 20 * 3600 * 1000) syncNow();

  const scheduleNext = () => {
    const now = new Date();
    const next = new Date(now);
    next.setHours(config.syncHour, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    setTimeout(async () => {
      await syncNow();
      scheduleNext();
    }, next - now);
  };
  scheduleNext();
}
