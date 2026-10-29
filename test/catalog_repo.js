// A throwaway checkout of this repository for the tests: a git repo with
// scripts/, taxonomy.json, lyrics/ and a manifest.json naming the lyrics/
// tree readers already have. Also a small Firestore stand-in and one run of
// the sync workflow against it.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const catalog = require('../scripts/catalog');
const { markPublished, sync } = require('../scripts/sync_firestore_to_github');

const root = path.join(__dirname, '..');

const git = (dir, ...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();

const commit = (dir, message) => {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', message);
};

// Its own identity and line endings, so commits work on a runner with no git
// user and every machine hashes the same bytes. Nothing here is pushed, so
// nothing is signed.
function catalogRepo(records = [], manifest = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kanz-catalog-'));
  git(dir, 'init', '-q', '-b', 'main');
  fs.appendFileSync(path.join(dir, '.git', 'config'),
    '[user]\n\tname = Test\n\temail = test@example.com\n' +
    '[core]\n\tautocrlf = false\n[commit]\n\tgpgsign = false\n');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'output/\npublish_marks.json\ncommit_message.txt\nnew_lyrics.json\n');
  fs.cpSync(path.join(root, 'scripts'), path.join(dir, 'scripts'), { recursive: true });
  fs.copyFileSync(path.join(root, 'taxonomy.json'), path.join(dir, 'taxonomy.json'));
  for (const record of records) catalog.writeLyric(record, dir);
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    manifestVersion: 1,
    latestReleaseTag: '',
    catalogTree: catalog.catalogTree(dir),
    updates: [],
    ...manifest
  }, null, 2) + '\n');
  commit(dir, 'Start the Catalog');
  return dir;
}

const at = ms => ({ toMillis: () => ms });

// Firestore as the sync reads and marks it. `collections` maps a collection
// name to { docId: data }; marking updates those objects.
function fakeDb(collections) {
  const query = (name, filters) => ({
    where: (field, op, value) => query(name, [...filters, [field, value]]),
    doc: id => ({ name, id }),
    get: async () => ({
      docs: Object.entries(collections[name] ?? {})
        .filter(([, data]) => filters.every(([field, value]) => data[field] === value))
        .map(([id, data]) => ({ id, data: () => data }))
    })
  });
  return {
    collection: name => query(name, []),
    batch: () => {
      const updates = [];
      return {
        update: (ref, data) => updates.push([ref, data]),
        commit: async () => {
          for (const [{ name, id }, data] of updates) Object.assign(collections[name][id], data);
        }
      };
    }
  };
}

// One run of sync_lyrics.yml: sync, then "Commit the Catalog and the Update",
// then "Mark Lyrics Published". Returns the marks and, when something was
// published, the update file and the commit message.
async function workflowRun(dir, db, releaseTag = 'v1.0.1-test') {
  for (const leftover of ['output', 'publish_marks.json', 'commit_message.txt', 'new_lyrics.json']) {
    fs.rmSync(path.join(dir, leftover), { recursive: true, force: true });
  }
  delete process.env.ONLY_IF_ADMIN_EDIT;
  process.env.RELEASE_TAG = releaseTag;
  await sync(db, dir);

  const marksFile = path.join(dir, 'publish_marks.json');
  const marks = fs.existsSync(marksFile) ? JSON.parse(fs.readFileSync(marksFile, 'utf8')) : null;
  const output = path.join(dir, 'output');
  let run = { marks, update: null };
  if (fs.existsSync(output)) {
    const name = fs.readdirSync(output).find(file => file.startsWith('update_'));
    const text = fs.readFileSync(path.join(output, name), 'utf8');
    fs.mkdirSync(path.join(dir, 'updates'), { recursive: true });
    fs.copyFileSync(path.join(output, name), path.join(dir, 'updates', name));
    git(dir, 'add', 'manifest.json', 'updates', 'lyrics', 'index');
    git(dir, 'commit', '-q', '-F', 'commit_message.txt');
    run = {
      marks,
      name,
      text,
      update: JSON.parse(text),
      manifest: JSON.parse(fs.readFileSync(path.join(output, 'manifest.json'), 'utf8')),
      message: git(dir, 'log', '-1', '--format=%B')
    };
  }
  if (marks) await markPublished(marksFile, db);
  return run;
}

module.exports = { at, catalogRepo, commit, fakeDb, git, workflowRun };
