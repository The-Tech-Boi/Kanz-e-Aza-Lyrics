const test = require('node:test');
const assert = require('node:assert/strict');

const { planUpdate } = require('../scripts/sync_firestore_to_github');

const at = ms => ({ toMillis: () => ms });

const approved = (id, fields = {}) => ({
  id,
  data: {
    title: 'Ya Abbas',
    body: 'Pehli line',
    categories: ['Nohay'],
    status: 'approved',
    published: true,
    isVerified: false,
    approvedAt: at(1000),
    ...fields
  }
});

// What readers have: the item last published for each lyric.
const live = (...items) => new Map(items.map(item => [item.remoteId, { item, removed: false }]));

const plan = (submissions, published, decisions = []) =>
  planUpdate({ submissions, decisions, published });

test('Verify on a published lyric republishes it, with nothing to mark', () => {
  const { items, submissionIds } = plan(
    [approved('web-6', { isVerified: true })],
    live({ remoteId: 'web-6', title: 'Ya Abbas', body: 'Pehli line', isVerified: false })
  );
  assert.deepEqual(items.map(i => [i.remoteId, i.isVerified]), [['web-6', true]]);
  assert.deepEqual(submissionIds, []);
});

test('Unverify does too, and an item published without the flag counts as unverified', () => {
  assert.deepEqual(plan(
    [approved('web-6', { isVerified: false })],
    live({ remoteId: 'web-6', title: 'Ya Abbas', body: 'Pehli line', isVerified: true })
  ).items.map(i => [i.remoteId, i.isVerified]), [['web-6', false]]);

  assert.deepEqual(plan(
    [approved('old-1')],
    live({ remoteId: 'old-1', title: 'Ya Abbas', body: 'Pehli line' })
  ).items, []);
  assert.deepEqual(plan(
    [approved('old-1', { isVerified: true })],
    live({ remoteId: 'old-1', title: 'Ya Abbas', body: 'Pehli line' })
  ).items.map(i => i.remoteId), ['old-1']);
});

test('a published lyric whose flag matches is not sent again', () => {
  assert.deepEqual(plan(
    [approved('web-6', { isVerified: true })],
    live({ remoteId: 'web-6', title: 'Ya Abbas', body: 'Pehli line', isVerified: true })
  ).items, []);
});

test('only the version readers have counts: an older or different text changes nothing', () => {
  // Verifying the original after a revision went out over it.
  assert.deepEqual(plan(
    [
      approved('lyric-1', { title: 'Original', isVerified: true, approvedAt: at(1000) }),
      approved('rev-1', { title: 'Revised', revisionOfRemoteId: 'lyric-1', approvedAt: at(2000) })
    ],
    live({ remoteId: 'lyric-1', title: 'Revised', body: 'Pehli line', isVerified: false })
  ).items, []);

  // The newest approval's text isn't what was published (e.g. the newer
  // revision readers have was rejected later): no content change rides along.
  assert.deepEqual(plan(
    [approved('lyric-1', { title: 'Original', isVerified: true })],
    live({ remoteId: 'lyric-1', title: 'Rejected later', body: 'Pehli line', isVerified: false })
  ).items, []);
});

test('a lyric readers don\'t have is not republished for its flag', () => {
  assert.deepEqual(plan([approved('web-6', { isVerified: true })], new Map()).items, []);
  assert.deepEqual(plan(
    [approved('web-6', { isVerified: true })],
    new Map([['web-6', { item: { remoteId: 'web-6', title: 'Ya Abbas', body: 'Pehli line' }, removed: true }]])
  ).items, []);
});

test('a Verify change on a withdrawn lyric is held', () => {
  assert.deepEqual(plan(
    [approved('web-6', { isVerified: true })],
    live({ remoteId: 'web-6', title: 'Ya Abbas', body: 'Pehli line', isVerified: false }),
    [{ id: 'web-6', data: { withdrawn: true, updatedAt: at(3000) } }]
  ).items, []);
});
