// Pulls the styles you list in SS_STYLES from S&S Activewear, caches their
// images on disk, and keeps a local catalog.json. Only read (GET) requests are
// ever made: this code has no way to place orders.
import { mkdir, readFile, writeFile, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { config, ssEnabled } from './config.js';
import { demoCatalog } from './demo.js';

const status = { state: 'idle', lastSync: null, lastError: null, unmatched: [], styleCount: 0 };
let catalog = null;

const catalogFile = () => path.join(config.dataDir, 'catalog.json');
const imageDir = () => path.join(config.dataDir, 'images', 'ss');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

export function getStatus() {
  return { ...status, source: catalog?.source || 'demo' };
}

export async function getCatalog() {
  // Without S&S settings, always show the samples, even if an old catalog.json is on disk.
  if (!ssEnabled()) return { source: 'demo', styles: demoCatalog() };
  if (catalog) return catalog;
  try {
    catalog = JSON.parse(await readFile(catalogFile(), 'utf8'));
  } catch {
    catalog = null;
  }
  return catalog || { source: 'demo', styles: demoCatalog() };
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
    if (res.status === 401 || res.status === 403) throw new Error('S&S rejected the account number or API key.');
    if (res.status === 404) return [];
    if (!res.ok) throw new Error(`S&S request ${pathAndQuery.split('?')[0]} failed with ${res.status}.`);
    await sleep(1100); // stay well under the S&S rate limit
    return res.json();
  }
  throw new Error('S&S rate limit kept rejecting requests. Sync will retry tomorrow.');
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
      if (Date.now() - s.mtimeMs < 30 * 24 * 3600 * 1000) return `/img/ss/${file}`;
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

async function buildStyle(s) {
  const products = await ssGet(`/products/?style=${encodeURIComponent(s.styleID)}`);
  let specs = [];
  try {
    specs = await ssGet(`/specs/?style=${encodeURIComponent(s.styleID)}`);
  } catch {
    specs = [];
  }

  const sizeOrder = [...new Map(products.map((p) => [p.sizeName, p.sizeOrder || ''])).entries()]
    .sort((a, b) => String(a[1]).localeCompare(String(b[1])))
    .map(([n]) => n);

  const colors = new Map();
  for (const p of products) {
    if (!p.colorName || colors.has(p.colorName)) continue;
    colors.set(p.colorName, p);
  }

  const out = [];
  for (const p of colors.values()) {
    const front = await cacheImage(p.colorFrontImage);
    if (!front) continue;
    out.push({
      name: p.colorName,
      hex: /^#[0-9a-f]{6}$/i.test(p.color1 || '') ? p.color1 : null,
      swatch: await cacheImage(p.colorSwatchImage),
      front,
      back: await cacheImage(p.colorBackImage),
    });
  }

  return {
    id: `ss-${s.styleID}`,
    brand: s.brandName,
    name: s.styleName,
    title: s.title || '',
    category: [s.baseCategory, s.categories].filter(Boolean).join(' '),
    depictedSize: null, // the app assumes a default per garment type; override per style in the app
    sizes: specsToSizes(specs, sizeOrder),
    sizeNames: sizeOrder,
    colors: out,
  };
}

export async function syncNow() {
  if (!ssEnabled() || status.state === 'syncing') return;
  status.state = 'syncing';
  try {
    await mkdir(imageDir(), { recursive: true });
    const all = await ssGet('/styles/');
    const wanted = config.ss.styles;
    const matched = [];
    const unmatched = [];
    for (const w of wanted) {
      const key = norm(w);
      const hit = all.find(
        (s) => String(s.styleID) === w || norm(`${s.brandName} ${s.styleName}`) === key || (s.partNumber && norm(s.partNumber) === key)
      );
      if (hit) matched.push(hit);
      else unmatched.push(w);
    }
    const styles = [];
    for (const s of matched) styles.push(await buildStyle(s));
    const next = { source: 'ss', syncedAt: new Date().toISOString(), styles };
    await writeFile(`${catalogFile()}.tmp`, JSON.stringify(next));
    await rename(`${catalogFile()}.tmp`, catalogFile());
    catalog = next;
    Object.assign(status, { state: 'idle', lastSync: next.syncedAt, lastError: null, unmatched, styleCount: styles.length });
    console.log(`S&S sync finished: ${styles.length} styles${unmatched.length ? `, not found: ${unmatched.join(', ')}` : ''}`);
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
  const existing = await getCatalog();
  if (existing.source === 'ss') {
    status.lastSync = existing.syncedAt;
    status.styleCount = existing.styles.length;
  }
  const age = existing.syncedAt ? Date.now() - Date.parse(existing.syncedAt) : Infinity;
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
