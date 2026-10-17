const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { catalogRepo, fakeDb, workflowRun } = require('./catalog_repo');

// A copy of shared/catalog_updates in the RomanUrduLyricsApp repository, whose
// tests apply the same files through the phone's and the website's readers.
// Change both copies together.
const fixtures = path.join(__dirname, 'fixtures', 'catalog_updates');
const legacy = path.join(fixtures, 'legacy');
const read = file => fs.readFileSync(path.join(legacy, file), 'utf8');
const runs = JSON.parse(fs.readFileSync(path.join(fixtures, 'submissions.json'), 'utf8'));

const timestamp = iso => ({ toMillis: () => Date.parse(iso) });

// Firestore before a run, as sync() reads it.
const firestore = ({ approved, withdrawn }) => fakeDb({
  submissions: Object.fromEntries(Object.entries(approved).map(([id, data]) =>
    [id, { ...data, approvedAt: timestamp(data.approvedAt) }])),
  catalogWithdrawals: Object.fromEntries(withdrawn.map(id =>
    [id, { withdrawn: true, updatedAt: timestamp('2026-10-03T09:30:00Z') }]))
});

// The bundled lyric run 2 withdraws: in the Catalog before run 1.
const bundled = {
  remoteId: 'base-withdrawn',
  title: 'Bundled, later withdrawn',
  body: 'Pehli line',
  language: 'Roman Urdu',
  categories: ['Nohay'],
  anjumans: [],
  verified: false
};

// legacy/ is what the sync writes until the manifest has a contractVersion; v1/
// is what it writes once it has "1.0.0".
for (const [shape, manifestFields] of [['legacy', {}], ['v1', { contractVersion: '1.0.0' }]]) {
  test(`two runs write the shared ${shape} update files and manifest byte for byte`, async t => {
    t.mock.method(console, 'log', () => {});
    const read = file => fs.readFileSync(path.join(fixtures, shape, file), 'utf8');
    const expected = JSON.parse(read('manifest.json'));
    const dir = catalogRepo([bundled], manifestFields);
    let now;
    t.mock.method(Date, 'now', () => now);

    for (const [i, run] of ['run1', 'run2'].entries()) {
      const { id, assetName, releaseTag } = expected.updates[i];
      now = Number(id.slice('update_'.length));
      // Committed and marked as the workflow does; the fixture already holds
      // Firestore as marking leaves it for run 2.
      const published = await workflowRun(dir, firestore(runs[run]), releaseTag);
      assert.equal(published.name, assetName);
      assert.equal(published.text, read(assetName), assetName);
    }

    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    // The tree of lyrics/ readers have now; the fixture predates it.
    assert.match(manifest.catalogTree, /^[0-9a-f]{40}$/);
    delete manifest.catalogTree;
    assert.equal(JSON.stringify(manifest, null, 2) + '\n', read('manifest.json'));
  });
}
