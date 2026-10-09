const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// The app and website reject an update whose bytes don't match the manifest.
test('every update in manifest.json matches its published file', () => {
  const root = path.join(__dirname, '..');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  for (const update of manifest.updates) {
    const bytes = fs.readFileSync(path.join(root, 'updates', update.assetName));
    const sha = crypto.createHash('sha256').update(bytes).digest('hex');
    assert.strictEqual(sha, update.sha256, update.assetName);
  }
});
