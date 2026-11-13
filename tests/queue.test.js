import test from 'node:test';
import assert from 'node:assert/strict';
import { createQueue } from '../src/queue.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('tasks run one at a time, in submission order', async () => {
  const enqueue = createQueue();
  const log = [];
  let running = 0, maxRunning = 0;
  const task = (name, ms) => async () => {
    running++; maxRunning = Math.max(maxRunning, running);
    log.push(`start ${name}`); await sleep(ms); log.push(`end ${name}`); running--;
    return name;
  };
  const results = await Promise.all([enqueue(task('a', 30)), enqueue(task('b', 5)), enqueue(task('c', 1))]);
  assert.deepEqual(results, ['a', 'b', 'c']);
  assert.equal(maxRunning, 1);
  assert.deepEqual(log, ['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
});

test('a failing task does not block the queue', async () => {
  const enqueue = createQueue();
  const bad = enqueue(async () => { throw new Error('boom'); });
  const good = enqueue(async () => 'ok');
  await assert.rejects(bad, /boom/);
  assert.equal(await good, 'ok');
});

test('a task submitted later starts only after earlier ones finish', async () => {
  const enqueue = createQueue();
  let first = false;
  const p1 = enqueue(async () => { await sleep(20); first = true; });
  const p2 = enqueue(async () => first);
  await p1;
  assert.equal(await p2, true);
});
