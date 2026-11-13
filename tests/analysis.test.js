import test from 'node:test';
import assert from 'node:assert/strict';
import { findPivots, lineAt, crossings, suggestChain } from '../src/analysis.js';

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

test('suggestChain builds a clean falling chain over highs and never cuts a candle', () => {
  // highs fall 100 -> 90 -> 80 with a lower swing high in between that sits under the straight line
  const cs = [];
  const shape = [100, 96, 92, 95, 91, 87, 90, 86, 80, 83, 79, 75, 78, 74, 70];
  shape.forEach((h, i) => cs.push({ time: i * 900, open: h - 2, high: h, low: h - 4, close: h - 1, volume: 1 }));
  const pv = findPivots(cs, 1);
  const r = suggestChain(cs, pv, 'above', { tolerance: 0, maxPoints: 5 });
  assert.ok(r.points.length >= 2);
  assert.equal(r.points[0].price, 95); // the edge bar (100) is not a pivot; the highest pivot is 95
  for (let i = 0; i < r.points.length - 1; i++) assert.deepEqual(crossings(r.points[i], r.points[i + 1], cs, 'above'), []);
  assert.ok(r.points.every((p, i) => i === 0 || p.time > r.points[i - 1].time && p.price < r.points[i - 1].price));
});

test('suggestChain builds a rising chain under lows', () => {
  const cs = [];
  const lows = [10, 14, 12, 16, 13, 18, 15, 20, 17, 22, 19, 24];
  lows.forEach((l, i) => cs.push({ time: i * 900, open: l + 2, high: l + 4, low: l, close: l + 3, volume: 1 }));
  const r = suggestChain(cs, findPivots(cs, 1), 'below', { tolerance: 0 });
  assert.ok(r.points.length >= 2);
  assert.equal(r.points[0].price, 12); // the edge bar (10) is not a pivot; the lowest pivot is 12
  for (let i = 0; i < r.points.length - 1; i++) assert.deepEqual(crossings(r.points[i], r.points[i + 1], cs, 'below'), []);
});

test('suggestChain returns nothing when there are too few pivots', () => {
  assert.deepEqual(suggestChain([], [], 'above'), { points: [], lines: 0, skipped: 0 });
});
