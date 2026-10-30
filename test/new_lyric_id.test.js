// A Submission without revisionOfRemoteId adds a new lyric under its own ID;
// only a Revision Submission changes a Published Lyric.
const test = require('node:test');
const assert = require('node:assert/strict');

const { execFileSync } = require('child_process');

const catalog = require('../scripts/catalog');
const { planUpdate } = require('../scripts/sync_firestore_to_github');
const { catalogRepo, commit, git } = require('./catalog_repo');

const at = ms => ({ toMillis: () => ms });

const approved = (id, fields = {}) => ({
  id,
  data: {
    title: 'New title',
    body: 'New body',
    language: 'Roman Urdu',
    categories: ['Nohay'],
    anjumans: [],
    status: 'approved',
    published: false,
    isVerified: false,
    ownerUid: 'web-uid',
    approvedBy: 'admin-uid',
    createdAt: at(5000),
    approvedAt: at(6000),
    ...fields
  }
});

const lyric = (remoteId, fields = {}) => ({
  remoteId,
  title: 'Ya Abbas',
  body: 'Pehli line',
  language: 'Roman Urdu',
  categories: ['Nohay'],
  anjumans: [],
  verified: true,
  ...fields
});

const reason = 'a Published Lyric has this ID; send a change to it as a revision';
// Every lyric below came into the Catalog at 3000.
const firstAdded = () => 3000;

test('a new-lyric approval created after a lyric with its ID came into the Catalog is held', () => {
  const id = 'local_1526922376d907ec4c5f5c4d701ee200';
  const plan = planUpdate({
    submissions: [approved(id), approved('web-new')],
    decisions: [],
    lyrics: new Map([[id, lyric(id)]]),
    firstAdded: remoteId => (remoteId === id ? 3000 : null)
  });

  assert.deepEqual([...plan.writes.keys()], ['web-new']);
  assert.deepEqual(plan.submissionIds, ['web-new']);
  assert.deepEqual(plan.held, [{ remoteId: id, id, problem: reason }]);
});

test('a Revision Submission of that lyric still publishes, beside a held new-lyric approval', () => {
  const plan = planUpdate({
    submissions: [
      approved('lyric-1', { approvedAt: at(9000) }),
      approved('rev-1', { title: 'Corrected', body: 'Pehli line', revisionOfRemoteId: 'lyric-1' })
    ],
    decisions: [],
    lyrics: new Map([['lyric-1', lyric('lyric-1')]]),
    firstAdded
  });

  assert.equal(plan.writes.get('lyric-1').record.title, 'Corrected');
  assert.equal(plan.writes.get('lyric-1').kind, 'suggested edit');
  assert.deepEqual(plan.submissionIds, ['rev-1']);
  assert.deepEqual(plan.held.map(({ id }) => id), ['lyric-1']);
});

test('a new-lyric approval with the ID of a withdrawn lyric is held, and its restore brings back the last version', () => {
  const last = lyric('lyric-1');
  const plan = planUpdate({
    submissions: [approved('lyric-1')],
    decisions: [{ id: 'lyric-1', data: { withdrawn: false, updatedAt: at(7000), updatedBy: 'owner-uid' } }],
    lyrics: new Map(),
    lastVersion: remoteId => (remoteId === 'lyric-1' ? last : null),
    firstAdded
  });

  assert.deepEqual(plan.writes.get('lyric-1'), { record: last, kind: 'restore' });
  assert.deepEqual(plan.submissionIds, []);
  assert.deepEqual(plan.held.map(({ id }) => id), ['lyric-1']);
});

// Rejected, edited and approved again during the run that published it, or
// published by a run that failed before marking it.
test('the submission a lyric was published from still goes out while unpublished', () => {
  const plan = planUpdate({
    submissions: [approved('web-1', { title: 'Second version', createdAt: at(1000) })],
    decisions: [],
    lyrics: new Map([['web-1', lyric('web-1', { title: 'First version' })]]),
    firstAdded
  });

  assert.deepEqual(plan.held, []);
  assert.deepEqual(plan.submissionIds, ['web-1']);
  assert.equal(plan.writes.get('web-1').record.title, 'Second version');
});

test('a lyric\'s file first came into the Catalog with its oldest adding commit', () => {
  const dir = catalogRepo([lyric('lyric-a1')]);
  const first = Number(git(dir, 'log', '-1', '--format=%ct')) * 1000;
  catalog.deleteLyric('lyric-a1', dir);
  commit(dir, 'Withdraw lyric-a1');
  catalog.writeLyric(lyric('lyric-a1'), dir);
  git(dir, 'add', '-A');
  execFileSync('git', ['commit', '-q', '-m', 'Restore lyric-a1'],
    { cwd: dir, env: { ...process.env, GIT_COMMITTER_DATE: '2030-01-01T00:00:00Z' } });

  assert.equal(catalog.firstAdded('lyric-a1', dir), first);
  assert.equal(catalog.firstAdded('never-had-a-file', dir), null);
});
