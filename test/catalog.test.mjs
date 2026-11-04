import test from 'node:test';
import assert from 'node:assert/strict';
import { parseInches, specsToSizes } from '../server/catalog.js';

test('parses inch formats', () => {
  assert.equal(parseInches('22'), 22);
  assert.equal(parseInches('22.5"'), 22.5);
  assert.equal(parseInches('22 1/2'), 22.5);
  assert.equal(parseInches('22-1/4 in'), 22.25);
  assert.ok(Number.isNaN(parseInches('n/a')));
});

test('builds size rows from spec rows, ignoring sleeves', () => {
  const specs = [
    { sizeName: 'M', specName: 'Body Width', value: '20' },
    { sizeName: 'M', specName: 'Body Length', value: '29' },
    { sizeName: 'M', specName: 'Sleeve Length', value: '8 1/4' },
    { sizeName: 'S', specName: 'Body Width', value: '18' },
    { sizeName: 'S', specName: 'Body Length', value: '28' },
    { sizeName: 'XL', specName: 'Body Width', value: '24' },
  ];
  assert.deepEqual(specsToSizes(specs, ['S', 'M', 'L', 'XL']), [
    { name: 'S', widthIn: 18, lengthIn: 28 },
    { name: 'M', widthIn: 20, lengthIn: 29 },
  ]);
});

test('accepts one object per size', () => {
  const r = specsToSizes([{ sizeName: 'L', 'Body Width': '22', 'Body Length': '30', 'Sleeve Length': '9' }]);
  assert.deepEqual(r, [{ name: 'L', widthIn: 22, lengthIn: 30 }]);
});
