// Operations on the open TradingView chart. Each function takes a connected Page (see cdp.js).
// Everything here runs inside the chart page and uses the page's own chart object
// (window.TradingViewApi) and the same alert service the page itself calls with the user's session.
import { CdpError } from './cdp.js';
import { crossings } from './analysis.js';

const CHART = `(() => {
  const api = window.TradingViewApi;
  if (!api) throw new Error('TradingView chart API is not ready');
  return api.activeChart();
})()`;

const ALERTS_URL = 'https://pricealerts.tradingview.com';

/** Basic state of the open chart. */
export function health(page) {
  return page.evaluate(`(() => {
    const chart = ${CHART};
    const bars = chart.chartModel().mainSeries().bars();
    return {
      symbol: chart.symbol(),
      resolution: chart.resolution(),
      layout: window.TradingViewApi.layoutName?.() ?? null,
      bars_loaded: bars.size(),
      visible_range: chart.getVisibleRange(),
    };
  })()`);
}

/** Last candle of the main series (open, high, low, close, volume, time). */
export function quote(page) {
  return page.evaluate(`(() => {
    const chart = ${CHART};
    const b = chart.chartModel().mainSeries().bars();
    const [time, open, high, low, close, volume] = b.last().value;
    return { symbol: chart.symbol(), resolution: chart.resolution(), time, open, high, low, close, volume };
  })()`);
}

/** The last N candles of the chart's current timeframe. Oldest first. */
export function candlesNow(page, count = 100) {
  const n = Math.max(1, Math.min(Number(count) || 100, 20000));
  return page.evaluate(`(() => {
    const chart = ${CHART};
    const b = chart.chartModel().mainSeries().bars();
    const last = b.lastIndex(), first = Math.max(b.firstIndex(), last - ${n} + 1);
    const out = [];
    for (let i = first; i <= last; i++) {
      const [time, open, high, low, close, volume] = b.valueAt(i);
      out.push({ time, open, high, low, close, volume });
    }
    return out;
  })()`);
}

/**
 * Load the chart's full history for the current timeframe (TradingView loads it lazily).
 * Scrolls to the first bar, waits until the bar count stops growing, then returns to the
 * latest bar and puts the zoom back. Returns the number of bars now loaded.
 */
export async function loadHistory(page) {
  const view = await page.evaluate(`${CHART}.getVisibleBarsRange()`);
  await page.evaluate(`${CHART}.chartModel().timeScale().scrollToFirstBar()`);
  let last = -1;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const size = await page.evaluate(`${CHART}.chartModel().mainSeries().bars().size()`);
    if (size === last && size > 300) break;
    last = size;
  }
  await page.evaluate(`${CHART}.chartModel().timeScale().scrollToRealtime()`);
  await new Promise((r) => setTimeout(r, 800));
  if (view) await setVisibleRange(page, view.from, view.to).catch(() => {});
  return page.evaluate(`${CHART}.chartModel().mainSeries().bars().size()`);
}

async function ensureBars(page, count) {
  const have = await page.evaluate(`${CHART}.chartModel().mainSeries().bars().size()`);
  if (count > have) await loadHistory(page);
}

/**
 * Last N candles. With `resolution`, switch the chart to that timeframe, read, and switch back,
 * so higher-timeframe history is available without leaving the chart on it.
 * Asking for more candles than are loaded loads the full history first.
 */
export async function candles(page, count = 100, resolution) {
  if (!resolution) {
    await ensureBars(page, count);
    return candlesNow(page, count);
  }
  const before = await page.evaluate(`${CHART}.resolution()`);
  if (sameResolution(String(resolution), before)) {
    await ensureBars(page, count);
    return candlesNow(page, count);
  }
  const view = await page.evaluate(`${CHART}.getVisibleBarsRange()`);
  try {
    await setTimeframe(page, resolution);
    await waitForBars(page, resolution);
    await ensureBars(page, count);
    return await candlesNow(page, count);
  } finally {
    await setTimeframe(page, before);
    await waitForBars(page, before).catch(() => {});
    if (view) await setVisibleRange(page, view.from, view.to).catch(() => {});
  }
}

/**
 * Save candles to a JSON file (so an agent never has to copy numbers by hand).
 * The file goes in dir (default: TV_DATA_DIR, else ./trading-crew-data) and name is sanitised.
 */
export async function saveCandles(page, { count = 5000, resolution, name, dir } = {}) {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { join, resolve } = await import('node:path');
  const rows = await candles(page, Math.min(Number(count) || 5000, 20000), resolution);
  const q = await quote(page);
  const label = String(resolution || q.resolution).replace(/[^A-Za-z0-9]/g, '');
  const safe = String(name || `${q.symbol.split(':').pop()}-${label}`).replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '');
  const folder = resolve(dir || process.env.TV_DATA_DIR || join(process.cwd(), 'trading-crew-data'));
  await mkdir(folder, { recursive: true });
  const file = join(folder, `${safe}.json`);
  await writeFile(file, JSON.stringify(rows));
  return { path: file, candles: rows.length, first_time: rows[0]?.time ?? null, last_time: rows.at(-1)?.time ?? null };
}

// The chart reports daily as "1D", weekly as "1W", monthly as "1M".
const sameResolution = (a, b) => a === b || `1${a}` === b || a === `1${b}`;

async function waitForBars(page, resolution) {
  for (let i = 0; i < 20; i++) {
    const ok = await page.evaluate(`(() => { const c = ${CHART}; const want = ${JSON.stringify(String(resolution))}; const have = c.resolution(); return (have === want || have === '1' + want || want === '1' + have) && c.chartModel().mainSeries().bars().size() > 0; })()`);
    if (ok) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new CdpError(`Chart did not finish loading ${resolution}`);
}

export function setTimeframe(page, resolution) {
  return page.evaluate(`(async () => {
    const chart = ${CHART};
    await new Promise((res) => chart.setResolution(${JSON.stringify(String(resolution))}, res));
    return chart.resolution();
  })()`);
}

/** Zoom the visible window to a time range (unix seconds), using the bars that are loaded. */
export function setVisibleRange(page, from, to) {
  return page.evaluate(`(() => {
    const chart = ${CHART};
    const b = chart.chartModel().mainSeries().bars();
    let a = null, z = null;
    for (let i = b.firstIndex(); i <= b.lastIndex(); i++) {
      const t = b.valueAt(i)[0];
      if (a === null && t >= ${Number(from)}) a = i;
      if (t <= ${Number(to)}) z = i;
    }
    if (a === null || z === null || z <= a) throw new Error('No loaded bars in that range');
    chart.chartModel().timeScale().zoomToBarsRange(a, z);
    return chart.getVisibleBarsRange();
  })()`);
}

// ---------- drawings ----------

export function listDrawings(page) {
  return page.evaluate(`(() => {
    const chart = ${CHART};
    return chart.getAllShapes().map((s) => ({ id: s.id, name: s.name }));
  })()`);
}

/** Straight line between two points: {time (unix s), price}. */
export function drawTrendLine(page, p1, p2, { color = '#ff1744', width = 2, extendRight = false } = {}) {
  return page.evaluate(`(async () => {
    const chart = ${CHART};
    const id = await chart.createMultipointShape(
      [{ time: ${Number(p1.time)}, price: ${Number(p1.price)} }, { time: ${Number(p2.time)}, price: ${Number(p2.price)} }],
      { shape: 'trend_line', lock: false,
        overrides: { linecolor: ${JSON.stringify(color)}, linewidth: ${Number(width)}, extendRight: ${!!extendRight} } }
    );
    return { id };
  })()`);
}

export function drawHorizontalLine(page, price, { color = '#ff1744', width = 1, time } = {}) {
  return page.evaluate(`(async () => {
    const chart = ${CHART};
    const t = ${time ? Number(time) : 'chart.chartModel().mainSeries().bars().last().value[0]'};
    const id = await chart.createShape({ time: t, price: ${Number(price)} },
      { shape: 'horizontal_line', lock: false,
        overrides: { linecolor: ${JSON.stringify(color)}, linewidth: ${Number(width)} } });
    return { id };
  })()`);
}

export function removeDrawing(page, id) {
  return page.evaluate(`(() => { ${CHART}.removeEntity(${JSON.stringify(id)}); return { removed: ${JSON.stringify(id)} }; })()`);
}

export function clearDrawings(page) {
  return page.evaluate(`(() => { const c = ${CHART}; const n = c.getAllShapes().length; c.removeAllShapes(); return { removed: n }; })()`);
}

/** Points and style of one drawing. */
export function getDrawing(page, id) {
  return page.evaluate(`(() => {
    const chart = ${CHART};
    const s = chart.getShapeById(${JSON.stringify(id)});
    const pr = s.getProperties();
    return { id: ${JSON.stringify(id)}, points: s.getPoints(), color: pr.linecolor ?? null, width: pr.linewidth ?? null, extendRight: pr.extendRight ?? null };
  })()`);
}

/**
 * Draw a connected chain of straight lines through the points (each line starts where the last ended).
 * side 'above' = red chain over swing highs, 'below' = green chain under swing lows.
 * Every segment is checked against the candles first; if any candle cuts a line, nothing is drawn
 * and the offending candles are returned, unless force is true.
 */
export async function drawChain(page, points, { side, color, width = 2, extendRight = true, force = false, tolerance = 0 }) {
  if (!Array.isArray(points) || points.length < 2) throw new CdpError('A chain needs at least two points.');
  const sorted = [...points].sort((a, b) => a.time - b.time);
  const cs = await candlesNow(page, 1000);
  const problems = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const bad = crossings(sorted[i], sorted[i + 1], cs, side, tolerance);
    if (bad.length) problems.push({ segment: i + 1, from: sorted[i], to: sorted[i + 1], candles_cut: bad.slice(0, 5), count: bad.length });
  }
  if (problems.length && !force) return { drawn: false, reason: 'A candle cuts through a line. Pick other pivots or pass force.', problems };
  const ids = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const last = i === sorted.length - 2;
    const r = await drawTrendLine(page, sorted[i], sorted[i + 1], { color, width, extendRight: last && extendRight });
    ids.push(r.id);
  }
  return { drawn: true, ids, problems };
}

/** Save a PNG of the whole TradingView window and return its path. */
export async function screenshot(page, dir) {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const folder = dir || join(tmpdir(), 'trading-crew-mcp');
  await mkdir(folder, { recursive: true });
  const r = await page.send('Page.captureScreenshot', { format: 'png' }, 30000);
  const file = join(folder, `chart-${new Date().toISOString().replace(/[:.]/g, '-')}.png`);
  await writeFile(file, Buffer.from(r.data, 'base64'));
  return { path: file };
}

// ---------- alerts ----------

async function alertsCall(page, path, body) {
  // The page's own alert client adds the user name and build time to write calls; do the same.
  const res = await page.evaluate(`(async () => {
    const url = new URL(${JSON.stringify(ALERTS_URL + '/' + path)});
    if (window.user?.username) url.searchParams.set('log_username', window.user.username);
    if (${body ? 'true' : 'false'} && window.BUILD_TIME) url.searchParams.set('build_time', window.BUILD_TIME);
    const r = await fetch(url.toString(), {
      method: ${body ? "'POST'" : "'GET'"}, credentials: 'include',
      ${body ? `body: ${JSON.stringify(JSON.stringify(body))},` : ''}
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  })()`);
  if (res.status !== 200 || !res.body) throw new CdpError(`Alert service ${path} returned HTTP ${res.status}`);
  if (res.body.s && res.body.s !== 'ok') throw new CdpError(`Alert service ${path}: ${JSON.stringify(res.body).slice(0, 300)}`);
  return res.body;
}

const slim = (a) => ({
  alert_id: a.alert_id,
  symbol: (() => { try { return JSON.parse(a.symbol.replace(/^=/, '')).symbol; } catch { return a.symbol; } })(),
  level: a.condition?.series?.find((s) => s.type === 'value')?.value ?? null,
  condition: a.condition?.type ?? null,
  active: a.active,
  message: a.message,
  created: a.create_time,
  last_fired: a.last_fire_time,
  expiration: a.expiration,
});

export async function listAlerts(page) {
  const body = await alertsCall(page, 'list_alerts');
  return (body.r || []).map(slim);
}

/**
 * Create a price alert and read it back. Throws if the stored level differs from the requested one.
 * direction: 'up' (fires when price rises through the level) or 'down'.
 * The level must be on the correct side of the live price, or it would fire at once; this is checked first.
 */
export async function createAlert(page, { level, direction, message, daysToExpire = 30 }) {
  const q = await quote(page);
  if (direction === 'up' && !(level > q.close)) throw new CdpError(`Level ${level} is not above price ${q.close}; an "up" alert would fire at once.`);
  if (direction === 'down' && !(level < q.close)) throw new CdpError(`Level ${level} is not below price ${q.close}; a "down" alert would fire at once.`);
  const expiry = new Date(Date.now() + daysToExpire * 864e5).toISOString();
  // Same shape the page's own "Create alert" dialog sends (captured from a real request).
  const symbol = '=' + JSON.stringify({ 'currency-id': 'USD', session: 'regular', symbol: q.symbol });
  const created = await alertsCall(page, 'create_alert', {
    payload: {
      conditions: [{
        type: 'cross', frequency: 'on_first_fire',
        series: [{ type: 'barset' }, { type: 'value', value: level }],
        resolution: '1',
      }],
      symbol, resolution: '1', message,
      sound_file: 'alert/fired', sound_duration: 0, popup: true, auto_deactivate: true,
      email: false, sms_over_email: false, mobile_push: true, web_hook: null, name: null,
      expiration_policy: { policy: 'fixed_date', time: expiry },
      active: true, ignore_warnings: true,
    },
  });
  const id = created.r?.alert_id ?? created.r?.[0]?.alert_id;
  const stored = (await listAlerts(page)).find((a) => a.alert_id === id);
  if (!stored) throw new CdpError('Alert was created but could not be read back.');
  if (stored.level !== level) {
    throw new CdpError(`Alert ${id} stored level ${stored.level} instead of ${level}. Delete it and retry.`);
  }
  return { ...stored, verified: true };
}

export async function deleteAlert(page, id) {
  await alertsCall(page, 'delete_alerts', { payload: { alert_ids: [Number(id)] } });
  const left = (await listAlerts(page)).some((a) => a.alert_id === Number(id));
  if (left) throw new CdpError(`Alert ${id} is still listed after deleting.`);
  return { deleted: Number(id) };
}

async function rawAlerts(page) {
  const body = await alertsCall(page, 'list_alerts');
  return body.r || [];
}

/** Alerts that have fired, newest first. */
export async function listFires(page, limit = 20) {
  const body = await alertsCall(page, 'list_fires', { payload: { limit: Math.max(1, Math.min(Number(limit) || 20, 200)) } });
  return (body.r || []).map((f) => ({
    fire_id: f.fire_id, alert_id: f.alert_id, fire_time: f.fire_time, bar_time: f.bar_time, message: f.message,
  }));
}

/**
 * Change an alert's message and/or level in place (keeps its id). Reads it back to confirm.
 * Changing the level needs `direction` so the wrong-side check can run.
 */
export async function modifyAlert(page, id, { level, direction, message }) {
  const cur = (await rawAlerts(page)).find((a) => a.alert_id === Number(id));
  if (!cur) throw new CdpError(`No alert with id ${id}`);
  const curCond = (cur.conditions?.[0] ?? cur.condition);
  const curLevel = curCond.series.find((s) => s.type === 'value').value;
  let newLevel = curLevel;
  if (level !== undefined && level !== curLevel) {
    const q = await quote(page);
    if (direction === 'up' && !(level > q.close)) throw new CdpError(`Level ${level} is not above price ${q.close}; it would fire at once.`);
    if (direction === 'down' && !(level < q.close)) throw new CdpError(`Level ${level} is not below price ${q.close}; it would fire at once.`);
    if (direction !== 'up' && direction !== 'down') throw new CdpError('Changing the level needs direction "up" or "down".');
    newLevel = level;
  }
  await alertsCall(page, 'modify_restart_alert', {
    payload: {
      alert_id: cur.alert_id,
      conditions: [{ ...curCond, series: curCond.series.map((s) => (s.type === 'value' ? { ...s, value: newLevel } : s)) }],
      symbol: cur.symbol, resolution: cur.resolution,
      message: message ?? cur.message,
      sound_file: cur.sound_file, sound_duration: cur.sound_duration ?? 0, popup: cur.popup ?? true,
      auto_deactivate: cur.auto_deactivate ?? true,
      email: cur.email ?? false, sms_over_email: cur.sms_over_email ?? false, mobile_push: cur.mobile_push ?? true,
      web_hook: cur.web_hook ?? null, name: cur.name ?? null,
      expiration_policy: cur.expiration_policy, active: true, ignore_warnings: true,
    },
  });
  const stored = (await listAlerts(page)).find((a) => a.alert_id === Number(id));
  if (!stored) throw new CdpError('Alert disappeared after the change.');
  if (stored.level !== newLevel) throw new CdpError(`Alert ${id} stored level ${stored.level} instead of ${newLevel}.`);
  if (message !== undefined && stored.message !== message) throw new CdpError(`Alert ${id} message was not updated.`);
  return { ...stored, verified: true };
}
