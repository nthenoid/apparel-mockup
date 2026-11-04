import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config } from '../server/config.js';
import { applyOverride, readOverrides } from '../server/overrides.js';
import { convertVector } from '../server/convert.js';
import { getCatalog } from '../server/catalog.js';

const tmp = await mkdtemp(path.join(os.tmpdir(), 'mockup-test-'));
test.after(() => rm(tmp, { recursive: true, force: true }));

test('a failed save does not block later saves or change saved positions', async () => {
  const good = path.join(tmp, 'data');
  const blocker = path.join(tmp, 'not-a-folder');
  await writeFile(blocker, 'x');

  config.dataDir = path.join(blocker, 'data'); // can't be created: parent is a file
  await assert.rejects(applyOverride({ styleId: 'demo-tee', depictedSize: 'XL' }));
  assert.equal((await readOverrides()).styles['demo-tee'], undefined, 'memory unchanged after a failed save');

  config.dataDir = good;
  const saved = await applyOverride({ styleId: 'demo-tee', placement: { preset: 'full-front', dxIn: 0.5, dyIn: -0.25 } });
  assert.deepEqual(saved.styles['demo-tee'].placements['full-front'], { dxIn: 0.5, dyIn: -0.25 });
  const onDisk = JSON.parse(await readFile(path.join(good, 'overrides.json'), 'utf8'));
  assert.deepEqual(onDisk, saved);
});

test('a rejected change leaves nothing half-applied', async () => {
  config.dataDir = path.join(tmp, 'data');
  // demo-tee already has a saved entry from the test above.
  await assert.rejects(applyOverride({ styleId: 'demo-tee', depictedSize: 'M', placement: { preset: 'nope' } }));
  assert.equal((await readOverrides()).styles['demo-tee'].depictedSize, undefined);
});

test('converter does not get stuck "busy" when its temp folder cannot be made', async () => {
  const pdf = Buffer.from('%PDF-1.4 test');
  const saved = process.env.TMPDIR;
  process.env.TMPDIR = path.join(tmp, 'missing', 'dir');
  try {
    for (let i = 0; i < 3; i++) await assert.rejects(convertVector(pdf), (e) => !/busy/.test(e.message));
  } finally {
    if (saved == null) delete process.env.TMPDIR;
    else process.env.TMPDIR = saved;
  }
  await assert.rejects(convertVector(pdf), (e) => !/busy/.test(e.message));
});

test('removing S&S settings goes back to sample garments', async () => {
  config.dataDir = path.join(tmp, 'data');
  await writeFile(path.join(config.dataDir, 'catalog.json'), JSON.stringify({ source: 'ss', syncedAt: new Date().toISOString(), styles: [{ id: 'ss-1', styleID: '1', colors: [] }] }));
  Object.assign(config.ss, { account: '123', apiKey: 'k', styles: ['Gildan 5000'] });
  assert.equal((await getCatalog()).source, 'ss');
  Object.assign(config.ss, { account: '', apiKey: '', styles: [] });
  assert.equal((await getCatalog()).source, 'demo');
  assert.equal((await getCatalog()).source, 'demo');
});
