const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { buildPayload } = require('../scripts/sync_firestore_to_github');

test('a removal-only run publishes empty items and the removed ids', () => {
  assert.deepEqual(buildPayload([], ' doc1, local_abc\ndoc1 '), {
    items: [],
    removed: ['doc1', 'local_abc']
  });
});

test('regular runs keep the payload shape and skip when empty', () => {
  assert.deepEqual(buildPayload([{ remoteId: 'a' }]), { items: [{ remoteId: 'a' }] });
  assert.equal(buildPayload([], ''), null);
  assert.equal(buildPayload([]), null);
});

test('the manual run passes remove_ids to the sync script', () => {
  const workflow = fs.readFileSync(
    path.join(__dirname, '../.github/workflows/sync_lyrics.yml'), 'utf8');
  assert.match(workflow, /workflow_dispatch:[\s\S]*remove_ids:/);
  assert.match(workflow, /REMOVE_IDS: \$\{\{ inputs\.remove_ids \}\}/);
});
