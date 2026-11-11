// What a sync run hands readers at once. Installed 1.1.2 and 1.1.3 phones
// apply every listed update back to back, each file in one transaction, so a
// run publishes at most RUN_LYRICS changed lyrics, in update files of at most
// UPDATE_ENTRIES entries and UPDATE_BYTES bytes, and the manifest lists at
// most MANIFEST_UPDATES updates. The rest waits for the next runs.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const catalog = require('../scripts/catalog');
const { buildPayload, splitUpdate } = require('../scripts/sync_firestore_to_github');
const { at, catalogRepo, commit, fakeDb, git, workflowRun } = require('./catalog_repo');

const root = path.join(__dirname, '..');

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

// An approved submission as the website leaves it.
const approved = (remoteId, fields = {}) => ({
  remoteId,
  title: `Title of ${remoteId}`,
  body: 'Pehli line\n<<DIVIDER>>\nDoosri line',
  language: 'Roman Urdu',
  categories: ['Nohay'],
  anjumans: [],
  termsVersion: '2026-10',
  ownerUid: 'reader-uid-9',
  status: 'approved',
  published: false,
  isVerified: false,
  approvedBy: 'admin-uid-3',
  approvedAt: at(2000),
  ...fields
});

const quiet = t => {
  t.mock.method(console, 'log', () => {});
  return t.mock.method(console, 'warn', () => {});
};

const range = (n, name) => Array.from({ length: n }, (_, i) => name(i));
const byPath = (a, b) => catalog.lyricPath(a).localeCompare(catalog.lyricPath(b));
const exists = (dir, file) => fs.existsSync(path.join(dir, file));
const entries = ({ update }) => update.items.length + (update.removed?.length ?? 0);
const itemIds = run => run.files.flatMap(({ update }) => update.items.map(item => item.remoteId));
const updateFile = (items, removed = []) =>
  JSON.stringify({ contractVersion: '1.0.0', items, ...(removed.length && { removed }) }, null, 2) + '\n';
// Manifest entries for updates published long ago.
const listed = n => range(n, i => ({
  id: `update_${1700000000000 + i}`,
  assetName: `update_${1700000000000 + i}.json`,
  sha256: '0'.repeat(64),
  releaseTag: 'v1.0.0-old'
}));

// The pull request check and the sync workflow's check of output/, as the workflows run them.
const cli = (dir, ...args) => spawnSync(
  process.execPath, [path.join('scripts', 'catalog.js'), ...args], { cwd: dir, encoding: 'utf8' });

test('a run where 1,814 lyrics changed writes update files of 500, 500, 500 and 314, in order', async t => {
  quiet(t);
  const dir = catalogRepo([lyric('gone-a1'), lyric('gone-b2')], { contractVersion: '1.0.0' });
  // The Owner's import, and this run's approvals and Withdrawals.
  const imported = range(1800, i => `import-${String(i).padStart(4, '0')}`);
  for (const id of imported) catalog.writeLyric(lyric(id), dir);
  commit(dir, 'Import 1800 lyrics');
  const approvals = range(12, i => `web-${i}`);
  const now = 1795000000000;
  t.mock.method(Date, 'now', () => now);

  const run = await workflowRun(dir, fakeDb({
    submissions: Object.fromEntries(approvals.map(id => [id, approved(id)])),
    catalogWithdrawals: Object.fromEntries(['gone-a1', 'gone-b2'].map(id => [id, { withdrawn: true, updatedAt: at(4000) }]))
  }), 'v1.0.7-test');

  assert.deepEqual(run.files.map(entries), [500, 500, 500, 314]);
  const ids = range(4, i => `update_${now + i}`);
  assert.deepEqual(run.manifest.updates, ids.map((id, i) => ({
    id,
    assetName: `${id}.json`,
    sha256: crypto.createHash('sha256').update(run.files[i].text).digest('hex'),
    releaseTag: 'v1.0.7-test'
  })));
  assert.deepEqual(run.files.map(({ name }) => name), ids.map(id => `${id}.json`));
  assert.equal(run.manifest.latestReleaseTag, 'v1.0.7-test');
  assert.equal(run.manifest.catalogTree, catalog.treeAt('HEAD', dir));
  // Each changed lyric once, this run's approvals first; the removals last.
  assert.deepEqual(itemIds(run), [...approvals, ...imported.sort(byPath)]);
  assert.deepEqual(run.files.map(({ update }) => update.removed), [undefined, undefined, undefined, ['gone-a1', 'gone-b2']]);
  assert.ok(run.files.every(({ update }) => update.contractVersion === '1.0.0'));
  assert.match(run.message, /^Publish 1814 lyric changes \[skip ci\]\n\n- Title of web-0: new\n/);
});

test('large styled lyrics split by bytes before 500 entries; every file is at most 2,000,000 bytes', async t => {
  quiet(t);
  const dir = catalogRepo([], { contractVersion: '1.0.0' });
  const lines = range(125, i => `Misra ${i} of a long marsiya, with enough words to fill the line well`);
  const styling = lines.flatMap(line => [{ insert: line }, { insert: '\n', attributes: { align: 'center', bold: true } }]);
  const long = range(120, i => `marsiya-${String(i).padStart(3, '0')}`);
  for (const id of long) catalog.writeLyric(lyric(id, { body: lines.join('\n'), styling, categories: ['Marsiya'] }), dir);
  commit(dir, 'Add 120 long lyrics');

  const run = await workflowRun(dir, fakeDb({}));

  assert.ok(run.files.length >= 3, `${run.files.length} files`);
  for (const file of run.files) {
    assert.ok(Buffer.byteLength(file.text) <= catalog.UPDATE_BYTES, file.name);
    assert.ok(entries(file) < catalog.UPDATE_ENTRIES, file.name);
  }
  // As full as they can be: the next file's first lyric would not fit.
  for (const [i, file] of run.files.slice(0, -1).entries()) {
    const more = [...file.update.items, run.files[i + 1].update.items[0]];
    assert.ok(Buffer.byteLength(updateFile(more)) > catalog.UPDATE_BYTES, file.name);
  }
  assert.deepEqual(itemIds(run), long.sort(byPath));
  assert.deepEqual(run.files[0].update.items[0].styling, styling);
});

test('one lyric over 2,000,000 bytes as an update file stops the run, naming it', async t => {
  quiet(t);
  const dir = catalogRepo([lyric('lyric-a1')]);
  const manifest = fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8');
  catalog.writeLyric(lyric('huge-z9', { body: 'Bahut lambi line\n'.repeat(130000) + 'Aakhri line' }), dir);
  commit(dir, 'Add a huge lyric');

  await assert.rejects(workflowRun(dir, fakeDb({})), /huge-z9: one lyric over 2000000 bytes as an update file/);
  assert.ok(!exists(dir, 'output'));
  assert.equal(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'), manifest);
});

test('a run of 500 entries or fewer writes one file, byte for byte the single update earlier runs wrote', async t => {
  quiet(t);
  const dir = catalogRepo([lyric('gone-a1')], { contractVersion: '1.0.0' });
  const added = range(498, i => `owner-${i}`);
  for (const id of added) catalog.writeLyric(lyric(id), dir);
  commit(dir, 'Owner adds 498 lyrics');

  const run = await workflowRun(dir, fakeDb({
    submissions: { 'web-c3': approved('web-c3') },
    catalogWithdrawals: { 'gone-a1': { withdrawn: true, updatedAt: at(4000) } }
  }));

  assert.equal(run.files.length, 1);
  assert.equal(entries(run), 500);
  const records = ['web-c3', ...added.sort(byPath)]
    .map(id => JSON.parse(fs.readFileSync(path.join(dir, catalog.lyricPath(id)), 'utf8')));
  assert.equal(run.text, JSON.stringify(buildPayload(records, ['gone-a1'], '1.0.0'), null, 2) + '\n');
});

test('splitUpdate: 500 entries are one file as before, 501 are two', () => {
  const records = range(500, i => lyric(`lyric-${i}`));
  for (const contractVersion of ['1.0.0', undefined]) {
    assert.deepEqual(splitUpdate(records, [], contractVersion),
      [JSON.stringify(buildPayload(records, [], contractVersion), null, 2) + '\n']);
    const files = splitUpdate(records, ['gone'], contractVersion).map(text => JSON.parse(text));
    assert.deepEqual(files.map(file => [file.items.length, file.removed]), [[500, undefined], [0, ['gone']]]);
  }
});

test('a run publishes at most 2,000 changed lyrics, the longest waiting first, and the next runs the rest, each once', async t => {
  quiet(t);
  const ids = range(4500, i => `lyric-${String(i).padStart(4, '0')}`);
  const dir = catalogRepo(ids.map(id => lyric(id)), { contractVersion: '1.0.0' });
  // A revision of every lyric, approved in id order; Firestore lists them the other way round.
  const firestore = {
    submissions: Object.fromEntries([...ids].reverse().map((id, i) => [`rev-${id}`, approved(`rev-${id}`, {
      revisionOfRemoteId: id, title: `Revised ${id}`, approvedAt: at(1000000 + 4500 - i)
    })]))
  };
  const db = fakeDb(firestore);
  const waiting = () => Object.values(firestore.submissions).filter(({ published }) => !published).length;
  const title = id => JSON.parse(fs.readFileSync(path.join(dir, catalog.lyricPath(id)), 'utf8')).title;

  const first = await workflowRun(dir, db);
  assert.deepEqual(first.files.map(entries), [500, 500, 500, 500]);
  assert.deepEqual(itemIds(first).sort(), ids.slice(0, 2000));
  assert.equal(first.marks.submissions.length, 2000);
  // The rest stay pending in Firestore: neither written nor marked.
  assert.equal(waiting(), 2500);
  assert.equal(title(ids[2000]), `Title of ${ids[2000]}`);
  assert.equal(first.manifest.catalogTree, catalog.treeAt('HEAD', dir));

  const second = await workflowRun(dir, db);
  assert.deepEqual(itemIds(second).sort(), ids.slice(2000, 4000));
  assert.equal(waiting(), 500);
  const third = await workflowRun(dir, db);
  assert.deepEqual(third.files.map(entries), [500]);
  assert.deepEqual(itemIds(third).sort(), ids.slice(4000));
  assert.equal(waiting(), 0);
  assert.equal((await workflowRun(dir, db)).update, null);

  const runs = [first, second, third];
  const all = runs.flatMap(itemIds);
  assert.equal(all.length, 4500);
  assert.equal(new Set(all).size, 4500);
  assert.ok(runs.flatMap(run => run.files.flatMap(({ update }) => update.items))
    .every(item => item.title === `Revised ${item.remoteId}`));
  assert.ok(ids.every(id => title(id) === `Revised ${id}`));
  assert.equal(third.manifest.catalogTree, catalog.treeAt('HEAD', dir));
  // Every update id is new and later than the one before.
  const updateIds = third.manifest.updates.map(({ id }) => Number(id.slice('update_'.length)));
  assert.ok(updateIds.every((id, i) => i === 0 || id > updateIds[i - 1]));
});

test('the Owner\'s commits go out whole and in order, before approvals, at most 2,000 lyrics a run', async t => {
  quiet(t);
  const dir = catalogRepo([lyric('lyric-a1')]);
  const books = range(3, b => range(700, i => `book${b + 1}-${String(i).padStart(3, '0')}`));
  for (const [b, book] of books.entries()) {
    for (const id of book) catalog.writeLyric(lyric(id), dir);
    commit(dir, `Import book ${b + 1}`);
  }
  const approvals = range(50, i => `web-${i}`);
  const firestore = { submissions: Object.fromEntries(approvals.map(id => [id, approved(id)])) };
  const db = fakeDb(firestore);

  // Books 1 and 2: book 3 would make 2,100.
  const first = await workflowRun(dir, db);
  assert.deepEqual(itemIds(first), [...books[0], ...books[1]].sort(byPath));
  assert.equal(first.manifest.catalogTree, catalog.treeAt('HEAD~2', dir));
  assert.equal(first.marks, null);
  assert.ok(approvals.every(id => firestore.submissions[id].published === false));
  assert.ok(!exists(dir, catalog.lyricPath('web-0')));

  // Book 3, then the approvals the room leaves.
  const second = await workflowRun(dir, db);
  assert.deepEqual(itemIds(second), [...approvals, ...books[2].sort(byPath)]);
  assert.ok(approvals.every(id => firestore.submissions[id].published === true));
  assert.equal(second.manifest.catalogTree, catalog.treeAt('HEAD', dir));
  assert.equal((await workflowRun(dir, db)).update, null);

  const all = [first, second].flatMap(itemIds);
  assert.equal(all.length, 2150);
  assert.equal(new Set(all).size, 2150);
});

test('one commit of more than 2,000 lyric changes goes out by itself in one run, with a warning; approvals wait for the next', async t => {
  const warn = quiet(t);
  const dir = catalogRepo([lyric('lyric-a1')], { contractVersion: '1.0.0' });
  const imported = range(2600, i => `big-${String(i).padStart(4, '0')}`);
  for (const id of imported) catalog.writeLyric(lyric(id), dir);
  commit(dir, 'Import 2600 lyrics at once');
  const sha = git(dir, 'rev-parse', 'HEAD');
  const approvals = range(10, i => `web-${i}`);
  const firestore = { submissions: Object.fromEntries(approvals.map(id => [id, approved(id)])) };
  const db = fakeDb(firestore);

  // Its pull request check fails, as a warning the Owner can merge past.
  const check = cli(dir, 'check', 'main~1');
  assert.equal(check.status, 1);
  assert.match(check.stderr, /Warning: lyrics\/: 2600 lyrics changed, over the 2000 one sync run publishes\. Merged, it goes out in one run of its own, and phones on 1\.1\.2 and 1\.1\.3 apply it all at once\./);

  const first = await workflowRun(dir, db);
  assert.deepEqual(first.files.map(entries), [500, 500, 500, 500, 500, 100]);
  assert.deepEqual(itemIds(first), imported.sort(byPath));
  assert.equal(first.manifest.catalogTree, catalog.treeAt(sha, dir));
  const log = warn.mock.calls.map(call => call.arguments.join(' ')).join('\n');
  assert.match(log, new RegExp(`Commit ${sha} alone changes 2600 lyrics, over the 2000 a run publishes: publishing it by itself\.`));
  assert.equal(first.marks, null);
  assert.ok(approvals.every(id => firestore.submissions[id].published === false));

  const second = await workflowRun(dir, db);
  assert.deepEqual(itemIds(second), approvals);
  assert.ok(approvals.every(id => firestore.submissions[id].published === true));
  assert.equal(second.manifest.catalogTree, catalog.treeAt('HEAD', dir));
  assert.equal((await workflowRun(dir, db)).update, null);
});

test('an earlier commit with a file fixed since is not published; lyrics/ as it is now goes out instead', async t => {
  const warn = quiet(t);
  const dir = catalogRepo([lyric('lyric-a1')], { contractVersion: '1.0.0' });
  for (const id of range(1500, i => `first-${i}`)) catalog.writeLyric(lyric(id), dir);
  catalog.writeLyric(lyric('lyric-a1', { group: 3000 }), dir);
  commit(dir, 'Import 1500 lyrics, with a typo');
  const sha = git(dir, 'rev-parse', 'HEAD');
  for (const id of range(600, i => `second-${i}`)) catalog.writeLyric(lyric(id), dir);
  catalog.writeLyric(lyric('lyric-a1', { group: 2024 }), dir);
  commit(dir, 'Import 600 more, and fix the typo');

  const run = await workflowRun(dir, fakeDb({}));

  assert.equal(itemIds(run).length, 2101);
  assert.ok(run.files.flatMap(({ update }) => update.items).every(item => catalog.recordProblem(item) === null));
  assert.equal(run.manifest.catalogTree, catalog.treeAt('HEAD', dir));
  const log = warn.mock.calls.map(call => call.arguments.join(' ')).join('\n');
  assert.match(log, new RegExp(`lyrics/a1/lyric-a1\.json breaks a rule as of ${sha}, fixed since\.`));
  assert.match(log, /Publishing lyrics\/ as it is now: all 2101 lyric changes in one run\./);
});

test('the sync stops before writing anything when the manifest would list more than 1,000 updates', async t => {
  quiet(t);
  const dir = catalogRepo([lyric('lyric-a1')], { updates: listed(1000) });
  const manifest = fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8');
  const firestore = { submissions: { 'web-c3': approved('web-c3') } };

  await assert.rejects(workflowRun(dir, fakeDb(firestore)),
    /Update limits broken, nothing published:\nmanifest\.json: 1001 updates listed, over 1000\. The Owner removes old entries/);
  for (const file of ['output', 'publish_marks.json', 'commit_message.txt', 'new_lyrics.json']) {
    assert.ok(!exists(dir, file), `${file} was written`);
  }
  assert.equal(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'), manifest);
  assert.equal(firestore.submissions['web-c3'].published, false);
});

test('the sync warns once the manifest lists 500 updates', async t => {
  const warn = quiet(t);
  const dir = catalogRepo([lyric('lyric-a1')], { updates: listed(500) });

  const run = await workflowRun(dir, fakeDb({ submissions: { 'web-c3': approved('web-c3') } }));

  assert.equal(run.manifest.updates.length, 501);
  const log = warn.mock.calls.map(call => call.arguments.join(' ')).join('\n');
  assert.match(log, /manifest\.json: 501 updates listed; over 1000 the sync stops/);
});

test('updateProblems flags a 501-entry file, a 2,000,001-byte file and a 1,001-update manifest', () => {
  const few = { updates: listed(10) };
  const items = n => range(n, i => lyric(`lyric-${i}`));
  assert.deepEqual(catalog.updateProblems(few, [
    ['update_1.json', updateFile(items(500))],
    ['update_2.json', updateFile(items(499), ['gone'])]
  ]), { problems: [], warnings: [] });
  assert.deepEqual(catalog.updateProblems(few, [['update_3.json', updateFile(items(500), ['gone'])]]).problems,
    ['update_3.json: 501 entries, over 500']);

  const sized = bytes => {
    const base = Buffer.byteLength(updateFile([lyric('lyric-a1', { body: '' })]));
    return updateFile([lyric('lyric-a1', { body: 'x'.repeat(bytes - base) })]);
  };
  assert.equal(Buffer.byteLength(sized(2000001)), 2000001);
  assert.deepEqual(catalog.updateProblems(few, [['update_4.json', sized(2000000)]]).problems, []);
  assert.deepEqual(catalog.updateProblems(few, [['update_4.json', sized(2000001)]]).problems,
    ['update_4.json: 2000001 bytes, over 2000000']);
  assert.deepEqual(catalog.updateProblems(few, [['update_5.json', '{ "items": [']]).problems, ['update_5.json: not valid JSON']);

  const manifest = n => catalog.updateProblems({ updates: listed(n) }, []);
  assert.match(manifest(1001).problems.join(), /^manifest\.json: 1001 updates listed, over 1000\./);
  assert.deepEqual(manifest(1001).warnings, []);
  assert.deepEqual(manifest(1000).problems, []);
  assert.match(manifest(1000).warnings.join(), /^manifest\.json: 1000 updates listed; over 1000 the sync stops/);
  assert.match(manifest(501).warnings.join(), /^manifest\.json: 501 updates listed/);
  assert.match(manifest(500).warnings.join(), /^manifest\.json: 500 updates listed/);
  assert.deepEqual(manifest(499), { problems: [], warnings: [] });
});

// Listed and applied by phones before the limits: splitting or renaming it
// would make them apply it again, so it stays as it is.
test('today\'s manifest and update files are within the limits, the 547-lyric update the one exception', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  const files = manifest.updates.map(({ assetName }) => [assetName, fs.readFileSync(path.join(root, 'updates', assetName))]);
  assert.deepEqual(catalog.updateProblems(manifest, files).problems, []);
  const exception = fs.readFileSync(path.join(root, 'updates', 'update_1793650281638.json'));
  assert.deepEqual(catalog.updateProblems({ updates: [] }, [['renamed.json', exception]]).problems,
    ['renamed.json: 547 entries, over 500']);
});

test('the sync workflow checks output/ against the limits before the release', () => {
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/sync_lyrics.yml'), 'utf8');
  const steps = [...workflow.matchAll(/- name: (.+)/g)].map(m => m[1].trim());
  assert.ok(steps.indexOf('Validate Generated Manifest') < steps.indexOf('Create Release'));
  const validate = workflow.slice(workflow.indexOf('- name: Validate Generated Manifest'), workflow.indexOf('- name: Create Release'));
  assert.match(validate, /run: \|[\s\S]*node scripts\/catalog\.js updates output/);
});

test('the check of output/ fails a 501-entry update file and passes one of 500', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kanz-output-'));
  const write = n => {
    const text = updateFile(range(n, i => lyric(`lyric-${i}`)));
    fs.writeFileSync(path.join(dir, 'update_1795000000000.json'), text);
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
      updates: [...listed(3), { id: 'update_1795000000000', assetName: 'update_1795000000000.json', sha256: 'x', releaseTag: 'v' }]
    }));
  };

  write(501);
  const over = cli(root, 'updates', dir);
  assert.equal(over.status, 1);
  assert.match(over.stderr, /update_1795000000000\.json: 501 entries, over 500/);
  write(500);
  const within = cli(root, 'updates', dir);
  assert.equal(within.status, 0, within.stderr);
});

test('a pull request that adds a 501-entry update file fails its check; updates its base lists are not its own', () => {
  const dir = catalogRepo([lyric('lyric-a1')]);
  const add = (id, n) => {
    fs.mkdirSync(path.join(dir, 'updates'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'updates', `${id}.json`), updateFile(range(n, i => lyric(`lyric-${i}`))));
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    manifest.updates.push({ id, assetName: `${id}.json`, sha256: 'x', releaseTag: 'v' });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    commit(dir, `List ${id}`);
  };

  add('update_1795000000000', 501);
  const result = cli(dir, 'check', 'main~1');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /update_1795000000000\.json: 501 entries, over 500/);

  add('update_1795000000001', 3);
  const next = cli(dir, 'check', 'main~1');
  assert.equal(next.status, 0, next.stderr);
});
