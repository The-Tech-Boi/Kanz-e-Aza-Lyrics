const test = require('node:test');
const assert = require('node:assert/strict');

const { toUpdateItem } = require('../scripts/sync_firestore_to_github');

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
