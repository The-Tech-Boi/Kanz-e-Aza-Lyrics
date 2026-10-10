const test = require('node:test');
const assert = require('node:assert/strict');
const { Timestamp } = require('firebase-admin/firestore');

const { deleteExpired, isExpired } = require('../scripts/delete_expired_submissions');

const now = new Date('2026-10-10T12:00:00Z');
const at = iso => Timestamp.fromDate(new Date(iso));
const old = at('2020-01-01T00:00:00Z');

test('rejected submissions expire 6 months after rejectedAt', () => {
  assert.equal(isExpired({ status: 'rejected', rejectedAt: at('2026-04-10T12:00:00Z') }, now), true);
  assert.equal(isExpired({ status: 'rejected', rejectedAt: at('2026-04-10T12:00:01Z') }, now), false);
  // Rejection, not creation, starts the clock.
  assert.equal(isExpired({ status: 'rejected', createdAt: old, rejectedAt: at('2026-09-01T00:00:00Z') }, now), false);
});

test('pending submissions expire 12 months after lastEdited, else createdAt', () => {
  assert.equal(isExpired({ status: 'pending', createdAt: old, lastEdited: at('2025-10-10T12:00:00Z') }, now), true);
  assert.equal(isExpired({ status: 'pending', createdAt: old, lastEdited: at('2025-10-11T00:00:00Z') }, now), false);
  assert.equal(isExpired({ status: 'pending', createdAt: at('2025-10-01T00:00:00Z') }, now), true);
  assert.equal(isExpired({ status: 'pending', createdAt: at('2026-01-01T00:00:00Z') }, now), false);
});

test('approved, published and undated submissions are never expired', () => {
  const dates = { createdAt: old, lastEdited: old, rejectedAt: old };
  assert.equal(isExpired({ status: 'approved', ...dates }, now), false);
  assert.equal(isExpired({ status: 'published', ...dates }, now), false);
  assert.equal(isExpired({ status: 'rejected', createdAt: old, lastEdited: old }, now), false);
  assert.equal(isExpired({ status: 'pending' }, now), false);
  assert.equal(isExpired({ status: 'pending', lastEdited: '2020-01-01', createdAt: old }, now), false);
});

function fakeDb(docs) {
  const calls = { deleted: [] };
  const query = {
    where: (...args) => { calls.where = args; return query; },
    select: () => query,
    get: async () => ({
      docs: Object.entries(docs).map(([id, data]) => ({
        data: () => data,
        updateTime: `read-${id}`,
        ref: { delete: async precondition => calls.deleted.push([id, precondition]) }
      }))
    })
  };
  return { db: { collection: () => query }, calls };
}

const docs = {
  oldRejected: { status: 'rejected', rejectedAt: old, body: 'lyric text', ownerUid: 'user-1' },
  oldPending: { status: 'pending', createdAt: old, body: 'lyric text', ownerUid: 'user-2' },
  recentPending: { status: 'pending', createdAt: old, lastEdited: at('2026-10-01T00:00:00Z') }
};

test('a dry run deletes nothing and logs only counts', async t => {
  const log = t.mock.method(console, 'log', () => {});
  const { db, calls } = fakeDb(docs);

  assert.equal(await deleteExpired({ now }, db), 2);

  assert.deepEqual(calls.where, ['status', 'in', ['rejected', 'pending']]);
  assert.deepEqual(calls.deleted, []);
  const output = log.mock.calls.flatMap(c => c.arguments).join('\n');
  for (const secret of ['lyric text', 'user-1', 'oldRejected']) {
    assert.ok(!output.includes(secret), `logged ${secret}`);
  }
  assert.match(output, /1 rejected, 1 inactive pending/);
});

test('delete removes only expired submissions, unless they changed since read', async t => {
  t.mock.method(console, 'log', () => {});
  const { db, calls } = fakeDb(docs);

  await deleteExpired({ dryRun: false, now }, db);

  assert.deepEqual(calls.deleted, [
    ['oldRejected', { lastUpdateTime: 'read-oldRejected' }],
    ['oldPending', { lastUpdateTime: 'read-oldPending' }]
  ]);
});
