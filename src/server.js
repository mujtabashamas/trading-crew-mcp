#!/usr/bin/env node
// MCP server: read and annotate the chart open in a local TradingView Desktop app.
// Deliberately has no tools that click the UI, type, or run arbitrary page code,
// so it cannot reach the order panel.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Page } from './cdp.js';
import * as tv from './tv.js';

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
server.tool('get_candles', 'Last N candles of the chart timeframe, oldest first, with unix times.',
  { count: z.number().int().min(1).max(1000).optional() }, tool((p, a) => tv.candles(p, a.count)));
server.tool('set_timeframe', 'Change the chart timeframe (1, 5, 15, 60, 240, D, W). Set it back afterwards.',
  { resolution: z.string() }, tool((p, a) => tv.setTimeframe(p, a.resolution)));
server.tool('set_visible_range', 'Scroll and zoom the chart to a time range (unix seconds).',
  { from: z.number(), to: z.number() }, tool((p, a) => tv.setVisibleRange(p, a.from, a.to)));

server.tool('list_drawings', 'Ids and names of all drawings on the chart.', {}, tool((p) => tv.listDrawings(p)));
server.tool('draw_trend_line', 'Draw a straight line between two points (exact candle time and price).',
  { p1: point, p2: point, ...style, extend_right: z.boolean().optional() },
  tool((p, a) => tv.drawTrendLine(p, a.p1, a.p2, { color: a.color, width: a.width, extendRight: a.extend_right })));
server.tool('draw_horizontal_line', 'Draw a horizontal line at a price.',
  { price: z.number(), ...style }, tool((p, a) => tv.drawHorizontalLine(p, a.price, { color: a.color, width: a.width })));
server.tool('remove_drawing', 'Remove one drawing by id.', { id: z.string() }, tool((p, a) => tv.removeDrawing(p, a.id)));
server.tool('clear_drawings', 'Remove all drawings from the chart.', {}, tool((p) => tv.clearDrawings(p)));

server.tool('list_alerts', 'All price alerts on the account: id, symbol, level, active, message, last fired.', {}, tool((p) => tv.listAlerts(p)));
server.tool('create_alert',
  'Create a price alert that fires when price crosses a level. Refuses a level on the wrong side of live price, and reads the alert back to confirm the stored level.',
  { level: z.number(), direction: z.enum(['up', 'down']), message: z.string(), days_to_expire: z.number().int().min(1).max(60).optional() },
  tool((p, a) => tv.createAlert(p, { level: a.level, direction: a.direction, message: a.message, daysToExpire: a.days_to_expire })));
server.tool('delete_alert', 'Delete one alert by id and confirm it is gone.', { alert_id: z.number().int() }, tool((p, a) => tv.deleteAlert(p, a.alert_id)));

await server.connect(new StdioServerTransport());
