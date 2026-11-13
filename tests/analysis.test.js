import test from 'node:test';
import assert from 'node:assert/strict';
import { findPivots, lineAt, crossings } from '../src/analysis.js';

const c = (time, high, low) => ({ time, open: low, high, low, close: high, volume: 1 });

test('finds a swing high and a swing low', () => {
  const cs = [c(1, 5, 4), c(2, 6, 5), c(3, 9, 6), c(4, 7, 5), c(5, 6, 3), c(6, 7, 4), c(7, 8, 5)];
  const p = findPivots(cs, 2);
  assert.deepEqual(p.map((x) => [x.type, x.time, x.price]), [['high', 3, 9], ['low', 5, 3]]);
});

test('lineAt interpolates and extrapolates', () => {
  const a = { time: 0, price: 100 }, b = { time: 10, price: 90 };
  assert.equal(lineAt(a, b, 5), 95);
  assert.equal(lineAt(a, b, 20), 80);
});

test('a down line over highs is clean when no high pokes above it', () => {
  const a = { time: 0, price: 100 }, b = { time: 10, price: 90 };
  const cs = [c(0, 100, 95), c(5, 94, 90), c(10, 90, 85)];
  assert.deepEqual(crossings(a, b, cs, 'above'), []);
});

test('reports a candle whose high cuts the line', () => {
  const a = { time: 0, price: 100 }, b = { time: 10, price: 90 };
  const bad = crossings(a, b, [c(5, 97, 90)], 'above');
  assert.equal(bad.length, 1);
  assert.equal(bad[0].line, 95);
});

test('an up line under lows is cut by a candle whose low dips under it', () => {
  const a = { time: 0, price: 10 }, b = { time: 10, price: 20 };
  assert.equal(crossings(a, b, [c(5, 18, 14)], 'below').length, 1);
  assert.equal(crossings(a, b, [c(5, 18, 16)], 'below').length, 0);
});
