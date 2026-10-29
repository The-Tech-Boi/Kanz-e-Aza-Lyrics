const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { markPublished, pendingWithdrawals } = require('../scripts/sync_firestore_to_github');

// Lyrics are marked published only after the release and the Catalog commit,
// so a failed run leaves them for the next run instead of losing them.
test('lyrics are marked published as the last workflow step', () => {
  const workflow = fs.readFileSync(
    path.join(__dirname, '../.github/workflows/sync_lyrics.yml'), 'utf8');
  const steps = [...workflow.matchAll(/- name: (.+)/g)].map(m => m[1].trim());
  assert.deepEqual(steps.slice(-2), ['Mark Lyrics Published', 'Notify New Lyrics']);
  assert.ok(steps.indexOf('Create Release') < steps.indexOf('Commit the Catalog and the Update'));
  assert.ok(steps.indexOf('Commit the Catalog and the Update') < steps.indexOf('Mark Lyrics Published'));

  const script = fs.readFileSync(
    path.join(__dirname, '../scripts/sync_firestore_to_github.js'), 'utf8');
  const start = script.indexOf('async function sync(');
  assert.ok(start >= 0);
  const syncBody = script.slice(start, script.indexOf('async function markPublished'));
  assert.ok(!syncBody.includes('published: true'), 'sync() must not mark lyrics published');
});

// A run can have marks and nothing to publish: an approval or decision the
// Catalog already has, e.g. a withdrawal and restore between two runs.
test('marking runs whenever the sync left marks, and the commit names the changes', () => {
  const workflow = fs.readFileSync(
    path.join(__dirname, '../.github/workflows/sync_lyrics.yml'), 'utf8');
  assert.match(workflow, /- name: Mark Lyrics Published\s+if: success\(\) && hashFiles\('publish_marks\.json'\) != ''/);
  assert.match(workflow, /git add manifest\.json updates lyrics index\s+git commit -F commit_message\.txt/);
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
