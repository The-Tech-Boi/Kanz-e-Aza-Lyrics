const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// The sync's jobs hold the Firestore service account and the release token,
// so every action runs at a fixed commit, not a tag that can move. Dependabot
// (.github/dependabot.yml) proposes new pins.
test('every workflow action is pinned to a commit SHA with its version', () => {
  const dir = path.join(__dirname, '../.github/workflows');
  const uses = fs.readdirSync(dir).flatMap(file =>
    [...fs.readFileSync(path.join(dir, file), 'utf8').matchAll(/uses:\s*(.+)/g)].map(m => `${file}: ${m[1].trim()}`));
  assert.ok(uses.length >= 7);
  for (const line of uses) {
    assert.match(line, /: [\w.-]+\/[\w./-]+@[0-9a-f]{40} # v\d+(\.\d+)*$/, line);
  }
});
