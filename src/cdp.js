// Minimal Chrome DevTools Protocol client for a locally running TradingView Desktop.
// Talks to the debug port on localhost only.
import WebSocket from 'ws';

const HOST = process.env.TV_DEBUG_HOST || '127.0.0.1';
const PORT = Number(process.env.TV_DEBUG_PORT || 9222);

export class CdpError extends Error {}

/** List debuggable targets from the debug port. */
export async function listTargets() {
  let res;
  try {
    res = await fetch(`http://${HOST}:${PORT}/json`, { signal: AbortSignal.timeout(3000) });
  } catch (e) {
    throw new CdpError(
      `Cannot reach TradingView on ${HOST}:${PORT}. Start it with its debug port enabled (remote-debugging-port=${PORT}).`
    );
  }
  return res.json();
}

/** Pick the open chart page (a tradingview.com/chart/... tab). */
export async function findChartTarget(targetId) {
  const targets = (await listTargets()).filter((t) => t.type === 'page');
  if (targetId) {
    const t = targets.find((x) => x.id === targetId);
    if (!t) throw new CdpError(`No page with id ${targetId}`);
    return t;
  }
  const t = targets.find((x) => /tradingview\.com\/chart\//.test(x.url));
  if (!t) throw new CdpError('No TradingView chart tab is open.');
  return t;
}

/** One connection to one page. Call evaluate() to run JavaScript in the page. */
export class Page {
  constructor(ws, target) {
    this.ws = ws;
    this.target = target;
    this.nextId = 1;
    this.pending = new Map();
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      const p = msg.id && this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      msg.error ? p.reject(new CdpError(msg.error.message)) : p.resolve(msg.result);
    });
    ws.on('close', () => {
      for (const p of this.pending.values()) p.reject(new CdpError('Connection closed'));
      this.pending.clear();
    });
  }

  static async connect(targetId) {
    const target = await findChartTarget(targetId);
    const ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false });
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    return new Page(ws, target);
  }

  send(method, params = {}, timeoutMs = 15000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CdpError(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Run an expression in the page and return its JSON-serialisable value. */
  async evaluate(expression, timeoutMs) {
    const r = await this.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true },
      timeoutMs
    );
    if (r.exceptionDetails) {
      throw new CdpError(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    }
    return r.result.value;
  }

  close() {
    this.ws.close();
  }
}
