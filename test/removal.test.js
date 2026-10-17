const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { buildPayload, planUpdate, toUpdateItem } = require('../scripts/sync_firestore_to_github');

const record = {
  remoteId: 'doc1',
  title: 'Ya Ali',
  body: 'Line one',
  language: 'Roman Urdu',
  categories: ['Manqabat'],
  anjumans: [],
  verified: false
};

test('a removal-only update has empty items and the removed ids', () => {
  assert.deepEqual(buildPayload([], ['doc1', 'local_abc']), {
    items: [],
    removed: ['doc1', 'local_abc']
  });
});

test('an update takes the old shape until the manifest names contract 1.0.0, and nothing is no update', () => {
  assert.deepEqual(buildPayload([record], []), { items: [toUpdateItem(record)] });
  assert.deepEqual(buildPayload([record], ['doc2'], '1.0.0'), {
    contractVersion: '1.0.0',
    items: [record],
    removed: ['doc2']
  });
  assert.equal(buildPayload([], []), null);
  assert.equal(buildPayload([], [], '1.0.0'), null);
});

const at = ms => ({ toMillis: () => ms });

test('a Withdrawal deletes the lyric\'s file; one the Catalog never had deletes nothing but is marked', () => {
  const plan = planUpdate({
    submissions: [],
    decisions: [
      { id: 'doc1', data: { withdrawn: true, updatedAt: at(4000) } },
      { id: 'never-published', data: { withdrawn: true, updatedAt: at(4500) } }
    ],
    lyrics: new Map([['doc1', record]])
  });
  assert.deepEqual([...plan.deletes], [['doc1', { title: 'Ya Ali', kind: 'withdrawal' }]]);
  assert.deepEqual(plan.decisions, [
    { remoteId: 'doc1', updatedAt: 4000 },
    { remoteId: 'never-published', updatedAt: 4500 }
  ]);
});

// Withdrawals go through the website's Owner panel, so readers are told; a
// pull request that deletes a lyric file fails its check.
test('every pull request checks the lyric files against its base', () => {
  const workflow = fs.readFileSync(
    path.join(__dirname, '../.github/workflows/check_catalog.yml'), 'utf8');
  assert.match(workflow, /on:\s+pull_request:/);
  assert.match(workflow, /run: node scripts\/catalog\.js check origin\/\$\{\{ github\.base_ref \}\}/);
  assert.match(workflow, /fetch-depth: 0/);
});
