// Live self-test against the chart open in TradingView Desktop (debug port on).
// Reads, draws and removes lines, creates, edits and deletes a far-away test alert, takes a screenshot,
// and finally checks that your alert and drawing counts are what they were at the start.
// Usage: npm run selftest        Exit code 0 = everything passed.
import { Page } from '../src/cdp.js';
import * as tv from '../src/tv.js';
import { findPivots } from '../src/analysis.js';

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failed++;
};

const p = await Page.connect();
const startAlerts = (await tv.listAlerts(p)).length;
const startDrawings = (await tv.listDrawings(p)).length;
const startHealth = await tv.health(p);
const startRes = startHealth.resolution;
const created = { alerts: [], drawings: [] };

try {
  const h = await tv.health(p);
  check('chart_health', !!h.symbol && h.bars_loaded > 0, `${h.symbol} ${h.resolution} ${h.layout}`);

  const q = await tv.quote(p);
  check('get_quote', q.close > 0 && q.high >= q.low, `close ${q.close}`);

  const cs = await tv.candles(p, 50);
  check('get_candles (current timeframe)', cs.length === 50 && cs.every((c) => c.high >= c.low));

  const d = await tv.candles(p, 5, startRes === 'D' ? '60' : 'D');
  const after = (await tv.health(p)).resolution;
  check('get_candles (other timeframe, chart restored)', d.length === 5 && after === startRes, `back on ${after}`);

  const pv = findPivots(await tv.candles(p, 300), 3);
  check('find_pivots', pv.length > 0 && pv.every((x) => x.time && x.price), `${pv.length} pivots`);

  const t0 = q.time - 3600;
  const crossing = await tv.drawChain(p, [{ time: t0, price: q.close + 100 }, { time: q.time, price: q.close - 100 }], { side: 'above', color: '#ff1744' });
  check('draw_chain refuses a line that cuts candles', crossing.drawn === false && crossing.problems.length > 0);

  const clean = await tv.drawChain(p, [{ time: t0, price: q.close + 100 }, { time: q.time, price: q.close + 90 }], { side: 'above', color: '#ff1744' });
  created.drawings.push(...(clean.ids || []));
  check('draw_chain draws a clean line', clean.drawn === true && clean.ids.length === 1);

  const g = await tv.getDrawing(p, clean.ids[0]);
  check('get_drawing', g.points.length === 2 && g.color === '#ff1744', `width ${g.width}`);

  const hl = await tv.drawHorizontalLine(p, q.close + 120, { color: '#00c853' });
  created.drawings.push(hl.id);
  check('draw_horizontal_line', !!hl.id);

  const level = Math.round(q.close - 300);
  const a = await tv.createAlert(p, { level, direction: 'down', message: 'trading-crew-mcp selftest alert, deleted at the end' });
  created.alerts.push(a.alert_id);
  check('create_alert reads back the level', a.verified === true && a.level === level, `id ${a.alert_id}`);

  let refused = false;
  try { await tv.createAlert(p, { level: Math.round(q.close - 5), direction: 'up', message: 'x' }); } catch { refused = true; }
  check('create_alert refuses a wrong-side level', refused);

  const m = await tv.modifyAlert(p, a.alert_id, { level: level - 10, direction: 'down', message: 'trading-crew-mcp selftest edited' });
  check('modify_alert keeps the id and reads back', m.alert_id === a.alert_id && m.level === level - 10 && /edited/.test(m.message));

  let refusedMod = false;
  try { await tv.modifyAlert(p, a.alert_id, { level: Math.round(q.close + 20), direction: 'down' }); } catch { refusedMod = true; }
  check('modify_alert refuses a wrong-side level', refusedMod);

  const fires = await tv.listFires(p, 3);
  check('list_fires', Array.isArray(fires));

  const shot = await tv.screenshot(p);
  check('screenshot saves a PNG', /\.png$/.test(shot.path), shot.path);

  const range = await tv.setVisibleRange(p, q.time - 86400, q.time);
  check('set_visible_range', range.from > 0 && range.to >= range.from);
} catch (e) {
  check('unexpected error', false, e.message);
} finally {
  for (const id of created.alerts) await tv.deleteAlert(p, id).catch((e) => check(`cleanup alert ${id}`, false, e.message));
  for (const id of created.drawings) await tv.removeDrawing(p, id).catch(() => {});
  const endAlerts = (await tv.listAlerts(p)).length;
  const endDrawings = (await tv.listDrawings(p)).length;
  check('account left as found (alerts)', endAlerts === startAlerts, `${startAlerts} -> ${endAlerts}`);
  check('account left as found (drawings)', endDrawings === startDrawings, `${startDrawings} -> ${endDrawings}`);
  await tv.setVisibleRange(p, startHealth.visible_range.from, startHealth.visible_range.to).catch(() => {});
  p.close();
}

console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
