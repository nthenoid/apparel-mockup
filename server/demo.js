// Sample garments so the tool works before S&S is connected.
// Drawn at 20 px per inch for the size each style "shows" (L), so the
// automatic sizing can be checked against known numbers.

const GARMENTS = {
  tee: {
    front:
      'M430,150 Q465,215 500,216 Q535,215 570,150 L700,185 L832,318 L778,378 L720,330 L718,500 L724,750 Q500,756 276,750 L282,500 L280,330 L222,378 L168,318 L300,185 Z',
    back: 'M430,150 Q500,172 570,150 L700,185 L832,318 L778,378 L720,330 L718,500 L724,750 Q500,756 276,750 L282,500 L280,330 L222,378 L168,318 L300,185 Z',
    inner: { front: 'M430,150 Q500,170 570,150 Q535,215 500,216 Q465,215 430,150 Z' },
    collar: { front: 'M430,150 Q465,215 500,216 Q535,215 570,150', back: 'M430,150 Q500,172 570,150' },
    folds: ['M300,345 Q330,420 305,520', 'M700,345 Q672,430 695,520', 'M420,700 Q500,690 590,705'],
  },
  hoodie: {
    front:
      'M420,200 Q420,95 500,88 Q580,95 580,200 L710,235 L852,380 L796,442 L738,380 L738,700 L734,760 Q500,766 266,760 L262,700 L262,380 L204,442 L148,380 L290,235 Z',
    back: 'M420,200 Q420,95 500,88 Q580,95 580,200 L710,235 L852,380 L796,442 L738,380 L738,700 L734,760 Q500,766 266,760 L262,700 L262,380 L204,442 L148,380 L290,235 Z',
    inner: { front: 'M440,205 Q440,120 500,114 Q560,120 560,205 Q530,250 500,252 Q470,250 440,205 Z' },
    collar: { front: 'M440,205 Q470,250 500,252 Q530,250 560,205', back: 'M420,200 Q500,330 580,200' },
    extra: {
      front: [
        { d: 'M470,250 L468,380', stroke: true },
        { d: 'M530,250 L532,380', stroke: true },
        { d: 'M352,520 L648,520 L690,690 L310,690 Z', stroke: true },
        { d: 'M266,712 L734,712', stroke: true },
      ],
      back: [{ d: 'M266,712 L734,712', stroke: true }],
    },
    folds: ['M290,400 Q320,470 300,560', 'M710,400 Q682,470 702,560'],
  },
  tank: {
    front: 'M360,150 L400,150 Q500,262 600,150 L640,150 Q656,300 720,340 L722,730 Q500,736 278,730 L280,340 Q344,300 360,150 Z',
    back: 'M360,150 L400,150 Q500,200 600,150 L640,150 Q656,300 720,340 L722,730 Q500,736 278,730 L280,340 Q344,300 360,150 Z',
    inner: {},
    collar: { front: 'M400,150 Q500,262 600,150', back: 'M400,150 Q500,200 600,150' },
    folds: ['M300,380 Q326,460 304,560', 'M700,380 Q674,460 696,560'],
  },
};

function shade(hex, amount) {
  const n = parseInt(hex, 16);
  const ch = (s) => Math.max(0, Math.min(255, Math.round(((n >> s) & 255) * (1 + amount))));
  return `rgb(${ch(16)},${ch(8)},${ch(0)})`;
}

export function demoSvg(kind, view, hex) {
  const g = GARMENTS[kind];
  if (!g || !['front', 'back'].includes(view) || !/^[0-9a-f]{6}$/i.test(hex)) return null;
  const base = `#${hex}`;
  const dark = shade(hex, -0.22);
  const extras = (g.extra?.[view] || [])
    .map((e) => `<path d="${e.d}" fill="none" stroke="${dark}" stroke-width="5" stroke-linecap="round"/>`)
    .join('');
  const inner = g.inner?.[view] ? `<path d="${g.inner[view]}" fill="${shade(hex, -0.35)}"/>` : '';
  const folds = g.folds.map((d) => `<path d="${d}" fill="none" stroke="#000" stroke-opacity=".07" stroke-width="22" stroke-linecap="round"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1000" viewBox="0 0 1000 1000">
<defs>
<linearGradient id="s" x1="0" x2="1"><stop offset="0" stop-color="#000" stop-opacity=".13"/><stop offset=".22" stop-color="#000" stop-opacity="0"/><stop offset=".5" stop-color="#fff" stop-opacity=".05"/><stop offset=".78" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".13"/></linearGradient>
<clipPath id="c"><path d="${g[view]}"/></clipPath>
</defs>
<rect width="1000" height="1000" fill="#fff"/>
<path d="${g[view]}" fill="${base}"/>
<g clip-path="url(#c)"><rect width="1000" height="1000" fill="url(#s)"/>${folds}</g>
${inner}
<path d="${g.collar[view]}" fill="none" stroke="${dark}" stroke-width="10" stroke-linecap="round"/>
${extras}
</svg>`;
}

const sizes = (names, widths, lengths) => names.map((name, i) => ({ name, widthIn: widths[i], lengthIn: lengths[i] }));

const COLORS = [
  ['Black', '1d1d1f'],
  ['White', 'ffffff'],
  ['Navy', '1f2a44'],
  ['Red', 'b3202a'],
  ['Heather Gray', 'a7a9ac'],
  ['Royal', '2a52be'],
  ['Forest', '2f4f3a'],
  ['Gold', 'f2b134'],
];

function colorsFor(kind) {
  return COLORS.map(([name, hex]) => ({
    name,
    hex: `#${hex}`,
    front: `/demo/${kind}-front-${hex}.svg`,
    back: `/demo/${kind}-back-${hex}.svg`,
  }));
}

export function demoCatalog() {
  return [
    {
      id: 'demo-tee',
      brand: 'Sample',
      name: 'Tee',
      title: 'Sample crew neck tee',
      category: 'T-Shirts',
      depictedSize: 'L',
      sizes: sizes(['S', 'M', 'L', 'XL', '2XL', '3XL'], [18, 20, 22, 24, 26, 28], [28, 29, 30, 31, 32, 33]),
      colors: colorsFor('tee'),
    },
    {
      id: 'demo-hoodie',
      brand: 'Sample',
      name: 'Hoodie',
      title: 'Sample pullover hooded sweatshirt',
      category: 'Fleece',
      depictedSize: 'L',
      sizes: sizes(['S', 'M', 'L', 'XL', '2XL', '3XL'], [20, 22, 24, 26, 28, 30], [26, 27, 28, 29, 30, 31]),
      colors: colorsFor('hoodie'),
    },
    {
      id: 'demo-tank',
      brand: 'Sample',
      name: 'Tank',
      title: 'Sample tank top',
      category: 'Tank Tops',
      depictedSize: 'L',
      sizes: sizes(['S', 'M', 'L', 'XL', '2XL'], [18, 20, 22, 24, 26], [27, 28, 29, 30, 31]),
      colors: colorsFor('tank'),
    },
  ];
}
