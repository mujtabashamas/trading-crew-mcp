// Pure chart maths, no TradingView needed (so it is easy to test).
// A candle is { time, open, high, low, close, volume }; a point is { time, price }.

/**
 * Swing highs and lows. A bar is a swing high if its high is strictly above the highs
 * of `strength` bars on each side (and likewise for lows). Returns oldest first.
 */
export function findPivots(candles, strength = 3) {
  const out = [];
  for (let i = strength; i < candles.length - strength; i++) {
    let isHigh = true, isLow = true;
    for (let k = 1; k <= strength; k++) {
      if (!(candles[i].high > candles[i - k].high && candles[i].high > candles[i + k].high)) isHigh = false;
      if (!(candles[i].low < candles[i - k].low && candles[i].low < candles[i + k].low)) isLow = false;
    }
    if (isHigh) out.push({ type: 'high', time: candles[i].time, price: candles[i].high });
    if (isLow) out.push({ type: 'low', time: candles[i].time, price: candles[i].low });
  }
  return out;
}

/** Price of the straight line a->b at a given time (extrapolates outside a..b). */
export function lineAt(a, b, time) {
  if (b.time === a.time) return a.price;
  return a.price + ((b.price - a.price) * (time - a.time)) / (b.time - a.time);
}

/**
 * Candles that the line a->b cuts through between its two points.
 * side 'above': the line should run over the highs (a down chain of highs), so a candle
 * whose high is above the line crosses it. side 'below': a candle whose low is under the line crosses it.
 * tolerance is in price units.
 */
export function crossings(a, b, candles, side, tolerance = 0) {
  const t1 = Math.min(a.time, b.time), t2 = Math.max(a.time, b.time);
  const bad = [];
  for (const c of candles) {
    if (c.time < t1 || c.time > t2) continue;
    const y = lineAt(a, b, c.time);
    if (side === 'above' && c.high > y + tolerance) bad.push({ time: c.time, line: round(y), candle_high: c.high });
    if (side === 'below' && c.low < y - tolerance) bad.push({ time: c.time, line: round(y), candle_low: c.low });
  }
  return bad;
}

const round = (x) => Math.round(x * 100) / 100;

/**
 * Suggest a connected chain of pivots that no candle cuts through (so draw_chain will accept it).
 * side 'above': a falling chain over swing highs; 'below': a rising chain under swing lows.
 * Start at the extreme pivot of the window (highest high / lowest low), then repeatedly jump to the
 * FARTHEST later pivot whose segment is clean, so the chain has as few lines as possible.
 * Returns { points, lines, skipped } where skipped counts pivots that could not be joined.
 */
export function suggestChain(candles, pivots, side, { tolerance = 0.2, maxPoints = 5 } = {}) {
  const want = side === 'above' ? 'high' : 'low';
  const ps = pivots.filter((p) => p.type === want).sort((a, b) => a.time - b.time);
  if (ps.length < 2) return { points: [], lines: 0, skipped: ps.length };
  const better = (a, b) => (side === 'above' ? a.price > b.price : a.price < b.price);
  let start = ps[0];
  for (const p of ps) if (better(p, start)) start = p;
  const points = [{ time: start.time, price: start.price }];
  let cur = start;
  while (points.length < maxPoints) {
    // later pivots that continue the direction (falling for 'above', rising for 'below')
    const next = ps.filter((p) => p.time > cur.time && (side === 'above' ? p.price < cur.price : p.price > cur.price));
    let pick = null;
    for (let i = next.length - 1; i >= 0; i--) {              // farthest first
      if (crossings({ time: cur.time, price: cur.price }, next[i], candles, side, tolerance).length === 0) { pick = next[i]; break; }
    }
    if (!pick) break;
    points.push({ time: pick.time, price: pick.price });
    cur = pick;
  }
  return { points, lines: Math.max(0, points.length - 1), skipped: ps.length - points.length };
}
