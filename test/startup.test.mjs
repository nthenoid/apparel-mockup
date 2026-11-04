// Styles saved by an older version are refreshed when the server starts.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config } from '../server/config.js';
import { startSyncSchedule, getCatalog } from '../server/catalog.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const ss = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (b) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(b)); };
  if (url.pathname.startsWith('/Images/')) { res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(PNG); }
  if (url.pathname === '/v2/styles/') return send([{ styleID: 39, partNumber: '00760', brandName: 'Gildan', styleName: '5000', title: 'Tee' }]);
  if (url.pathname === '/v2/products/') {
    return send([{ styleID: 39, sizeName: 'L', colorName: 'Black', color1: '#000000', colorFrontImage: 'Images/Color/39_Black_fm.jpg' }]);
  }
  if (url.pathname === '/v2/specs/') return send([]);
  res.writeHead(404); res.end();
});
await new Promise((r) => ss.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${ss.address().port}`;
const tmp = await mkdtemp(path.join(os.tmpdir(), 'mockup-start-'));
test.after(async () => { ss.close(); await rm(tmp, { recursive: true, force: true }); });

test('styles saved by an older version get fresh photos at startup', async () => {
  Object.assign(config, { dataDir: tmp });
  Object.assign(config.ss, { account: '1', apiKey: 'k', apiBase: `${base}/v2`, imageBase: base, requestGapMs: 0, photoGapMs: 0, styles: [] });
  // Synced an hour ago, so only the old format triggers the refresh.
  await writeFile(path.join(tmp, 'catalog.json'), JSON.stringify({
    source: 'ss', seeded: true, syncedAt: new Date(Date.now() - 3600_000).toISOString(),
    styles: [{ id: 'ss-39', styleID: '39', brand: 'Gildan', name: '5000', colors: [{ name: 'Black', front: '/img/ss/39_Black_fl.jpg' }] }],
  }));
  await startSyncSchedule();
  const black = (await getCatalog()).styles[0].colors[0];
  assert.equal(black.front, '/img/ss/39_Black_fm.jpg');
  assert.ok(black.src?.front, 'now in the new format');
});
