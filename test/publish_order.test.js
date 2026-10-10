const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { markPublished } = require('../scripts/sync_firestore_to_github');

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

test('markPublished marks every lyric in the update file', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mark-')), 'update_1.json');
  fs.writeFileSync(file, JSON.stringify({ items: [{ remoteId: 'a' }, { remoteId: 'b' }] }));
  const updated = [];
  let committed = false;
  const db = {
    collection: name => ({ doc: id => `${name}/${id}` }),
    batch: () => ({
      update: (ref, data) => updated.push([ref, data]),
      commit: async () => { committed = true; }
    })
  };

  await markPublished([file], db);

  assert.deepEqual(updated, [
    ['submissions/a', { published: true }],
    ['submissions/b', { published: true }]
  ]);
  assert.ok(committed);
});
