import test from 'node:test';
import assert from 'node:assert/strict';

test('reports a clear error when TradingView is not reachable', async () => {
  process.env.TV_DEBUG_PORT = '1'; // nothing listens here; must be set before the module loads
  const { listTargets, CdpError } = await import('../src/cdp.js');
  await assert.rejects(() => listTargets(), (e) => e instanceof CdpError && /Cannot reach TradingView/.test(e.message));
});
