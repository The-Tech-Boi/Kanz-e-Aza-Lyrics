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

// The Catalog: each lyric's file.
const lyric = (remoteId, fields = {}) => ({
  remoteId,
  title: 'Ya Abbas',
  body: 'Pehli line',
  language: 'Roman Urdu',
  categories: ['Nohay'],
  anjumans: [],
  verified: false,
  ...fields
});
const catalog = (...records) => new Map(records.map(record => [record.remoteId, record]));

const plan = (submissions, lyrics, decisions = []) => planUpdate({ submissions, decisions, lyrics });

test('Verify on a published lyric changes only its flag, with nothing to mark', () => {
  // The Owner added the poet in the file since; that stays.
  const { writes, submissionIds } = plan(
    [approved('web-6', { isVerified: true })],
    catalog(lyric('web-6', { author: 'Mir Anees' }))
  );
  assert.deepEqual([...writes], [
    ['web-6', { record: lyric('web-6', { author: 'Mir Anees', verified: true }), kind: 'verified' }]
  ]);
  assert.deepEqual(submissionIds, []);
});

test('Unverify does too', () => {
  const { writes } = plan(
    [approved('web-6', { isVerified: false })],
    catalog(lyric('web-6', { verified: true }))
  );
  assert.deepEqual([...writes], [['web-6', { record: lyric('web-6'), kind: 'unverified' }]]);
});

test('a lyric whose flag matches is not written again', () => {
  assert.equal(plan(
    [approved('web-6', { isVerified: true })],
    catalog(lyric('web-6', { verified: true }))
  ).writes.size, 0);
});

test('only the version in the Catalog counts: an older or different text changes nothing', () => {
  // Verifying the original after a revision went out over it.
  assert.equal(plan(
    [
      approved('lyric-1', { title: 'Original', isVerified: true, approvedAt: at(1000) }),
      approved('rev-1', { title: 'Revised', revisionOfRemoteId: 'lyric-1', approvedAt: at(2000) })
    ],
    catalog(lyric('lyric-1', { title: 'Revised' }))
  ).writes.size, 0);

  // The newest approval's text isn't the file's (e.g. the Owner edited the
  // file since): no content change rides along.
  assert.equal(plan(
    [approved('lyric-1', { title: 'Original', isVerified: true })],
    catalog(lyric('lyric-1', { title: 'Edited by the Owner' }))
  ).writes.size, 0);
});

test('a lyric the Catalog doesn\'t have is not written for its flag', () => {
  assert.equal(plan([approved('web-6', { isVerified: true })], new Map()).writes.size, 0);
});

test('a Verify change on a withdrawn lyric is held', () => {
  const { writes, deletes } = plan(
    [approved('web-6', { isVerified: true })],
    catalog(lyric('web-6')),
    [{ id: 'web-6', data: { withdrawn: true, updatedAt: at(3000) } }]
  );
  assert.equal(writes.size, 0);
  assert.deepEqual([...deletes.keys()], ['web-6']);
});
