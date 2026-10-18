// sync() end to end in a checkout of this repository: Firestore as a small
// stand-in, lyrics/ and the manifest in a temp git repo, each run committed
// and marked as sync_lyrics.yml does.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const catalog = require('../scripts/catalog');
const { toUpdateItem } = require('../scripts/sync_firestore_to_github');
const { at, catalogRepo, commit, fakeDb, git, workflowRun } = require('./catalog_repo');

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

const exists = (dir, file) => fs.existsSync(path.join(dir, file));
const fileOf = (dir, remoteId) => fs.readFileSync(path.join(dir, catalog.lyricPath(remoteId)), 'utf8');
const lyricsInCommit = dir => git(dir, 'show', '--name-only', '--format=', 'HEAD', '--', 'lyrics');

test('an approved Revision Submission changes only its lyric\'s file', async t => {
  quiet(t);
  const dir = catalogRepo([lyric('lyric-a1'), lyric('lyric-b2')]);
  const before = fileOf(dir, 'lyric-b2');
  const firestore = {
    submissions: {
      'rev-7f3a': approved('rev-7f3a', { revisionOfRemoteId: 'lyric-a1', title: 'Corrected title' })
    }
  };

  const run = await workflowRun(dir, fakeDb(firestore));

  assert.deepEqual(run.update.items.map(item => [item.remoteId, item.title]), [['lyric-a1', 'Corrected title']]);
  assert.ok(!('removed' in run.update));
  assert.equal(lyricsInCommit(dir), 'lyrics/a1/lyric-a1.json');
  assert.deepEqual(JSON.parse(fileOf(dir, 'lyric-a1')), lyric('lyric-a1', { title: 'Corrected title' }));
  assert.equal(fileOf(dir, 'lyric-b2'), before);
  assert.equal(run.message, 'Publish 1 lyric change [skip ci]\n\n- Corrected title: suggested edit');
  assert.deepEqual(run.marks, { submissions: ['rev-7f3a'], withdrawals: [], verifications: [] });
  assert.equal(firestore.submissions['rev-7f3a'].published, true);
  // The manifest names the tree readers have now.
  assert.equal(run.manifest.catalogTree, catalog.treeAt('HEAD', dir));

  assert.equal((await workflowRun(dir, fakeDb(firestore))).update, null);
});

test('the commit names each change by title and kind, never who made it', async t => {
  quiet(t);
  const dir = catalogRepo([lyric('lyric-a1'), lyric('lyric-b2')]);
  const run = await workflowRun(dir, fakeDb({
    submissions: {
      'rev-admin-41': approved('rev-admin-41', {
        revisionOfRemoteId: 'lyric-a1', title: 'Fixed by an Admin', ownerUid: 'admin-uid-3'
      }),
      'rev-reader-77': approved('rev-reader-77', {
        revisionOfRemoteId: 'lyric-b2', title: 'Suggested by a reader', contributorEmail: 'poet@example.com'
      }),
      'web-c3': approved('web-c3', { title: 'A new lyric', ownerUid: 'poet-uid-5' })
    }
  }));

  assert.equal(run.message, [
    'Publish 3 lyric changes [skip ci]',
    '',
    '- Fixed by an Admin: admin edit',
    '- Suggested by a reader: suggested edit',
    '- A new lyric: new'
  ].join('\n'));
  for (const secret of ['reader-uid-9', 'admin-uid-3', 'poet-uid-5', 'poet@example.com', 'rev-admin-41', 'rev-reader-77']) {
    assert.ok(!run.message.includes(secret), `commit message contains ${secret}`);
    assert.ok(!run.text.includes(secret), `update file contains ${secret}`);
    assert.ok(!fileOf(dir, 'lyric-a1').includes(secret), `lyric file contains ${secret}`);
  }
});

test('a Withdrawal deletes the file; a restore with no approval brings back its last version', async t => {
  quiet(t);
  const bundled = lyric('lyric-b2', { title: 'Bundled', subcategory: 'Hazrat Abbas (a.s)', group: 2007 });
  const dir = catalogRepo([lyric('lyric-a1'), bundled]);
  const firestore = {
    catalogWithdrawals: { 'lyric-b2': { withdrawn: true, updatedBy: 'owner-uid', updatedAt: at(4000) } }
  };

  const withdrawal = await workflowRun(dir, fakeDb(firestore));

  assert.ok(!exists(dir, catalog.lyricPath('lyric-b2')));
  assert.deepEqual(withdrawal.update, { items: [], removed: ['lyric-b2'] });
  assert.equal(withdrawal.message, 'Publish 1 lyric change [skip ci]\n\n- Bundled: withdrawal');
  assert.deepEqual(withdrawal.marks, { submissions: [], withdrawals: [{ remoteId: 'lyric-b2', updatedAt: 4000 }], verifications: [] });
  assert.equal(firestore.catalogWithdrawals['lyric-b2'].publishedAt.toMillis(), 4000);
  assert.equal((await workflowRun(dir, fakeDb(firestore))).update, null);

  // The website replaces the decision doc, so the restore has no publishedAt.
  firestore.catalogWithdrawals['lyric-b2'] = { withdrawn: false, updatedBy: 'owner-uid', updatedAt: at(6000) };
  const restore = await workflowRun(dir, fakeDb(firestore));

  assert.equal(fileOf(dir, 'lyric-b2'), catalog.serialize(bundled));
  assert.deepEqual(restore.update, { items: [toUpdateItem(bundled)] });
  assert.equal(restore.message, 'Publish 1 lyric change [skip ci]\n\n- Bundled: restore');
  assert.deepEqual(restore.marks.withdrawals, [{ remoteId: 'lyric-b2', updatedAt: 6000 }]);
  assert.equal((await workflowRun(dir, fakeDb(firestore))).update, null);
});

test('the Owner\'s commits to lyrics/ are published, after this run\'s approvals', async t => {
  quiet(t);
  const dir = catalogRepo([lyric('lyric-a1'), lyric('lyric-b2')]);
  // Straight to lyrics/, nothing in Firestore. Deleting a file is refused by
  // the pull request check, but the sync still sends it as removed.
  catalog.writeLyric(lyric('lyric-a1', { author: 'Mir Anees' }), dir);
  catalog.writeLyric(lyric('lyric-c3'), dir);
  catalog.deleteLyric('lyric-b2', dir);
  commit(dir, 'Owner edits');

  const run = await workflowRun(dir, fakeDb({
    submissions: { 'web-zz': approved('web-zz', { title: 'Approved this run' }) }
  }));

  assert.deepEqual(run.update.items.map(item => item.remoteId), ['web-zz', 'lyric-c3', 'lyric-a1']);
  assert.equal(run.update.items[2].author, 'Mir Anees');
  assert.deepEqual(run.update.removed, ['lyric-b2']);
  assert.equal(run.message, [
    'Publish 4 lyric changes [skip ci]',
    '',
    '- Approved this run: new',
    '- Title of lyric-c3: new',
    '- Title of lyric-a1: Owner edit',
    '- Title of lyric-b2: removed'
  ].join('\n'));
  // The index is regenerated from the Catalog.
  assert.match(fs.readFileSync(path.join(dir, 'index', 'Nohay.md'), 'utf8'), /^# Nohay\n\n3 lyrics\./);
});

test('a run where nothing changed writes no update', async t => {
  quiet(t);
  const dir = catalogRepo([lyric('lyric-a1')]);
  const manifest = fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8');

  const run = await workflowRun(dir, fakeDb({
    submissions: { 'lyric-a1': approved('lyric-a1', { title: 'Title of lyric-a1', published: true }) }
  }));

  assert.deepEqual(run, { marks: null, update: null });
  for (const file of ['output', 'commit_message.txt', 'publish_marks.json']) {
    assert.ok(!exists(dir, file), `${file} was written`);
  }
  assert.equal(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'), manifest);
  assert.equal(git(dir, 'status', '--porcelain'), '');
});

test('an invalid lyric file stops the run before anything is published or marked', async t => {
  quiet(t);
  const dir = catalogRepo([lyric('lyric-a1')]);
  catalog.writeLyric(lyric('lyric-a1', { group: 3000 }), dir);
  commit(dir, 'Owner edit with a typo');
  const firestore = { submissions: { 'web-c3': approved('web-c3') } };

  await assert.rejects(workflowRun(dir, fakeDb(firestore)),
    /Invalid lyric files, nothing published:\nlyrics\/a1\/lyric-a1\.json: group must be a release year/);

  assert.ok(!exists(dir, 'output'));
  assert.ok(!exists(dir, 'publish_marks.json'));
  assert.equal(firestore.submissions['web-c3'].published, false);
});

test('a lyric file that isn\'t JSON stops the run, naming the file', async t => {
  quiet(t);
  const dir = catalogRepo([lyric('lyric-a1')]);
  fs.writeFileSync(path.join(dir, catalog.lyricPath('lyric-a1')), '{ "remoteId": "lyric-a1",');
  commit(dir, 'Owner edit cut short');

  await assert.rejects(workflowRun(dir, fakeDb({})),
    /Invalid lyric files, nothing published:\nlyrics\/a1\/lyric-a1\.json: not valid JSON/);
  assert.ok(!exists(dir, 'output'));
});

test('an approval whose record breaks the rules is held, neither written nor marked', async t => {
  const warn = quiet(t);
  const dir = catalogRepo([lyric('lyric-a1')]);
  const firestore = {
    submissions: {
      'web-bad': approved('web-bad', { group: 3000 }),
      'web-good': approved('web-good')
    }
  };

  const run = await workflowRun(dir, fakeDb(firestore));

  assert.deepEqual(run.update.items.map(item => item.remoteId), ['web-good']);
  assert.ok(!exists(dir, catalog.lyricPath('web-bad')));
  assert.deepEqual(run.marks.submissions, ['web-good']);
  assert.equal(firestore.submissions['web-bad'].published, false);
  assert.match(warn.mock.calls.map(call => call.arguments.join(' ')).join('\n'),
    /Approval of web-bad held, not published: group must be a release year/);
});

test('from contract 1.0.0 the update carries the Catalog records themselves', async t => {
  quiet(t);
  const dir = catalogRepo([lyric('lyric-a1'), lyric('lyric-b2')], { contractVersion: '1.0.0' });

  const run = await workflowRun(dir, fakeDb({
    submissions: {
      'rev-1': approved('rev-1', { revisionOfRemoteId: 'lyric-a1', title: 'Corrected', group: 2019 })
    },
    catalogWithdrawals: { 'lyric-b2': { withdrawn: true, updatedAt: at(4000) } }
  }));

  assert.deepEqual(run.update, {
    contractVersion: '1.0.0',
    items: [lyric('lyric-a1', { title: 'Corrected', group: 2019 })],
    removed: ['lyric-b2']
  });
  assert.equal(run.text.includes('published'), false);
  assert.equal(run.manifest.contractVersion, '1.0.0');
});
