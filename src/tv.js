// Operations on the open TradingView chart. Each function takes a connected Page (see cdp.js).
// Everything here runs inside the chart page and uses the page's own chart object
// (window.TradingViewApi) and the same alert service the page itself calls with the user's session.
import { CdpError } from './cdp.js';

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
export function candles(page, count = 100) {
  const n = Math.max(1, Math.min(Number(count) || 100, 1000));
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

export function setTimeframe(page, resolution) {
  return page.evaluate(`(async () => {
    const chart = ${CHART};
    await new Promise((res) => chart.setResolution(${JSON.stringify(String(resolution))}, res));
    return chart.resolution();
  })()`);
}

/** Zoom the visible window to a time range (unix seconds). */
export function setVisibleRange(page, from, to) {
  return page.evaluate(`(async () => {
    const chart = ${CHART};
    await chart.setVisibleRange({ from: ${Number(from)}, to: ${Number(to)} });
    return chart.getVisibleRange();
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
  direction: a.condition?.type ?? null,
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
