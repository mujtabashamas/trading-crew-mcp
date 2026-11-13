// Live smoke test against an open TradingView chart: read, draw and remove two lines, create and delete a far-away test alert.
// Usage: node scripts/smoke.mjs   (TradingView must be running with its debug port)
import { Page } from '../src/cdp.js';
import * as tv from '../src/tv.js';
const p = await Page.connect();
console.log('health', JSON.stringify(await tv.health(p)));
const q = await tv.quote(p); console.log('quote', JSON.stringify(q));
const c = await tv.candles(p, 3); console.log('candles', JSON.stringify(c));
const before = (await tv.listDrawings(p)).length;
const t = q.time;
const h = await tv.drawHorizontalLine(p, q.close + 40, { color: '#ff1744' });
const l = await tv.drawTrendLine(p, { time: t - 3600, price: q.close + 10 }, { time: t, price: q.close + 5 }, { color: '#00c853', extendRight: true });
console.log('drew', JSON.stringify([h, l]), 'drawings now', (await tv.listDrawings(p)).length, 'before', before);
await tv.removeDrawing(p, h.id); await tv.removeDrawing(p, l.id);
console.log('after remove', (await tv.listDrawings(p)).length);
// alert round trip, far from price, then delete
const a = await tv.createAlert(p, { level: Math.round(q.close - 300), direction: 'down', message: 'trading-crew-mcp TEST alert, will be deleted' });
console.log('alert', JSON.stringify(a));
console.log('delete', JSON.stringify(await tv.deleteAlert(p, a.alert_id)));
try { await tv.createAlert(p, { level: Math.round(q.close - 5), direction: 'up', message: 'x' }); } catch (e) { console.log('wrong-side guard ok:', e.message); }
console.log('alerts total', (await tv.listAlerts(p)).length);
p.close();
