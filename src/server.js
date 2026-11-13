#!/usr/bin/env node
// MCP server: read and annotate the chart open in a local TradingView Desktop app.
// Deliberately has no tools that click the UI, type, or run arbitrary page code,
// so it cannot reach the order panel.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Page } from './cdp.js';
import * as tv from './tv.js';
import { findPivots, suggestChain } from './analysis.js';
import { createQueue } from './queue.js';

let page = null;
async function getPage() {
  if (!page || page.ws.readyState !== 1) page = await Page.connect();
  return page;
}
function dropPage() {
  try { page?.close(); } catch { /* already closed */ }
  page = null;
}

const LIMITS = { default: 60000, save_candles: 180000, get_candles: 90000, find_pivots: 90000, suggest_chain: 90000 };

/**
 * Run one tool call: connect, run, return compact JSON text. Errors come back as tool errors, never crashes.
 * Every call has a time limit (per tool name), so a stuck chart gives the agent an error in under two minutes
 * instead of a silent hang. The connection is dropped (and closed) only when it is broken or a call was abandoned.
 */
const enqueue = createQueue();

/** Chart calls are serialised: the chart is one shared thing, and agents often fire several tool calls at once. */
function run(name, fn, args) {
  return enqueue(() => runOne(name, fn, args));
}

async function runOne(name, fn, args) {
  const limit = LIMITS[name] ?? LIMITS.default;
  let timer;
  try {
    const work = (async () => fn(await getPage(), args))();
    work.catch(() => {}); // an abandoned call must not become an unhandled rejection
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out after ${limit / 1000}s. TradingView may be busy; try again in a moment.`)), limit); });
    const result = await Promise.race([work, timeout]);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  } catch (e) {
    const msg = String(e.message || e);
    if (/^Timed out after/.test(msg) || /Connection closed|Cannot reach|connecting to the TradingView/.test(msg) || (page && page.ws.readyState !== 1)) dropPage();
    return { isError: true, content: [{ type: 'text', text: msg }] };
  } finally {
    clearTimeout(timer);
  }
}

/** Marks a tool body; server.tool below wraps it with run() using the tool's own name for its time limit. */
const tool = (fn) => Object.assign(async () => { throw new Error('tool not wrapped'); }, { fn });

const server = new McpServer({ name: 'trading-crew-mcp', version: '0.1.0' });
const register = server.tool.bind(server);
server.tool = (name, ...rest) => {
  const marked = rest.pop();
  return register(name, ...rest, (args) => run(name, marked.fn, args));
};
/** Candles as a compact table (fields once, then number rows): about 4x smaller than one object per candle. */
const table = (cs) => ({ fields: ['time', 'open', 'high', 'low', 'close', 'volume'], rows: cs.map((c) => [c.time, c.open, c.high, c.low, c.close, c.volume]) });
const point = z.object({ time: z.number().describe('Candle time, unix seconds'), price: z.number() });
const style = {
  color: z.string().optional().describe('Hex colour, e.g. #ff1744 red, #00c853 green'),
  width: z.number().int().min(1).max(6).optional(),
};

server.tool('chart_health', 'Symbol, timeframe, layout name and how many bars are loaded on the open chart.', {}, tool((p) => tv.health(p)));
server.tool('get_quote', 'Latest candle (open, high, low, close, volume, time) of the open chart.', {}, tool((p) => tv.quote(p)));
server.tool('get_candles', 'Last N candles (up to 500) as a compact table {fields, rows}, oldest first, with unix times. For more than 500, use save_candles. Pass resolution (e.g. 60, 240, D) to read another timeframe; the chart is switched and then restored.',
  { count: z.number().int().min(1).max(500).optional(), resolution: z.string().optional() },
  tool(async (p, a) => table(await tv.candles(p, a.count, a.resolution))));
server.tool('save_candles', 'Save up to 20000 candles of a timeframe to a JSON file and return its path, so analysis scripts can read exact data. Loads the full history if needed (M15 reaches back about 4 months).',
  { count: z.number().int().min(1).max(20000).optional(), resolution: z.string().optional(), name: z.string().optional() },
  tool((p, a) => tv.saveCandles(p, { count: a.count, resolution: a.resolution, name: a.name })));
server.tool('find_pivots', 'Swing highs and lows with exact candle times and prices, from the last N candles of a timeframe.',
  { count: z.number().int().min(10).max(1000).optional(), resolution: z.string().optional(), strength: z.number().int().min(1).max(10).optional() },
  tool(async (p, a) => findPivots(await tv.candles(p, a.count ?? 300, a.resolution), a.strength ?? 3)));
server.tool('suggest_chain',
  'Find a connected chain of swing points that no candle cuts through, on the chart\'s current timeframe. side "above" = falling chain over highs (red), "below" = rising chain under lows (green). Returns points to pass straight to draw_chain, with the same tolerance.',
  { side: z.enum(['above', 'below']), count: z.number().int().min(50).max(500).optional(), strength: z.number().int().min(2).max(10).optional(),
    tolerance: z.number().min(0).max(2).optional(), max_points: z.number().int().min(2).max(8).optional() },
  tool(async (p, a) => {
    const tolerance = a.tolerance ?? 0.2;
    const cs = await tv.candlesNow(p, a.count ?? 300);
    const r = suggestChain(cs, findPivots(cs, a.strength ?? 5), a.side, { tolerance, maxPoints: a.max_points ?? 5 });
    return { ...r, side: a.side, tolerance, note: r.points.length < 2 ? 'No clean chain found. Try a lower strength or a larger count.' : 'Pass points and tolerance to draw_chain.' };
  }));
server.tool('set_timeframe', 'Change the chart timeframe (1, 5, 15, 60, 240, D, W). Set it back afterwards.',
  { resolution: z.string() }, tool((p, a) => tv.setTimeframe(p, a.resolution)));
server.tool('set_visible_range', 'Scroll and zoom the chart to a time range (unix seconds).',
  { from: z.number(), to: z.number() }, tool((p, a) => tv.setVisibleRange(p, a.from, a.to)));

server.tool('list_drawings', 'Ids and names of all drawings on the chart.', {}, tool((p) => tv.listDrawings(p)));
server.tool('draw_trend_line', 'Draw a straight line between two points (exact candle time and price).',
  { p1: point, p2: point, ...style, extend_right: z.boolean().optional() },
  tool((p, a) => tv.drawTrendLine(p, a.p1, a.p2, { color: a.color, width: a.width, extendRight: a.extend_right })));
server.tool('draw_chain',
  'Draw a connected chain of straight lines through pivot points (each line starts where the last ended). side "above" = red chain over swing highs, "below" = green chain under swing lows. Refuses and reports the candles if any line would cut through a candle, unless force is true.',
  { points: z.array(point).min(2), side: z.enum(['above', 'below']), color: z.string().optional(), width: z.number().int().min(1).max(6).optional(),
    extend_right: z.boolean().optional(), force: z.boolean().optional(),
    tolerance: z.number().min(0).max(2).optional().describe('Points a candle may overshoot a line before it counts as cutting it (default 0)') },
  tool((p, a) => tv.drawChain(p, a.points, { tolerance: a.tolerance, side: a.side, color: a.color ?? (a.side === 'above' ? '#ff1744' : '#00c853'), width: a.width, extendRight: a.extend_right ?? true, force: a.force })));
server.tool('get_drawing', 'Points, colour and width of one drawing by id.', { id: z.string() }, tool((p, a) => tv.getDrawing(p, a.id)));
server.tool('draw_horizontal_line', 'Draw a horizontal line at a price.',
  { price: z.number(), ...style }, tool((p, a) => tv.drawHorizontalLine(p, a.price, { color: a.color, width: a.width })));
server.tool('remove_drawing', 'Remove one drawing by id.', { id: z.string() }, tool((p, a) => tv.removeDrawing(p, a.id)));
server.tool('clear_drawings', 'Remove all drawings from the chart.', {}, tool((p) => tv.clearDrawings(p)));

server.tool('list_alerts', 'All price alerts on the account: id, symbol, level, active, message, last fired.', {}, tool((p) => tv.listAlerts(p)));
server.tool('create_alert',
  'Create a price alert that fires when price crosses a level. Refuses a level on the wrong side of live price, and reads the alert back to confirm the stored level.',
  { level: z.number(), direction: z.enum(['up', 'down']), message: z.string(), days_to_expire: z.number().int().min(1).max(60).optional() },
  tool((p, a) => tv.createAlert(p, { level: a.level, direction: a.direction, message: a.message, daysToExpire: a.days_to_expire })));
server.tool('modify_alert', 'Change an alert\'s message and/or level in place (same id). Changing the level needs direction. Reads it back to confirm.',
  { alert_id: z.number().int(), level: z.number().optional(), direction: z.enum(['up', 'down']).optional(), message: z.string().optional() },
  tool((p, a) => tv.modifyAlert(p, a.alert_id, { level: a.level, direction: a.direction, message: a.message })));
server.tool('list_fires', 'Alerts that have fired, newest first, with fire time and message.', { limit: z.number().int().min(1).max(200).optional() }, tool((p, a) => tv.listFires(p, a.limit)));
server.tool('screenshot', 'Save a PNG of the TradingView window and return the file path.', { dir: z.string().optional() }, tool((p, a) => tv.screenshot(p, a.dir)));
server.tool('delete_alert', 'Delete one alert by id and confirm it is gone.', { alert_id: z.number().int() }, tool((p, a) => tv.deleteAlert(p, a.alert_id)));

await server.connect(new StdioServerTransport());
