const test = require('node:test');
const assert = require('node:assert/strict');

const { applyUpdateToManifest } = require('../scripts/sync_firestore_to_github');

// The website builds its catalog on every visit from the bundled base catalog
// plus the updates manifest.json lists (ReleaseCatalogService in the app
// repository); a fresh phone install does the same. Nothing folds older
// updates into the base catalog, so the manifest must keep every update:
// a dropped one takes its lyrics (and withdrawals) off those readers.
test('a published update stays listed after 50 later runs', () => {
  let manifest = { manifestVersion: 1, latestReleaseTag: '', updates: [] };
  for (let run = 1; run <= 51; run++) {
    manifest = applyUpdateToManifest(manifest, {
      updateId: `update_${run}`,
      updateFilename: `update_${run}.json`,
      sha256: `sha_${run}`,
      releaseTag: `v1.0.${run}`
    });
  }

  assert.ok(
    manifest.updates.some(update => update.assetName === 'update_1.json'),
    'update_1.json, and every lyric only it published, is no longer reachable'
  );
  assert.deepEqual(
    manifest.updates.map(update => update.id),
    Array.from({ length: 51 }, (_, i) => `update_${i + 1}`)
  );
});
