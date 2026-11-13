// Runs async tasks one at a time, in the order they were submitted.
// The chart is a single shared thing: two tools switching timeframe or loading history at once
// leave it on the wrong timeframe, so every chart operation goes through one queue.
export function createQueue() {
  let tail = Promise.resolve();
  return function enqueue(task) {
    const result = tail.then(() => task());
    tail = result.then(() => {}, () => {}); // a failed task must not block the ones behind it
    return result;
  };
}
