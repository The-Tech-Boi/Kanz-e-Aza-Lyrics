const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const {
  applyUpdateToManifest,
  buildPayload,
  planUpdate,
  publishedState
} = require('../scripts/sync_firestore_to_github');

// A copy of shared/catalog_updates in the RomanUrduLyricsApp repository, whose
// tests apply the same files through the phone's and the website's readers.
// Change both copies together.
const fixtures = path.join(__dirname, 'fixtures', 'catalog_updates');
const legacy = path.join(fixtures, 'legacy');
const read = file => fs.readFileSync(path.join(legacy, file), 'utf8');
const runs = JSON.parse(fs.readFileSync(path.join(fixtures, 'submissions.json'), 'utf8'));

const timestamp = iso => ({ toMillis: () => Date.parse(iso) });

// Firestore before a run, as sync() reads it.
const firestore = ({ approved, withdrawn }) => ({
  submissions: Object.entries(approved).map(([id, data]) =>
    ({ id, data: { ...data, approvedAt: timestamp(data.approvedAt) } })),
  decisions: withdrawn.map(id =>
    ({ id, data: { withdrawn: true, updatedAt: timestamp('2026-10-03T09:30:00Z') } }))
});

test('two runs write the shared update files and manifest byte for byte', () => {
  const expected = read('manifest.json');
  let manifest = { manifestVersion: 1, latestReleaseTag: '', updates: [] };
  ['run1', 'run2'].forEach((run, i) => {
    const { id, assetName, releaseTag } = JSON.parse(expected).updates[i];
    const plan = planUpdate({ ...firestore(runs[run]), published: publishedState(manifest, legacy) });
    // Serialized and hashed as sync() does.
    const bytes = JSON.stringify(buildPayload(plan.items, plan.removed.join(' ')), null, 2) + '\n';
    assert.equal(bytes, read(assetName), assetName);
    manifest = applyUpdateToManifest(manifest, {
      updateId: id,
      updateFilename: assetName,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      releaseTag
    });
  });
  assert.equal(JSON.stringify(manifest, null, 2) + '\n', expected);
});
