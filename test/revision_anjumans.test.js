// A Revision Submission may change a Published Lyric's title, body, Poet,
// Personality, Categories and Release Year, but not its Anjuman membership.
const test = require('node:test');
const assert = require('node:assert/strict');

const { planUpdate } = require('../scripts/sync_firestore_to_github');

const at = ms => ({ toMillis: () => ms });

const approved = (id, fields = {}) => ({
  id,
  data: {
    title: 'Ya Abbas',
    body: 'Pehli line',
    language: 'Roman Urdu',
    categories: ['Nohay'],
    anjumans: [],
    status: 'approved',
    published: false,
    isVerified: false,
    ownerUid: 'web-uid',
    approvedBy: 'admin-uid',
    approvedAt: at(2000),
    ...fields
  }
});

const lyric = (remoteId, anjumans) => ({
  remoteId,
  title: 'Ya Abbas',
  body: 'Pehli line',
  language: 'Roman Urdu',
  categories: ['Nohay'],
  anjumans,
  verified: false
});

const revisionOver = (anjumans, published) => planUpdate({
  submissions: [approved('rev-1', { title: 'Corrected', revisionOfRemoteId: 'lyric-1', anjumans })],
  decisions: [],
  lyrics: new Map([['lyric-1', lyric('lyric-1', published)]])
}).writes.get('lyric-1').record;

test('a revision keeps the Anjumans the Catalog has, whatever it sends', () => {
  assert.deepEqual(revisionOver(['Anjuman B'], ['Anjuman A']).anjumans, ['Anjuman A']);
  assert.deepEqual(revisionOver([], ['Anjuman A']).anjumans, ['Anjuman A']);
  assert.deepEqual(revisionOver(['Anjuman A'], []).anjumans, []);
  assert.equal(revisionOver(['Anjuman B'], ['Anjuman A']).title, 'Corrected');
});

test('a revision held while its lyric was withdrawn keeps the Anjumans of the last version', () => {
  const plan = planUpdate({
    submissions: [approved('rev-1', { title: 'Corrected', revisionOfRemoteId: 'lyric-1', anjumans: ['Anjuman B'] })],
    decisions: [{ id: 'lyric-1', data: { withdrawn: false, updatedAt: at(5000), updatedBy: 'owner-uid' } }],
    lyrics: new Map(),
    lastVersion: remoteId => (remoteId === 'lyric-1' ? lyric('lyric-1', ['Anjuman A']) : null)
  });

  assert.equal(plan.writes.get('lyric-1').kind, 'restore');
  assert.equal(plan.writes.get('lyric-1').record.title, 'Corrected');
  assert.deepEqual(plan.writes.get('lyric-1').record.anjumans, ['Anjuman A']);
});

test('a new lyric is published with the Anjumans it was sent with', () => {
  const plan = planUpdate({
    submissions: [approved('web-1', { anjumans: ['Anjuman A'] })],
    decisions: [],
    lyrics: new Map([['lyric-1', lyric('lyric-1', ['Anjuman A'])]])
  });
  assert.deepEqual(plan.writes.get('web-1').record.anjumans, ['Anjuman A']);
});
