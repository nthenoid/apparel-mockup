// Finds the garment in a flat product photo and measures it.
// Input: { data: Uint8ClampedArray RGBA, width, height } (an ImageData).
// Output is in pixels of the input image.

function cornerSample(d, w, h) {
  const size = Math.max(2, Math.round(Math.min(w, h) * 0.02));
  let r = 0, g = 0, b = 0, a = 0, n = 0;
  for (const [x0, y0] of [[0, 0], [w - size, 0], [0, h - size], [w - size, h - size]]) {
    for (let y = y0; y < y0 + size; y++) {
      for (let x = x0; x < x0 + size; x++) {
        const i = (y * w + x) * 4;
        r += d[i]; g += d[i + 1]; b += d[i + 2]; a += d[i + 3]; n++;
      }
    }
  }
  return { r: r / n, g: g / n, b: b / n, a: a / n };
}

function median(values) {
  if (!values.length) return 0;
  const s = [...values].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}

export function analyzeGarment(img, { threshold = 30 } = {}) {
  const { data: d, width: w, height: h } = img;
  const bg = cornerSample(d, w, h);
  const transparentBg = bg.a < 20;
  const mask = new Uint8Array(w * h);
  let minX = w, maxX = -1, minY = h, maxY = -1, count = 0;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const p = i * 4;
      let on;
      if (transparentBg) on = d[p + 3] > 60;
      else if (d[p + 3] < 60) on = false;
      else on = Math.max(Math.abs(d[p] - bg.r), Math.abs(d[p + 1] - bg.g), Math.abs(d[p + 2] - bg.b)) > threshold;
      if (on) {
        mask[i] = 1;
        count++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  const coverage = count / (w * h);
  if (count === 0 || coverage < 0.03 || coverage > 0.97) {
    return { ok: false, reason: 'Couldn’t separate the garment from the background.' };
  }

  const cx = Math.round((minX + maxX) / 2);
  const at = (x, y) => (x >= 0 && x < w && y >= 0 && y < h ? mask[y * w + x] : 0);

  // Width of the solid run through the center line on each row.
  // Small gaps (texture, seams) are bridged so they don't split the run.
  const gap = Math.max(2, Math.round(w * 0.004));
  const runW = new Float32Array(h);
  for (let y = minY; y <= maxY; y++) {
    if (!at(cx, y)) continue;
    let l = cx, r = cx;
    for (let x = cx - 1, miss = 0; x >= 0; x--) {
      if (at(x, y)) { l = x; miss = 0; } else if (++miss > gap) break;
    }
    for (let x = cx + 1, miss = 0; x < w; x++) {
      if (at(x, y)) { r = x; miss = 0; } else if (++miss > gap) break;
    }
    runW[y] = r - l + 1;
  }

  // Top of the garment near the center (high point of shoulder on tees).
  const band = Math.round((maxX - minX) * 0.2);
  let topY = minY;
  outer: for (let y = minY; y <= maxY; y++) {
    for (let x = cx - band; x <= cx + band; x++) if (at(x, y)) { topY = y; break outer; }
  }

  // Bottom hem at the center.
  let bottomY = maxY;
  for (let y = maxY; y >= minY; y--) {
    let hits = 0;
    for (let x = cx - 3; x <= cx + 3; x++) hits += at(x, y);
    if (hits >= 4) { bottomY = y; break; }
  }
  const len = bottomY - topY;
  if (len < h * 0.2) return { ok: false, reason: 'The garment looks too small in this photo to measure.' };

  // Armpit: where sleeves stop joining the body, the run narrows sharply.
  let armY = -1;
  let peak = 0;
  const confirm = Math.max(3, Math.round(len * 0.01));
  for (let y = Math.round(topY + len * 0.1); y < topY + len * 0.6; y++) {
    peak = Math.max(peak, runW[y]);
    const drop = (v) => v > 0.2 * peak && v < 0.85 * peak;
    if (peak > 0 && drop(runW[y])) {
      let held = true;
      for (let k = 1; k <= confirm; k++) if (!drop(runW[y + k])) { held = false; break; }
      if (held) { armY = y; break; }
    }
  }

  const [from, to] = armY > 0 ? [armY + len * 0.02, armY + len * 0.07] : [topY + len * 0.4, topY + len * 0.5];
  const samples = [];
  for (let y = Math.round(from); y <= Math.round(to); y++) if (runW[y] > 0) samples.push(runW[y]);
  const bodyW = median(samples);
  if (!bodyW) return { ok: false, reason: 'Couldn’t measure the body width in this photo.' };

  return { ok: true, width: w, height: h, cx, topY, bottomY, armY, bodyW, widthMethod: armY > 0 ? 'armpit' : 'mid-body', coverage };
}

// Geometry stored as fractions so it applies to any color image of the same style.
export function toFractions(g) {
  if (!g.ok) return g;
  return {
    ok: true,
    cx: g.cx / g.width,
    topY: g.topY / g.height,
    bottomY: g.bottomY / g.height,
    armY: g.armY > 0 ? g.armY / g.height : -1,
    bodyW: g.bodyW / g.width,
    widthMethod: g.widthMethod,
  };
}

export function fromFractions(f, width, height) {
  return {
    ok: true,
    cx: f.cx * width,
    topY: f.topY * height,
    bottomY: f.bottomY * height,
    armY: f.armY > 0 ? f.armY * height : -1,
    bodyW: f.bodyW * width,
    widthMethod: f.widthMethod,
  };
}
