// Adding, searching, removing and refreshing styles, against a fake S&S server.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config } from '../server/config.js';
import { searchStyles, addStyle, removeStyle, listJobs, getCatalog, syncNow, getStatus } from '../server/catalog.js';

const STYLES = [
  { styleID: 39, partNumber: '00760', brandName: 'Gildan', styleName: '5000', title: 'Heavy Cotton T-Shirt', baseCategory: 'T-Shirts' },
  { styleID: 41, partNumber: '00761', brandName: 'Gildan', styleName: '5000B', title: 'Youth Heavy Cotton T-Shirt', baseCategory: 'T-Shirts' },
  { styleID: 77, partNumber: '01800', brandName: 'Gildan', styleName: '18500', title: 'Heavy Blend Hooded Sweatshirt', baseCategory: 'Fleece' },
  { styleID: 500, partNumber: '30010', brandName: 'BELLA + CANVAS', styleName: '3001', title: 'Unisex Jersey Tee', baseCategory: 'T-Shirts' },
  { styleID: 900, partNumber: '99000', brandName: 'Nophotos', styleName: 'X1', title: 'No images at all', baseCategory: 'T-Shirts' },
  { styleID: 901, partNumber: '99001', brandName: 'Blocked', styleName: 'B1', title: 'Photos refused', baseCategory: 'T-Shirts' },
  { styleID: 902, partNumber: '99002', brandName: 'Independent Trading Co.', styleName: 'IND4000', title: 'Heavyweight Hooded Sweatshirt', baseCategory: 'Fleece' },
];
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const hits = { products: 0, images: 0 };
let rejectKey = false;

function products(styleID) {
  if (styleID === '900') return [{ styleID: 900, sizeName: 'M', colorName: 'Black', colorFrontImage: '', colorOnModelFrontImage: 'Images/ModelColor/1_omf_fm.jpg' }];
  if (styleID === '902') {
    // Like real data can be: full URLs, spaces in names, a mislabeled photo type,
    // an empty first row, and a stray row from another style.
    return [
      { styleID: 902, sizeName: 'S', sizeOrder: '1', colorName: 'Black Camo', colorFrontImage: '' },
      { styleID: 902, sizeName: 'M', sizeOrder: '2', colorName: 'Black Camo', colorFrontImage: 'https://www.ssactivewear.com/Images/Color/odd type_f_fm.jpg' },
      { styleID: 7, sizeName: 'M', sizeOrder: '2', colorName: 'Wrong Style', colorFrontImage: 'Images/Color/7_f_fm.jpg' },
    ];
  }
  const colors = [['Black', '#000000'], ['White', '#ffffff'], ['Navy', '#1f2a44']];
  const sizes = [['S', '1'], ['M', '2'], ['L', '3']];
  return colors.flatMap(([c, hex]) => sizes.map(([s, o]) => ({
    styleID: Number(styleID), sizeName: s, sizeOrder: o, colorName: c, color1: hex,
    colorFrontImage: `Images/Color/${styleID}_${c}_fm.jpg`,
    colorBackImage: `Images/Color/${styleID}_${c}_bm.jpg`,
    colorSwatchImage: `Images/ColorSwatch/${styleID}_${c}.jpg`,
  })));
}

const ss = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (body) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (url.pathname.startsWith('/Images/')) {
    hits.images++;
    if (url.pathname.includes('/901_')) { res.writeHead(403); return res.end(); }
    res.writeHead(200, { 'Content-Type': url.pathname.includes('odd') ? 'application/octet-stream' : 'image/png' });
    return res.end(PNG);
  }
  if (rejectKey) { res.writeHead(401); return res.end(); }
  if (url.pathname === '/v2/styles/') return send(STYLES);
  if (url.pathname === '/v2/products/') { hits.products++; return send(url.searchParams.has('styleid') ? products(url.searchParams.get('styleid')) : []); }
  if (url.pathname === '/v2/specs/') {
    return send(['S', 'M', 'L'].flatMap((s, i) => [
      { sizeName: s, specName: 'Body Width', value: String(18 + 2 * i) },
      { sizeName: s, specName: 'Body Length', value: String(28 + i) },
    ]));
  }
  res.writeHead(404); res.end();
});
await new Promise((r) => ss.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${ss.address().port}`;

const tmp = await mkdtemp(path.join(os.tmpdir(), 'mockup-lib-'));
Object.assign(config, { dataDir: tmp });
Object.assign(config.ss, { account: '123', apiKey: 'key', apiBase: `${base}/v2`, imageBase: base, requestGapMs: 0, styles: ['Gildan 18500', 'Made Up 123'] });

test.after(async () => { ss.close(); await rm(tmp, { recursive: true, force: true }); });

const ids = async () => (await getCatalog()).styles.map((s) => s.styleID);

test('the first refresh loads the starting list from SS_STYLES once', async () => {
  await syncNow();
  assert.deepEqual(await ids(), ['77']);
  assert.deepEqual(getStatus().unmatched, ['Made Up 123']);
  const hoodie = (await getCatalog()).styles[0];
  assert.equal(hoodie.colors.length, 3);
  assert.deepEqual(hoodie.sizes.map((s) => s.name), ['S', 'M', 'L']);
});

test('search finds styles by brand and number, best match first', async () => {
  const r = await searchStyles('gildan 5000');
  assert.deepEqual(r.map((x) => `${x.brand} ${x.name}`), ['Gildan 5000', 'Gildan 5000B']);
  assert.equal(r[0].added, false);
  assert.equal((await searchStyles('bella canvas 3001'))[0].styleID, '500');
  assert.equal((await searchStyles('hooded'))[0].added, true, 'already-added styles are marked');
  assert.deepEqual(await searchStyles(' '), []);
});

test('adding a style downloads it once and keeps it', async () => {
  const job = await addStyle('39');
  assert.equal(job.state, 'adding');
  assert.equal(JSON.parse(JSON.stringify(job)).done, undefined, 'internal promise is not sent to the browser');
  assert.equal((await addStyle('39')).state, 'adding', 'clicking twice does not start a second download');
  await job.done;
  assert.deepEqual(listJobs(), []);
  assert.deepEqual(await ids(), ['77', '39'].sort((a, b) => (a === '77' ? 1 : -1)));
  const tee = (await getCatalog()).styles.find((s) => s.styleID === '39');
  assert.equal(tee.brand, 'Gildan');
  assert.equal(tee.colors.length, 3);
  assert.ok(tee.colors.every((c) => c.front && c.back && c.swatch));
  const files = await readdir(path.join(tmp, 'images', 'ss'));
  assert.ok(files.includes('39_Black_fl.jpg'), 'photos are saved on the server');
  const onDisk = JSON.parse(await readFile(path.join(tmp, 'catalog.json'), 'utf8'));
  assert.ok(onDisk.styles.some((s) => s.styleID === '39'), 'library survives a restart');
});

test('a style with no photos reports an error instead of adding an empty style', async () => {
  const job = await addStyle('900');
  await job.done;
  const [j] = listJobs();
  assert.equal(j.state, 'error');
  assert.match(j.error, /no flat front photos/);
  assert.ok(!(await ids()).includes('900'));
});

test('a style whose photos are refused says why', async () => {
  await (await addStyle('901')).done;
  const j = listJobs().find((x) => x.styleID === '901');
  assert.match(j.error, /answered 403/);
});

test('unusual but real photo data still works', async () => {
  await (await addStyle('902')).done;
  const ind = (await getCatalog()).styles.find((s) => s.styleID === '902');
  assert.ok(ind, listJobs().find((x) => x.styleID === '902')?.error);
  assert.deepEqual(ind.colors.map((c) => c.name), ['Black Camo'], 'rows from other styles are ignored');
  assert.match(ind.colors[0].front, /^\/img\/ss\/[A-Za-z0-9_.-]+$/, 'saved under a safe file name');
  await removeStyle('ss-902');
});

test('bad requests are refused politely', async () => {
  await assert.rejects(addStyle('12345'), /doesn’t list that style/);
  await assert.rejects(addStyle('../etc'), /Unknown style/);
  await assert.rejects(removeStyle('ss-abc'), /Unknown style/);
});

test('removed styles stay removed, even after the nightly refresh', async () => {
  await removeStyle('ss-77');
  assert.deepEqual(await ids(), ['39']);
  await syncNow();
  assert.deepEqual(await ids(), ['39'], 'SS_STYLES does not bring it back');
});

test('the nightly refresh re-downloads only the styles you have', async () => {
  hits.products = 0;
  await syncNow();
  assert.equal(hits.products, 1);
});

test('a rejected API key shows a clear message and keeps the library', async () => {
  rejectKey = true;
  try {
    await syncNow();
    assert.match(getStatus().lastError, /rejected the account number or API key/);
    assert.deepEqual(await ids(), ['39']);
  } finally {
    rejectKey = false;
  }
});

test('removing the last style goes back to the sample garments', async () => {
  await removeStyle('ss-39');
  assert.equal((await getCatalog()).source, 'demo');
});
