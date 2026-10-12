const test = require('node:test');
const assert = require('node:assert/strict');

const {
  applyUpdateToManifest,
  getRequiredReleaseTag,
  normalizeCategory
} = require('../scripts/sync_firestore_to_github');

test('applyUpdateToManifest uses workflow release tag for root and update entry', () => {
  const manifest = {
    manifestVersion: 1,
    latestReleaseTag: 'old-tag',
    updates: [
      {
        id: 'update_old',
        assetName: 'update_old.json',
        sha256: 'oldsha',
        releaseTag: 'old-real-tag'
      }
    ]
  };

  const next = applyUpdateToManifest(manifest, {
    updateId: 'update_new',
    updateFilename: 'update_new.json',
    sha256: 'newsha',
    releaseTag: 'v1.0.999-123'
  });

  assert.equal(next.latestReleaseTag, 'v1.0.999-123');
  assert.equal(next.updates.at(-1).releaseTag, 'v1.0.999-123');
  assert.equal(next.updates.at(-1).assetName, 'update_new.json');
  assert.equal(next.updates[0].releaseTag, 'old-real-tag');
});

test('normalizeCategory merges oldNouhay into Nohay', () => {
  assert.equal(normalizeCategory('oldNouhay'), 'Nohay');
  assert.equal(normalizeCategory(' oldnouhay '), 'Nohay');
  assert.equal(normalizeCategory('Anjuman'), 'Anjuman');
  assert.equal(normalizeCategory(''), 'Nohay');
});

test('getRequiredReleaseTag fails when workflow env missing', () => {
  const old = process.env.RELEASE_TAG;
  delete process.env.RELEASE_TAG;
  assert.throws(() => getRequiredReleaseTag(), /RELEASE_TAG env var is required/);
  if (old === undefined) {
    delete process.env.RELEASE_TAG;
  } else {
    process.env.RELEASE_TAG = old;
  }
});
