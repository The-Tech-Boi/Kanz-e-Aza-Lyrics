const test = require('node:test');
const assert = require('node:assert/strict');

const { DEBOUNCE_MS, RETRY_MS, watchdog } = require('../scripts/admin_edit_watchdog');

// A listener snapshot of approved, unpublished submissions.
const snapshot = (...docs) => ({ docs: docs.map(([id, data]) => ({ id, data: () => data })) });
const adminEdit = id => [id, { ownerUid: 'admin-1', approvedBy: 'admin-1' }];
const suggestion = id => [id, { ownerUid: 'reader-1', approvedBy: 'admin-1' }];

// A watchdog on a fake clock: nothing waits until `elapse` ends the oldest wait.
function setup(start = async () => {}) {
  const waits = [];
  const errors = [];
  let runs = 0;
  const onSnapshot = watchdog({
    start: () => { runs++; return start(); },
    wait: ms => new Promise(resolve => waits.push({ ms, resolve })),
    log: { log() {}, warn() {}, error: message => errors.push(message) }
  });
  const elapse = async () => {
    const { ms, resolve } = waits.shift();
    resolve();
    await new Promise(r => setImmediate(r));
    return ms;
  };
  return { onSnapshot, waits, errors, elapse, runs: () => runs };
}

test('edits approved within the minute start one run', async () => {
  const w = setup();
  w.onSnapshot(snapshot(adminEdit('a')));
  w.onSnapshot(snapshot(adminEdit('a'), adminEdit('b')));
  w.onSnapshot(snapshot(adminEdit('a'), adminEdit('b'), adminEdit('c')));
  assert.equal(w.waits.length, 1);
  assert.equal(w.runs(), 0);
  assert.equal(await w.elapse(), DEBOUNCE_MS);
  assert.equal(w.runs(), 1);
  assert.equal(w.waits.length, 0);
});

test('each submission gets one run, even when it stays unpublished', async () => {
  const w = setup();
  w.onSnapshot(snapshot(adminEdit('a')));
  await w.elapse();
  // The run failed to publish it: no second run for it.
  w.onSnapshot(snapshot(adminEdit('a')));
  assert.equal(w.waits.length, 0);
  // A new one gets its own run.
  w.onSnapshot(snapshot(adminEdit('a'), adminEdit('b')));
  await w.elapse();
  assert.equal(w.runs(), 2);
});

test('on start-up, edits already waiting get one run', async () => {
  const w = setup();
  w.onSnapshot(snapshot(adminEdit('a'), adminEdit('b'), suggestion('c')));
  await w.elapse();
  assert.equal(w.runs(), 1);
});

test('a reader suggestion alone starts no run', () => {
  const w = setup();
  w.onSnapshot(snapshot(suggestion('a'), suggestion('b')));
  assert.equal(w.waits.length, 0);
});

test('an edit published during the minute starts no run', async () => {
  const w = setup();
  w.onSnapshot(snapshot(adminEdit('a')));
  w.onSnapshot(snapshot());
  await w.elapse();
  assert.equal(w.runs(), 0);
});

test('a failed start is retried with backoff, then left to the 6-hour batch', async () => {
  const w = setup(async () => { throw new Error('GitHub answered 503'); });
  w.onSnapshot(snapshot(adminEdit('a')));
  await w.elapse();
  const waited = [];
  while (w.waits.length) waited.push(await w.elapse());
  assert.deepEqual(waited, RETRY_MS);
  assert.equal(w.runs(), RETRY_MS.length + 1);
  assert.match(w.errors[0], /6-hour batch publishes 1 Admin edits/);
  w.onSnapshot(snapshot(adminEdit('a')));
  assert.equal(w.waits.length, 0);
});

test('a start that fails once succeeds on retry', async () => {
  let fails = 1;
  const w = setup(async () => { if (fails-- > 0) throw new Error('network'); });
  w.onSnapshot(snapshot(adminEdit('a')));
  await w.elapse();
  await w.elapse();
  assert.equal(w.runs(), 2);
  assert.equal(w.waits.length, 0);
  assert.deepEqual(w.errors, []);
});
