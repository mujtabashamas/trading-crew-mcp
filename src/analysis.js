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
