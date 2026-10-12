const test = require('node:test');
const assert = require('node:assert/strict');

const { collectApproved, toUpdateItem } = require('../scripts/sync_firestore_to_github');

// A submission as the app writes it (contract v1), plus workflow fields.
const submission = {
  remoteId: 'doc1',
  title: 'Ya Ali',
  body: 'Line one',
  language: 'Roman Urdu',
  categories: ['Manqabat', 'Qasida'],
  subcategory: 'Imam Ali (a.s)',
  group: 2024,
  author: 'Mir Anees',
  anjumans: [],
  status: 'approved',
  published: false,
  isVerified: true,
  ownerUid: 'user-123',
  termsVersion: '1.0',
  contentDelta: '[]',
  reviewedBy: 'admin-1'
};

test('a published item keeps the poet, language and every category', () => {
  assert.deepEqual(toUpdateItem('doc1', submission), {
    remoteId: 'doc1',
    title: 'Ya Ali',
    body: 'Line one',
    category: 'Manqabat',
    categories: ['Manqabat', 'Qasida'],
    subcategory: 'Imam Ali (a.s)',
    group: 2024,
    isVerified: true,
    source: 'firestore',
    author: 'Mir Anees',
    language: 'Roman Urdu'
  });
});

test('anjumans reach the app through categoryMappings', () => {
  const item = toUpdateItem('doc2', {
    ...submission,
    categories: ['Nohay'],
    anjumans: ['Anjuman-e-Abbasia']
  });
  assert.deepEqual(item.anjumans, ['Anjuman-e-Abbasia']);
  assert.deepEqual(item.categoryMappings, [
    'Nohay',
    { category: 'Anjuman', subcategory: 'Anjuman-e-Abbasia' }
  ]);
});

test('legacy documents still publish, without contributor fields', () => {
  const item = toUpdateItem('doc3', {
    title: 'Old',
    body: 'Body',
    category: 'oldnouhay',
    createdBy: 'device-uuid',
    deviceUserUuid: 'device-uuid'
  });
  assert.equal(item.category, 'Nohay');
  assert.deepEqual(item.categories, ['Nohay']);
  assert.equal(item.isVerified, false);
  for (const key of ['createdBy', 'deviceUserUuid', 'ownerUid', 'author', 'language']) {
    assert.ok(!(key in item), `${key} must not be published`);
  }
});

const at = ms => ({ toMillis: () => ms });

test('a revision is published over the lyric it changes', () => {
  const { items, submissionIds } = collectApproved([
    { id: 'rev-1', data: { ...submission, title: 'Ya Ali (fixed)', revisionOfRemoteId: 'lyric-7' } }
  ]);
  assert.equal(items.length, 1);
  assert.equal(items[0].remoteId, 'lyric-7');
  assert.equal(items[0].title, 'Ya Ali (fixed)');
  assert.deepEqual(submissionIds, ['rev-1']);
});

test('the newest approved revision of a lyric wins and every one is marked', () => {
  const { items, submissionIds } = collectApproved([
    { id: 'rev-new', data: { ...submission, title: 'Newer', revisionOfRemoteId: 'lyric-7', approvedAt: at(2000) } },
    { id: 'rev-old', data: { ...submission, title: 'Older', revisionOfRemoteId: 'lyric-7', approvedAt: at(1000) } },
    { id: 'doc9', data: { ...submission, title: 'New lyric' } }
  ]);
  assert.deepEqual(items.map(i => [i.remoteId, i.title]), [['lyric-7', 'Newer'], ['doc9', 'New lyric']]);
  assert.deepEqual(submissionIds, ['rev-new', 'rev-old', 'doc9']);
});

test('submissions for a withdrawn lyric are held, neither published nor marked', () => {
  const { items, submissionIds } = collectApproved([
    { id: 'rev-1', data: { ...submission, revisionOfRemoteId: 'lyric-7' } },
    { id: 'lyric-7', data: { ...submission, title: 'The lyric itself' } },
    { id: 'doc9', data: { ...submission, title: 'New lyric' } }
  ], new Set(['lyric-7']));
  assert.deepEqual(items.map(i => i.remoteId), ['doc9']);
  assert.deepEqual(submissionIds, ['doc9']);
});

test('revision fields stay out of the published item', () => {
  const [item] = collectApproved([
    { id: 'rev-1', data: { ...submission, revisionOfRemoteId: 'lyric-7' } }
  ]).items;
  assert.ok(!('revisionOfRemoteId' in item));
});
