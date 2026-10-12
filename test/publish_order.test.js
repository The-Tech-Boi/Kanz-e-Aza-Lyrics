const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { markPublished, pendingWithdrawals, buildPayload } = require('../scripts/sync_firestore_to_github');

// Lyrics are marked published only after the release and manifest commit, so a
// failed run leaves them for the next run instead of losing them.
test('lyrics are marked published as the last workflow step', () => {
  const workflow = fs.readFileSync(
    path.join(__dirname, '../.github/workflows/sync_lyrics.yml'), 'utf8');
  const steps = [...workflow.matchAll(/- name: (.+)/g)].map(m => m[1].trim());
  assert.equal(steps.at(-1), 'Mark Lyrics Published');
  assert.ok(steps.indexOf('Create Release') < steps.indexOf('Mark Lyrics Published'));

  const script = fs.readFileSync(
    path.join(__dirname, '../scripts/sync_firestore_to_github.js'), 'utf8');
  const syncBody = script.slice(script.indexOf('async function sync()'), script.indexOf('async function markPublished'));
  assert.ok(!syncBody.includes('published: true'), 'sync() must not mark lyrics published');
});

test('markPublished marks every submission the run published', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mark-')), 'publish_marks.json');
  fs.writeFileSync(file, JSON.stringify({ submissions: ['a', 'revision-of-a'] }));
  const updated = [];
  let committed = false;
  const db = {
    collection: name => ({ doc: id => `${name}/${id}` }),
    batch: () => ({
      update: (ref, data) => updated.push([ref, data]),
      commit: async () => { committed = true; }
    })
  };

  await markPublished(file, db);

  assert.deepEqual(updated, [
    ['submissions/a', { published: true }],
    ['submissions/revision-of-a', { published: true }]
  ]);
  assert.ok(committed);
});

test('the marks file stays out of the release assets', () => {
  const workflow = fs.readFileSync(
    path.join(__dirname, '../.github/workflows/sync_lyrics.yml'), 'utf8');
  assert.match(workflow, /--mark-published publish_marks\.json/);
  assert.match(workflow, /files: output\/\*/);
});

const at = ms => ({ toMillis: () => ms });

test('website withdrawals go out until published, and again after a change', () => {
  const pending = pendingWithdrawals([
    { id: 'never-published', data: { withdrawn: true, updatedAt: at(1000) } },
    { id: 'published', data: { withdrawn: true, updatedAt: at(1000), publishedAt: at(1000) } },
    { id: 'changed-since', data: { withdrawn: true, updatedAt: at(3000), publishedAt: at(1000) } }
  ]);
  assert.deepEqual(pending, [
    { remoteId: 'never-published', updatedAt: 1000 },
    { remoteId: 'changed-since', updatedAt: 3000 }
  ]);
});

test('withdrawals alone make an update, merged with REMOVE_IDS', () => {
  assert.deepEqual(
    buildPayload([], [undefined, 'lyric-1', 'lyric-2'].join(' ')),
    { items: [], removed: ['lyric-1', 'lyric-2'] }
  );
  assert.deepEqual(
    buildPayload([], ['lyric-1, lyric-3', 'lyric-1'].join(' ')).removed,
    ['lyric-1', 'lyric-3']
  );
});

test('markPublished stamps each withdrawal with the updatedAt the run saw', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mark-')), 'publish_marks.json');
  fs.writeFileSync(file, JSON.stringify({
    submissions: [],
    withdrawals: [{ remoteId: 'lyric-1', updatedAt: 1234 }]
  }));
  const updated = [];
  const db = {
    collection: name => ({ doc: id => `${name}/${id}` }),
    batch: () => ({ update: (ref, data) => updated.push([ref, data]), commit: async () => {} })
  };

  await markPublished(file, db);

  assert.equal(updated.length, 1);
  assert.equal(updated[0][0], 'catalogWithdrawals/lyric-1');
  assert.equal(updated[0][1].publishedAt.toMillis(), 1234);
});
