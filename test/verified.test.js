const test = require('node:test');
const assert = require('node:assert/strict');

const { planUpdate } = require('../scripts/sync_firestore_to_github');

const at = ms => ({ toMillis: () => ms });

const approved = (id, fields = {}) => ({
  id,
  data: {
    title: 'Ya Abbas',
    body: 'Pehli line',
    categories: ['Nohay'],
    status: 'approved',
    published: true,
    isVerified: false,
    approvedAt: at(1000),
    ...fields
  }
});

// A catalogVerifications doc as the phone writes it, with the updateTime
// the sync read.
const verification = (remoteId, verified, updatedAt = 2000) => ({
  id: remoteId,
  data: { verified, updatedBy: 'admin-uid', updatedAt: at(updatedAt) },
  updateTime: { seconds: updatedAt / 1000, nanoseconds: 0 }
});

// The Catalog: each lyric's file.
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
const catalog = (...records) => new Map(records.map(record => [record.remoteId, record]));

const plan = ({ submissions = [], verifications = [], lyrics, decisions = [] }) =>
  planUpdate({ submissions, decisions, verifications, lyrics });
const marked = ({ verifications }) => verifications.map(({ remoteId }) => remoteId);

test('Verify of a Base Catalog lyric changes only its flag, and is marked', () => {
  // No submission has it; the Owner added the poet in the file.
  const result = plan({
    verifications: [verification('base-6', true)],
    lyrics: catalog(lyric('base-6', { author: 'Mir Anees' }))
  });
  assert.deepEqual([...result.writes], [
    ['base-6', { record: lyric('base-6', { author: 'Mir Anees', verified: true }), kind: 'verified' }]
  ]);
  assert.deepEqual(result.verifications, [{ remoteId: 'base-6', updateTime: { seconds: 2, nanoseconds: 0 } }]);
  assert.deepEqual(result.submissionIds, []);
});

test('Unverify does too', () => {
  const { writes } = plan({
    verifications: [verification('base-6', false)],
    lyrics: catalog(lyric('base-6', { verified: true }))
  });
  assert.deepEqual([...writes], [['base-6', { record: lyric('base-6'), kind: 'unverified' }]]);
});

test('a Verify the Catalog already has writes nothing and is still marked', () => {
  const result = plan({
    verifications: [verification('base-6', true)],
    lyrics: catalog(lyric('base-6', { verified: true }))
  });
  assert.equal(result.writes.size, 0);
  assert.deepEqual(marked(result), ['base-6']);
});

test('Verify of a lyric with a published revision applies to the Catalog\'s text', () => {
  const result = plan({
    submissions: [
      approved('lyric-1', { title: 'Original', approvedAt: at(1000) }),
      approved('rev-1', { title: 'Revised', revisionOfRemoteId: 'lyric-1', approvedAt: at(1500) })
    ],
    verifications: [verification('lyric-1', true, 2000)],
    lyrics: catalog(lyric('lyric-1', { title: 'Revised' }))
  });
  assert.deepEqual([...result.writes], [
    ['lyric-1', { record: lyric('lyric-1', { title: 'Revised', verified: true }), kind: 'verified' }]
  ]);
});

test('the later of a Verify and an approval wins', () => {
  // The approval after the Verify decides the flag; the Verify is marked.
  const revisedLater = plan({
    submissions: [approved('rev-1', { title: 'Revised', revisionOfRemoteId: 'lyric-1', published: false, approvedAt: at(3000) })],
    verifications: [verification('lyric-1', true, 2000)],
    lyrics: catalog(lyric('lyric-1'))
  });
  assert.equal(revisedLater.writes.get('lyric-1').record.verified, false);
  assert.equal(revisedLater.writes.get('lyric-1').kind, 'suggested edit');
  assert.deepEqual(marked(revisedLater), ['lyric-1']);

  // The Verify after the approval goes on top of the new text.
  const verifiedLater = plan({
    submissions: [approved('rev-1', { title: 'Revised', revisionOfRemoteId: 'lyric-1', published: false, approvedAt: at(1500) })],
    verifications: [verification('lyric-1', true, 2000)],
    lyrics: catalog(lyric('lyric-1'))
  });
  assert.deepEqual(verifiedLater.writes.get('lyric-1'), {
    record: lyric('lyric-1', { title: 'Revised', verified: true }),
    kind: 'suggested edit'
  });
});

test('a Verify of a withdrawn lyric waits, unmarked', () => {
  const result = plan({
    verifications: [verification('web-6', true)],
    lyrics: catalog(lyric('web-6')),
    decisions: [{ id: 'web-6', data: { withdrawn: true, updatedAt: at(3000) } }]
  });
  assert.equal(result.writes.size, 0);
  assert.deepEqual([...result.deletes.keys()], ['web-6']);
  assert.deepEqual(marked(result), []);
});

test('a Verify of a lyric the Catalog doesn\'t have waits, unmarked', () => {
  const result = plan({ verifications: [verification('unknown', true)], lyrics: new Map() });
  assert.equal(result.writes.size, 0);
  assert.deepEqual(marked(result), []);
});

test('an edit that keeps the title and body keeps the Catalog\'s Verified', () => {
  // A Revision Submission starts unverified; this one only adds the poet.
  const { writes } = plan({
    submissions: [approved('rev-1', { revisionOfRemoteId: 'lyric-1', author: 'Mir Anees', published: false })],
    lyrics: catalog(lyric('lyric-1', { verified: true }))
  });
  assert.deepEqual(writes.get('lyric-1').record, lyric('lyric-1', { author: 'Mir Anees', verified: true }));
});

test('an edit that changes the text brings its own flag', () => {
  const unverified = plan({
    submissions: [approved('rev-1', { revisionOfRemoteId: 'lyric-1', body: 'Doosri line', published: false })],
    lyrics: catalog(lyric('lyric-1', { verified: true }))
  });
  assert.equal(unverified.writes.get('lyric-1').record.verified, false);

  // Verified in the review queue before its approval.
  const verified = plan({
    submissions: [approved('rev-1', { revisionOfRemoteId: 'lyric-1', body: 'Doosri line', isVerified: true, published: false })],
    lyrics: catalog(lyric('lyric-1'))
  });
  assert.equal(verified.writes.get('lyric-1').record.verified, true);
});

const styling = [{ insert: 'Pehli line' }, { insert: '\n', attributes: { align: 'right' } }];

test('Verify keeps the lyric\'s Styling', () => {
  const { writes } = plan({
    verifications: [verification('base-6', true)],
    lyrics: catalog(lyric('base-6', { styling }))
  });
  assert.deepEqual(writes.get('base-6').record, lyric('base-6', { styling, verified: true }));
});

test('an approval that changes only the Styling is written and keeps Verified', () => {
  const { writes } = plan({
    submissions: [approved('rev-1', {
      revisionOfRemoteId: 'lyric-1', contentDelta: JSON.stringify(styling), published: false
    })],
    lyrics: catalog(lyric('lyric-1', { verified: true }))
  });
  assert.deepEqual(writes.get('lyric-1').record, lyric('lyric-1', { styling, verified: true }));
});

test('Verify on a published submission no longer changes the Catalog', () => {
  assert.equal(plan({
    submissions: [approved('web-6', { isVerified: true })],
    lyrics: catalog(lyric('web-6'))
  }).writes.size, 0);
});
