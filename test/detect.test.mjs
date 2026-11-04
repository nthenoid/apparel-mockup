import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeGarment } from '../public/detect.js';
import { computeLayout, photoScale } from '../public/layout.js';

// Fill a polygon into an RGBA buffer (even-odd scanline), on a white background.
function raster(points, w, h, rgb) {
  const d = new Uint8ClampedArray(w * h * 4).fill(255);
  for (let y = 0; y < h; y++) {
    const xs = [];
    for (let i = 0; i < points.length; i++) {
      const [x1, y1] = points[i], [x2, y2] = points[(i + 1) % points.length];
      if ((y1 <= y && y2 > y) || (y2 <= y && y1 > y)) xs.push(x1 + ((y - y1) * (x2 - x1)) / (y2 - y1));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      for (let x = Math.ceil(xs[k]); x < xs[k + 1]; x++) {
        const p = (y * w + x) * 4;
        d[p] = rgb[0]; d[p + 1] = rgb[1]; d[p + 2] = rgb[2];
      }
    }
  }
  return { data: d, width: w, height: h };
}

// A tee at 20 px/in: 22" body width, 30" long, HPS at y=150.
const TEE = [[430,150],[500,200],[570,150],[700,185],[832,318],[778,378],[720,330],[718,500],[724,750],[276,750],[282,500],[280,330],[222,378],[168,318],[300,185]];
const L = { name: 'L', widthIn: 22, lengthIn: 30 };
const S = { name: 'S', widthIn: 18, lengthIn: 28 };
const tee = () => analyzeGarment(raster(TEE, 1000, 1000, [30, 30, 30]));

test('measures a tee body and finds the armpit', () => {
  const g = tee();
  assert.ok(g.ok);
  assert.equal(g.widthMethod, 'armpit');
  assert.ok(Math.abs(g.bodyW - 440) <= 4, `bodyW ${g.bodyW}`);
  assert.ok(Math.abs(g.topY - 150) <= 1);
  assert.ok(Math.abs(g.cx - 500) <= 1);
});

test('scale comes out at 20 px per inch for the depicted size', () => {
  const s = photoScale(tee(), 'tee', L);
  assert.equal(s.method, 'width');
  assert.ok(Math.abs(s.ppi - 20) < 0.25, `ppi ${s.ppi}`);
});

test('a 10 inch print is 10 inches of the garment, and bigger on a smaller size', () => {
  const base = { geo: tee(), kind: 'tee', depicted: L, preset: 'full-front', aspect: 0.5, widthIn: 10 };
  const onL = computeLayout({ ...base, selected: L });
  const onS = computeLayout({ ...base, selected: S });
  assert.ok(Math.abs(onL.rect.w - 200) < 3, `L width ${onL.rect.w}`);
  assert.ok(Math.abs(onS.rect.w / onL.rect.w - 22 / 18) < 0.01);
  assert.ok(Math.abs(onL.rect.y - (150 + 5.5 * 20)) < 4);
  assert.equal(onL.sizeIn.h, 5);
});

test('height input drives width through the artwork aspect ratio', () => {
  const g = tee();
  const r = computeLayout({ geo: g, kind: 'tee', depicted: L, selected: L, preset: 'left-chest', aspect: 2, heightIn: 4 });
  assert.equal(r.sizeIn.w, 2);
  assert.ok(r.rect.x + r.rect.w / 2 > g.cx, 'left chest sits on the viewer’s right');
});

test('warns about oversized prints and hoodie pockets', () => {
  const g = tee();
  const limits = { maxPrintWidthIn: 13, maxPrintHeightIn: 16 };
  const big = computeLayout({ geo: g, kind: 'tee', depicted: L, selected: S, preset: 'full-front', aspect: 1, widthIn: 17, limits });
  assert.equal(big.warnings.length, 2);
  const hood = { name: 'L', widthIn: 22, lengthIn: 28 };
  const pocket = computeLayout({ geo: g, kind: 'hoodie', depicted: hood, selected: hood, preset: 'full-front', aspect: 1, widthIn: 10, limits });
  assert.ok(pocket.warnings.some((w) => w.includes('pocket')));
});

test('falls back to body length when width disagrees with the size chart', () => {
  const s = photoScale(tee(), 'tee', { name: 'L', widthIn: 26, lengthIn: 30 });
  assert.equal(s.method, 'length');
});

test('reports failure on an empty photo', () => {
  const g = analyzeGarment({ data: new Uint8ClampedArray(100 * 100 * 4).fill(255), width: 100, height: 100 });
  assert.equal(g.ok, false);
});
