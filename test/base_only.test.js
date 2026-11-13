// A merge commit whose message has the line `Catalog-Publish: base-only`
// publishes nothing: the sync moves manifest.json's catalogTree past it with
// no update file, and its lyric files are the Catalog from then on.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const catalog = require('../scripts/catalog');
const { catalogRepo, commit, fakeDb, git, workflowRun } = require('./catalog_repo');

const lyric = (remoteId, fields = {}) => ({
  remoteId,
  title: `Title of ${remoteId}`,
  body: 'Pehli line\n<<DIVIDER>>\nDoosri line',
  language: 'Roman Urdu',
  categories: ['Nohay'],
  anjumans: [],
  verified: false,
  ...fields
});

const quiet = t => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
};

const idsOf = run => run.update.items.map(item => item.remoteId);
const updateFiles = dir => fs.readdirSync(path.join(dir, 'updates')).filter(name => name.startsWith('update_'));

// An Owner pull request merged with `gh pr merge --merge`: a merge commit.
function merge(dir, branch, change, ...body) {
  git(dir, 'checkout', '-q', '-b', branch);
  change();
  commit(dir, `Work on ${branch}`);
  git(dir, 'checkout', '-q', 'main');
  git(dir, 'merge', '--no-ff', '-q', '-m', `Merge pull request #1 from owner/${branch}`, ...body.flatMap(line => ['-m', line]), branch);
}

const baseOnlyMerge = (dir, branch, change) => merge(dir, branch, change, 'Catalog-Publish: base-only');

test('a base-only merge moves catalogTree and writes no update file; the next change publishes only itself', async t => {
  quiet(t);
  const dir = catalogRepo([lyric('lyric-a1'), lyric('lyric-b2'), lyric('lyric-c3')]);
  const db = fakeDb({});

  baseOnlyMerge(dir, 'fix-case', () => {
    catalog.writeLyric(lyric('lyric-a1', { title: 'Fixed title' }), dir);
    catalog.writeLyric(lyric('lyric-b2', { title: 'Fixed title' }), dir);
  });
  const tree = catalog.treeAt('HEAD', dir);

  const skipped = await workflowRun(dir, db);
  assert.equal(skipped.update, null);
  assert.equal(skipped.movedPast, true);
  assert.equal(skipped.manifest.catalogTree, tree);
  assert.deepEqual(skipped.manifest.updates, []);
  assert.equal(skipped.manifest.latestReleaseTag, '');
  assert.equal(fs.existsSync(path.join(dir, 'updates')), false);

  // The base-only lyrics are the Catalog: a second run has nothing to do.
  assert.equal((await workflowRun(dir, db)).movedPast, undefined);

  merge(dir, 'edit-c3', () => catalog.writeLyric(lyric('lyric-c3', { title: 'Edited' }), dir));
  const next = await workflowRun(dir, db);
  assert.deepEqual(idsOf(next), ['lyric-c3']);
  assert.equal(next.manifest.catalogTree, catalog.treeAt('HEAD', dir));
  assert.equal(updateFiles(dir).length, 1);
});

test('a normal merge before a base-only one is published by itself; the next run moves past the base-only one', async t => {
  quiet(t);
  const dir = catalogRepo([lyric('lyric-a1'), lyric('lyric-b2'), lyric('lyric-c3')]);
  const db = fakeDb({});
  merge(dir, 'normal-1', () => catalog.writeLyric(lyric('lyric-a1', { title: 'Normal' }), dir));
  baseOnlyMerge(dir, 'base', () => catalog.writeLyric(lyric('lyric-b2', { title: 'Base only' }), dir));
  merge(dir, 'normal-2', () => catalog.writeLyric(lyric('lyric-c3', { title: 'Normal too' }), dir));

  const first = await workflowRun(dir, db);
  assert.deepEqual(idsOf(first), ['lyric-a1']);
  const second = await workflowRun(dir, db);
  assert.deepEqual(idsOf(second), ['lyric-c3']);
  assert.equal(second.manifest.catalogTree, catalog.treeAt('HEAD', dir));
  assert.equal((await workflowRun(dir, db)).update, null);
});

test('a later normal edit of a base-only lyric publishes its whole record', async t => {
  quiet(t);
  const dir = catalogRepo([lyric('lyric-a1', { author: 'Poet' })]);
  const db = fakeDb({});
  baseOnlyMerge(dir, 'base', () => catalog.writeLyric(lyric('lyric-a1', { author: 'Poet', title: 'Base only' }), dir));
  await workflowRun(dir, db);
  merge(dir, 'edit', () => catalog.writeLyric(lyric('lyric-a1', { author: 'Poet', title: 'Base only', group: 2020 }), dir));
  const run = await workflowRun(dir, db);
  assert.equal(run.update.items.length, 1);
  assert.equal(run.update.items[0].title, 'Base only');
  assert.equal(run.update.items[0].group, 2020);
});

test('only the line on its own marks a commit', async t => {
  quiet(t);
  const dir = catalogRepo([lyric('lyric-a1')]);
  merge(dir, 'quoted', () => catalog.writeLyric(lyric('lyric-a1', { title: 'Quoted' }), dir),
    'Not a Catalog-Publish: base-only change, just talking about one');
  assert.equal(catalog.baseOnlyCommits(dir).size, 0);
  const run = await workflowRun(dir, fakeDb({}));
  assert.deepEqual(idsOf(run), ['lyric-a1']);
});

test('the pull request check skips the over-2,000 warning when its description says base-only', () => {
  const dir = catalogRepo([lyric('lyric-a1')]);
  for (let i = 0; i < 2001; i++) catalog.writeLyric(lyric(`big-${i}`), dir);
  commit(dir, 'Fix 2001 lyrics');
  const check = body => spawnSync(process.execPath, [path.join('scripts', 'catalog.js'), 'check', 'main~1'],
    { cwd: dir, encoding: 'utf8', env: { ...process.env, PR_BODY: body } });
  assert.equal(check('Fixes.').status, 1);
  assert.equal(check('Fixes.\n\nCatalog-Publish: base-only\n').status, 0);
});

test('the workflows pass the pull request body and commit a run that only moved manifest.json', () => {
  const root = path.join(__dirname, '..', '.github', 'workflows');
  assert.match(fs.readFileSync(path.join(root, 'check_catalog.yml'), 'utf8'), /PR_BODY: \$\{\{ github\.event\.pull_request\.body \}\}/);
  assert.match(fs.readFileSync(path.join(root, 'sync_lyrics.yml'), 'utf8'),
    /name: Commit the Catalog and the Update\s+if: success\(\) && \(hashFiles\('output\/manifest\.json'\) != '' \|\| hashFiles\('commit_message\.txt'\) != ''\)/);
});
