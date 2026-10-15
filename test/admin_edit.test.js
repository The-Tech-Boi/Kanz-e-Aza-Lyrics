const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { hasAdminEdit } = require('../scripts/sync_firestore_to_github');

const doc = data => ({ id: 'lyric-1', data });

test('an admin edit is a submission its approver also sent', () => {
  assert.equal(hasAdminEdit([doc({ ownerUid: 'admin-1', approvedBy: 'admin-1' })]), true);
  assert.equal(hasAdminEdit([
    doc({ ownerUid: 'reader-1', approvedBy: 'admin-1' }),
    doc({ ownerUid: 'admin-1', approvedBy: 'admin-1' })
  ]), true);
});

test('a reader suggestion an admin approved is not an admin edit', () => {
  assert.equal(hasAdminEdit([doc({ ownerUid: 'reader-1', approvedBy: 'admin-1' })]), false);
});

test('a document missing ownerUid or approvedBy is not an admin edit', () => {
  assert.equal(hasAdminEdit([doc({ approvedBy: 'admin-1' })]), false);
  assert.equal(hasAdminEdit([doc({ ownerUid: 'admin-1' })]), false);
  assert.equal(hasAdminEdit([doc({})]), false);
  assert.equal(hasAdminEdit([doc({ ownerUid: '', approvedBy: '' })]), false);
});

test('no documents is no admin edit', () => {
  assert.equal(hasAdminEdit([]), false);
});

test('only the 15-minute schedule asks for the admin edit check, and runs never overlap', () => {
  const workflow = fs.readFileSync(
    path.join(__dirname, '../.github/workflows/sync_lyrics.yml'), 'utf8');
  assert.match(workflow, /- cron: "0 \*\/6 \* \* \*"/);
  assert.match(workflow, /- cron: "\*\/15 \* \* \* \*"/);
  assert.match(workflow, /ONLY_IF_ADMIN_EDIT: \$\{\{ github\.event\.schedule == '\*\/15 \* \* \* \*' && '1' \|\| '' \}\}/);
  assert.match(workflow, /concurrency:\s+group: sync-lyrics\s+cancel-in-progress: false/);
});
