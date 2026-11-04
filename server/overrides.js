// Per-style corrections saved from the app: which size the photo shows, and
// position adjustments for a placement. Stored in /data/overrides.json.
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { UserError } from './convert.js';

const PRESETS = new Set(['full-front', 'center-chest', 'left-chest', 'full-back', 'upper-back']);
const file = () => path.join(config.dataDir, 'overrides.json');
let cache = null;
let writing = Promise.resolve();

export async function readOverrides() {
  if (cache) return cache;
  try {
    cache = JSON.parse(await readFile(file(), 'utf8'));
  } catch {
    cache = { styles: {} };
  }
  if (!cache.styles || typeof cache.styles !== 'object') cache = { styles: {} };
  return cache;
}

const finite = (v, limit) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= limit;

export async function applyOverride(body) {
  if (!body || typeof body !== 'object') throw new UserError('Expected a JSON object.');
  const { styleId } = body;
  if (typeof styleId !== 'string' || !/^[\w-]{1,64}$/.test(styleId)) throw new UserError('Unknown style.');

  // Saves run one at a time, so two quick saves can't overwrite each other.
  // Each works on a copy; the in-memory copy changes only once the file is
  // written, so a failed save leaves both exactly as they were.
  const job = writing.then(async () => {
    const data = structuredClone(await readOverrides());
    const entry = data.styles[styleId] || { placements: {} };
    entry.placements ||= {};

    if ('depictedSize' in body) {
      if (body.depictedSize === null) delete entry.depictedSize;
      else if (typeof body.depictedSize === 'string' && /^[\w/ -]{1,12}$/.test(body.depictedSize)) entry.depictedSize = body.depictedSize;
      else throw new UserError('Unknown size.');
    }
    if ('placement' in body) {
      const p = body.placement;
      if (!p || !PRESETS.has(p.preset)) throw new UserError('Unknown placement.');
      if (p.clear) delete entry.placements[p.preset];
      else if (finite(p.dxIn, 12) && finite(p.dyIn, 12)) {
        entry.placements[p.preset] = { dxIn: Math.round(p.dxIn * 1000) / 1000, dyIn: Math.round(p.dyIn * 1000) / 1000 };
      } else throw new UserError('Position adjustments must be within 12 inches.');
    }

    data.styles[styleId] = entry;
    await mkdir(config.dataDir, { recursive: true });
    await writeFile(`${file()}.tmp`, JSON.stringify(data, null, 2));
    await rename(`${file()}.tmp`, file());
    cache = data;
    return data;
  });
  // A failed save must not block the ones after it.
  writing = job.catch(() => {});
  return job;
}
