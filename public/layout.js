// Placement rules and true-to-size math. Everything here is in inches until
// the final step converts to image pixels.

export const PRESETS = {
  'full-front': { label: 'Full front', view: 'front', defaultWidthIn: 11 },
  'center-chest': { label: 'Center chest', view: 'front', defaultWidthIn: 4 },
  'left-chest': { label: 'Left chest', view: 'front', defaultWidthIn: 3.5 },
  'full-back': { label: 'Full back', view: 'back', defaultWidthIn: 12 },
  'upper-back': { label: 'Upper back', view: 'back', defaultWidthIn: 10 },
};

// top: inches from the high point of the shoulder to the top of the print.
// x: inches from the center line to the center of the print (+ = viewer's right,
//    which is the wearer's left on a front view).
// maxBottomFrac: the print must end above this fraction of body length (hoodie pocket).
export const RULES = {
  tee: {
    'full-front': { top: 5.5, x: 0 },
    'center-chest': { top: 5.5, x: 0 },
    'left-chest': { top: 7, x: 4 },
    'full-back': { top: 4, x: 0 },
    'upper-back': { top: 2.5, x: 0 },
  },
  polo: {
    'full-front': { top: 8, x: 0 },
    'center-chest': { top: 8, x: 0 },
    'left-chest': { top: 7.5, x: 4.25 },
    'full-back': { top: 4, x: 0 },
    'upper-back': { top: 2.5, x: 0 },
  },
  tank: {
    'full-front': { top: 8, x: 0 },
    'center-chest': { top: 8, x: 0 },
    'left-chest': { top: 8.5, x: 3.5 },
    'full-back': { top: 6, x: 0 },
    'upper-back': { top: 5, x: 0 },
  },
  hoodie: {
    'full-front': { top: 5, x: 0, maxBottomFrac: 0.6 },
    'center-chest': { top: 5, x: 0, maxBottomFrac: 0.6 },
    'left-chest': { top: 6, x: 4.5 },
    'full-back': { top: 7, x: 0 },
    'upper-back': { top: 4.5, x: 0 },
  },
};

export const DEFAULT_PRESET = { tee: 'full-front', polo: 'left-chest', tank: 'full-front', hoodie: 'full-front' };

// The size most suppliers photograph, by garment type and fit.
export function defaultDepictedSize(style) {
  const t = `${style.title || ''} ${style.category || ''} ${style.name || ''}`.toLowerCase();
  if (/youth|kid|toddler|infant|girls|boys/.test(t)) return 'M';
  if (/women|ladies|womens|wmns/.test(t)) return 'M';
  return 'L';
}

export function garmentKind(style) {
  const t = `${style.title || ''} ${style.category || ''} ${style.name || ''}`.toLowerCase();
  if (/hood/.test(t)) return 'hoodie';
  if (/polo|sport shirt/.test(t)) return 'polo';
  if (/tank|sleeveless|singlet/.test(t)) return 'tank';
  return 'tee';
}

// Used only when a style has no size chart. Typical adult measurements.
export const TYPICAL_SPECS = {
  tee: { S: [18, 28], M: [20, 29], L: [22, 30], XL: [24, 31], '2XL': [26, 32], '3XL': [28, 33], '4XL': [30, 34], '5XL': [32, 35] },
  polo: { S: [19, 28], M: [21, 29], L: [23, 30], XL: [25, 31], '2XL': [27, 32], '3XL': [29, 33], '4XL': [31, 34] },
  tank: { S: [18, 27], M: [20, 28], L: [22, 29], XL: [24, 30], '2XL': [26, 31], '3XL': [28, 32] },
  hoodie: { S: [20, 26], M: [22, 27], L: [24, 28], XL: [26, 29], '2XL': [28, 30], '3XL': [30, 31], '4XL': [32, 32] },
};

export function sizeTable(style, kind) {
  if (Array.isArray(style.sizes) && style.sizes.length) return { sizes: style.sizes, typical: false };
  const t = TYPICAL_SPECS[kind] || TYPICAL_SPECS.tee;
  const names = style.sizeNames?.length ? style.sizeNames.filter((n) => t[n]) : Object.keys(t);
  return { sizes: names.map((name) => ({ name, widthIn: t[name][0], lengthIn: t[name][1] })), typical: true };
}

// Works out pixels-per-inch for the size in the photo, cross-checking width against length.
export function photoScale(geo, kind, depicted) {
  const ppiW = geo.bodyW / depicted.widthIn;
  if (kind === 'hoodie') {
    // A hood hides the shoulder line, so measure up from the hem instead.
    return { ppi: ppiW, method: 'width', hpsY: geo.bottomY - depicted.lengthIn * ppiW, agree: null };
  }
  const ppiL = (geo.bottomY - geo.topY) / depicted.lengthIn;
  const diff = Math.abs(ppiW - ppiL) / ppiL;
  if (diff <= 0.08) return { ppi: ppiW, method: 'width', hpsY: geo.topY, agree: true, diff };
  return { ppi: ppiL, method: 'length', hpsY: geo.topY, agree: false, diff };
}

const fmt = (n) => (Math.round(n * 100) / 100).toString();

export function computeLayout({ geo, kind, depicted, selected, preset, aspect, widthIn, heightIn, offset = { dxIn: 0, dyIn: 0 }, limits }) {
  const scale = photoScale(geo, kind, depicted);
  // Treat the photo as the selected size: same garment, different real inches.
  const factor = scale.method === 'length' ? depicted.lengthIn / selected.lengthIn : depicted.widthIn / selected.widthIn;
  const ppi = scale.ppi * factor;

  let w = widthIn;
  let h = heightIn;
  if (w != null) h = w * aspect;
  else w = h / aspect;

  const rule = (RULES[kind] || RULES.tee)[preset];
  const cxPx = geo.cx + (rule.x + offset.dxIn) * ppi;
  const topPx = scale.hpsY + (rule.top + offset.dyIn) * ppi;
  const rect = { x: cxPx - (w * ppi) / 2, y: topPx, w: w * ppi, h: h * ppi };

  const warnings = [];
  const notes = [];
  if (limits && (w > limits.maxPrintWidthIn + 1e-6 || h > limits.maxPrintHeightIn + 1e-6)) {
    warnings.push(`This print is ${fmt(w)}″ × ${fmt(h)}″, larger than your ${fmt(limits.maxPrintWidthIn)}″ × ${fmt(limits.maxPrintHeightIn)}″ print area.`);
  }
  if (w > selected.widthIn - 2) {
    warnings.push(`At ${fmt(w)}″ wide the print nearly spans a size ${selected.name} body (${fmt(selected.widthIn)}″ across).`);
  }
  if (rule.maxBottomFrac) {
    const limit = selected.lengthIn * rule.maxBottomFrac;
    const bottom = rule.top + offset.dyIn + h;
    if (bottom > limit + 1e-6) {
      warnings.push(`The print runs into the front pocket. Keep it under ${fmt(Math.max(0, limit - rule.top - offset.dyIn))}″ tall here.`);
    }
  }
  if (scale.method === 'length') {
    notes.push('The body width in this photo didn’t match the size chart, so sizing is based on body length instead.');
  }

  return {
    rect,
    ppi,
    hpsY: scale.hpsY,
    centerX: geo.cx,
    anchor: { x: geo.cx + rule.x * ppi, y: scale.hpsY + rule.top * ppi },
    sizeIn: { w, h },
    method: scale.method,
    warnings,
    notes,
  };
}
