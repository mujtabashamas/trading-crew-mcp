#!/usr/bin/env node
// MCP server: read and annotate the chart open in a local TradingView Desktop app.
// Deliberately has no tools that click the UI, type, or run arbitrary page code,
// so it cannot reach the order panel.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Page } from './cdp.js';
import * as tv from './tv.js';
import { findPivots } from './analysis.js';

let page = null;
async function getPage() {
  if (!page || page.ws.readyState !== 1) page = await Page.connect();
  return page;
}

/** Wrap a tool: connect, run, return JSON text; report errors as tool errors, not crashes. */
const tool = (fn) => async (args) => {
  try {
    const result = await fn(await getPage(), args);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (e) {
    page = null; // reconnect next time
    return { isError: true, content: [{ type: 'text', text: String(e.message || e) }] };
  }
};

const server = new McpServer({ name: 'trading-crew-mcp', version: '0.1.0' });
const point = z.object({ time: z.number().describe('Candle time, unix seconds'), price: z.number() });
const style = {
  color: z.string().optional().describe('Hex colour, e.g. #ff1744 red, #00c853 green'),
  width: z.number().int().min(1).max(6).optional(),
};

server.tool('chart_health', 'Symbol, timeframe, layout name and how many bars are loaded on the open chart.', {}, tool((p) => tv.health(p)));
server.tool('get_quote', 'Latest candle (open, high, low, close, volume, time) of the open chart.', {}, tool((p) => tv.quote(p)));
server.tool('get_candles', 'Last N candles (up to 5000), oldest first, with unix times. Large counts load the full history first. Pass resolution (e.g. 60, 240, D) to read another timeframe; the chart is switched and then restored.',
  { count: z.number().int().min(1).max(5000).optional(), resolution: z.string().optional() },
  tool((p, a) => tv.candles(p, a.count, a.resolution)));
server.tool('save_candles', 'Save up to 20000 candles of a timeframe to a JSON file and return its path, so analysis scripts can read exact data. Loads the full history if needed (M15 reaches back about 4 months).',
  { count: z.number().int().min(1).max(20000).optional(), resolution: z.string().optional(), name: z.string().optional() },
  tool((p, a) => tv.saveCandles(p, { count: a.count, resolution: a.resolution, name: a.name })));
server.tool('find_pivots', 'Swing highs and lows with exact candle times and prices, from the last N candles of a timeframe.',
  { count: z.number().int().min(10).max(1000).optional(), resolution: z.string().optional(), strength: z.number().int().min(1).max(10).optional() },
  tool(async (p, a) => findPivots(await tv.candles(p, a.count ?? 300, a.resolution), a.strength ?? 3)));
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
    extend_right: z.boolean().optional(), force: z.boolean().optional() },
  tool((p, a) => tv.drawChain(p, a.points, { side: a.side, color: a.color ?? (a.side === 'above' ? '#ff1744' : '#00c853'), width: a.width, extendRight: a.extend_right ?? true, force: a.force })));
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
