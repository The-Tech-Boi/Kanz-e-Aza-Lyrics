// Contributors choose a Personality from the Owner's approved list and
// Anjumans from those the Catalog has; the sync publishes only those names.
const test = require('node:test');
const assert = require('node:assert/strict');

const { planUpdate } = require('../scripts/sync_firestore_to_github');
const { catalogRepo, fakeDb, workflowRun } = require('./catalog_repo');

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

const lyric = (remoteId, fields = {}) => ({
  remoteId,
  title: 'In the Catalog',
  body: 'Pehli line',
  language: 'Roman Urdu',
  categories: ['Nohay'],
  anjumans: [],
  verified: false,
  ...fields
});

const catalogLyrics = new Map([
  ['lyric-1', lyric('lyric-1', { subcategory: 'Shaheed-e-Salis', anjumans: ['Anjuman-e-Abbasia'] })]
]);

const run = (fields, options = {}) => planUpdate({
  submissions: [approved('web-1', fields)],
  decisions: [],
  lyrics: catalogLyrics,
  ...options
});

test('a built-in Personality, one the Catalog has, or one on the Owner\'s list is published', () => {
  for (const [subcategory, personalities] of [
    ['Hazrat Abbas (a.s)', undefined],
    ['Shaheed-e-Salis', undefined],
    ['Alam', ['Hazrat Abbas (a.s)', 'Alam']]
  ]) {
    const plan = run({ subcategory }, { personalities });
    assert.deepEqual(plan.held, [], subcategory);
    assert.equal(plan.writes.get('web-1').record.subcategory, subcategory);
  }
});

test('a Personality on neither the approved list nor in the Catalog is held', () => {
  const plan = run({ subcategory: 'Invented Personality' });
  assert.deepEqual(plan.writes, new Map());
  assert.deepEqual(plan.submissionIds, []);
  assert.deepEqual(plan.held.map(({ remoteId, problem }) => [remoteId, problem]), [
    ['web-1', 'the Personality "Invented Personality" is not on the approved list']
  ]);
});

test('once the Owner saves a list, a built-in Personality left off it is held', () => {
  const plan = run({ subcategory: 'Ali Akbar (a.s)' }, { personalities: ['Hazrat Abbas (a.s)'] });
  assert.match(plan.held[0].problem, /"Ali Akbar \(a\.s\)" is not on the approved list/);
});

test('an Anjuman no Catalog lyric has is held', () => {
  assert.deepEqual(run({ anjumans: ['Anjuman-e-Abbasia'] }).held, []);
  assert.deepEqual(run({ anjumans: ['Anjuman-e-Abbasia', 'Invented Anjuman'] }).held.map(({ problem }) => problem), [
    'the Anjuman "Invented Anjuman" is not in the Catalog'
  ]);
});

test('a restored lyric keeps its own Personality and Anjumans, though no other lyric has them', () => {
  const last = lyric('lyric-2', { subcategory: 'Only Here', anjumans: ['Anjuman-e-Only'] });
  const plan = planUpdate({
    submissions: [approved('rev-1', { revisionOfRemoteId: 'lyric-2', title: 'Corrected', subcategory: 'Only Here', anjumans: ['Anjuman-e-Only'] })],
    decisions: [{ id: 'lyric-2', data: { withdrawn: false, updatedAt: at(5000), updatedBy: 'owner-uid' } }],
    lyrics: catalogLyrics,
    lastVersion: remoteId => (remoteId === 'lyric-2' ? last : null)
  });
  assert.deepEqual(plan.held, []);
  assert.equal(plan.writes.get('lyric-2').kind, 'restore');
});

test('the sync reads the Owner\'s approved Personalities from taxonomy/personalities', async t => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const dir = catalogRepo([lyric('lyric-1')]);
  const firestore = {
    taxonomy: {
      categories: { names: ['Nohay'], hidden: [] },
      personalities: { names: ['Alam'], hidden: ['Hazrat Abbas (a.s)'] }
    },
    submissions: {
      'web-alam': approved('web-alam', { subcategory: 'Alam' }).data,
      'web-abbas': approved('web-abbas', { subcategory: 'Hazrat Abbas (a.s)' }).data
    }
  };

  const published = await workflowRun(dir, fakeDb(firestore));

  assert.deepEqual(published.update.items.map(item => item.remoteId), ['web-alam']);
  assert.equal(firestore.submissions['web-abbas'].published, false);
});
