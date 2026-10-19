const test = require('node:test');
const assert = require('node:assert/strict');

const { pendingRestores, planUpdate } = require('../scripts/sync_firestore_to_github');

const at = ms => ({ toMillis: () => ms });

// A catalogWithdrawals doc as the website writes it (a set, so a change
// drops publishedAt), optionally already published.
const decision = (id, withdrawn, updatedAt, publishedAt) => ({
  id,
  data: {
    withdrawn,
    updatedBy: 'owner-uid',
    updatedAt: at(updatedAt),
    ...(publishedAt === undefined ? {} : { publishedAt: at(publishedAt) })
  }
});

const approved = (id, fields = {}) => ({
  id,
  data: {
    title: 'Ya Abbas',
    body: 'Pehli line',
    categories: ['Nohay'],
    status: 'approved',
    published: true,
    isVerified: false,
    ownerUid: 'web-uid',
    termsVersion: 'dev-draft',
    approvedAt: at(1000),
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
  verified: false,
  ...fields
});

// A run after the withdrawal went out: the lyric's file is gone, and git
// history has `last`, its version before the withdrawal deleted it.
const restoreRun = ({ submissions = [], decisions, verifications = [], last = null }) => planUpdate({
  submissions,
  decisions,
  verifications,
  lyrics: new Map(),
  lastVersion: remoteId => (last?.remoteId === remoteId ? last : null)
});

test('restores go out until published, and again after a change', () => {
  assert.deepEqual(pendingRestores([
    decision('never-published', false, 1000),
    decision('published', false, 1000, 1000),
    decision('changed-since', false, 3000, 1000),
    decision('a-withdrawal', true, 1000)
  ]), [
    { remoteId: 'never-published', updatedAt: 1000 },
    { remoteId: 'changed-since', updatedAt: 3000 }
  ]);
});

test('a restore writes the revision held while the lyric was withdrawn, and marks it', () => {
  const plan = restoreRun({
    submissions: [
      approved('lyric-1', { title: 'Original' }),
      approved('rev-1', { title: 'Revised', revisionOfRemoteId: 'lyric-1', published: false, approvedAt: at(5000) })
    ],
    decisions: [decision('lyric-1', false, 6000)],
    last: lyric('lyric-1', { title: 'Original' })
  });

  assert.equal(plan.writes.get('lyric-1').record.title, 'Revised');
  assert.deepEqual(plan.submissionIds, ['rev-1']);
  assert.deepEqual(plan.decisions, [{ remoteId: 'lyric-1', updatedAt: 6000 }]);
  assert.equal(plan.deletes.size, 0);
  assert.deepEqual(plan.unresolved, []);
});

test('a restore from a held revision is named a restore in the history', () => {
  const plan = restoreRun({
    submissions: [approved('rev-1', { revisionOfRemoteId: 'lyric-1', published: false, approvedAt: at(5000) })],
    decisions: [decision('lyric-1', false, 6000)],
    last: lyric('lyric-1')
  });
  assert.equal(plan.writes.get('lyric-1').kind, 'restore');
});

test('with no revision held, a restore writes the lyric\'s last file, the Owner\'s edits and all', () => {
  const last = lyric('lyric-1', { author: 'Added by the Owner' });
  const plan = restoreRun({
    submissions: [approved('lyric-1')],
    decisions: [decision('lyric-1', false, 6000)],
    last
  });

  assert.deepEqual([...plan.writes], [['lyric-1', { record: last, kind: 'restore' }]]);
  assert.deepEqual(plan.submissionIds, []);
  assert.deepEqual(plan.decisions, [{ remoteId: 'lyric-1', updatedAt: 6000 }]);
});

test('a restore from git history carries a Verify made while withdrawn', () => {
  const plan = restoreRun({
    submissions: [approved('lyric-1')],
    decisions: [decision('lyric-1', false, 6000)],
    verifications: [{ id: 'lyric-1', data: { verified: true, updatedAt: at(5000) } }],
    last: lyric('lyric-1')
  });
  assert.deepEqual(plan.writes.get('lyric-1'), { record: lyric('lyric-1', { verified: true }), kind: 'restore' });
  assert.deepEqual(plan.verifications.map(({ remoteId }) => remoteId), ['lyric-1']);
});

test('a lyric that never had a file is restored from its newest approved version', () => {
  const plan = restoreRun({
    submissions: [
      approved('lyric-1', { title: 'Original' }),
      approved('rev-1', { title: 'Revised', revisionOfRemoteId: 'lyric-1', approvedAt: at(5000) })
    ],
    decisions: [decision('lyric-1', false, 6000)]
  });

  assert.deepEqual([...plan.writes].map(([id, { record, kind }]) => [id, record.title, kind]), [
    ['lyric-1', 'Revised', 'restore']
  ]);
  assert.deepEqual(plan.submissionIds, []);
});

test('a restore that can\'t be found anywhere stays pending', () => {
  const plan = restoreRun({ decisions: [decision('missing', false, 6000)] });
  assert.equal(plan.writes.size, 0);
  assert.deepEqual(plan.decisions, []);
  assert.deepEqual(plan.unresolved, ['missing']);
});

test('a restore of a withdrawal that never went out writes nothing', () => {
  const plan = planUpdate({
    submissions: [approved('lyric-1')],
    decisions: [decision('lyric-1', false, 5000)],
    lyrics: new Map([['lyric-1', lyric('lyric-1')]])
  });
  assert.equal(plan.writes.size, 0);
  assert.deepEqual(plan.unresolved, []);
  assert.deepEqual(plan.decisions, [{ remoteId: 'lyric-1', updatedAt: 5000 }]);
});

test('a published restore is not sent again', () => {
  const plan = restoreRun({
    submissions: [approved('lyric-1')],
    decisions: [decision('lyric-1', false, 6000, 6000)],
    last: lyric('lyric-1')
  });
  assert.equal(plan.writes.size, 0);
  assert.deepEqual(plan.decisions, []);
});
