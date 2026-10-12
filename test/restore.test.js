const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  loadBaseCatalog,
  pendingRestores,
  planUpdate,
  publishedState
} = require('../scripts/sync_firestore_to_github');

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

// What readers have after a withdrawal of `remoteId` went out.
const withdrawnState = (remoteId, item) => new Map([[remoteId, { item, removed: true }]]);

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

test('a restore sends the newest approved version and marks what was held', () => {
  const plan = planUpdate({
    submissions: [
      approved('lyric-1', { title: 'Original' }),
      approved('rev-1', { title: 'Revised', revisionOfRemoteId: 'lyric-1', published: false, approvedAt: at(5000) })
    ],
    decisions: [decision('lyric-1', false, 6000)],
    published: withdrawnState('lyric-1', { remoteId: 'lyric-1', title: 'Original', body: 'Pehli line' })
  });

  assert.deepEqual(plan.items.map(i => [i.remoteId, i.title]), [['lyric-1', 'Revised']]);
  assert.deepEqual(plan.submissionIds, ['rev-1']);
  assert.deepEqual(plan.decisions, [{ remoteId: 'lyric-1', updatedAt: 6000 }]);
  assert.deepEqual(plan.removed, []);
  assert.deepEqual(plan.unresolved, []);
});

test('without a submission, a restore sends the item last published, minus fields outside the update format', () => {
  const plan = planUpdate({
    submissions: [],
    decisions: [decision('old-1', false, 6000)],
    published: withdrawnState('old-1', {
      remoteId: 'old-1', title: 'Old', body: 'Body', category: 'Nohay',
      subcategory: 'General', group: 'General', createdBy: 'device-55aa', source: 'firestore'
    })
  });

  assert.deepEqual(plan.items, [{
    remoteId: 'old-1', title: 'Old', body: 'Body', category: 'Nohay',
    subcategory: 'General', group: 'General', source: 'firestore'
  }]);
  assert.deepEqual(plan.decisions, [{ remoteId: 'old-1', updatedAt: 6000 }]);
});

test('a restored base catalog lyric is sent from the base catalog', () => {
  const input = {
    submissions: [],
    decisions: [decision('local_abc', false, 6000)],
    published: withdrawnState('local_abc', undefined)
  };

  // The base catalog is read only when a restore needs it.
  const first = planUpdate(input);
  assert.deepEqual(first.items, []);
  assert.deepEqual(first.decisions, []);
  assert.deepEqual(first.unresolved, ['local_abc']);

  const plan = planUpdate({
    ...input,
    base: new Map([['local_abc', {
      remoteId: 'local_abc', isVerified: false, title: 'Bundled', body: 'Line',
      category: 'Manqabat', subcategory: 'Qataat', group: '2007',
      createdBy: 'publisher_tool', source: 'local', pageTitle: 'p. 12'
    }]])
  });
  assert.deepEqual(plan.items, [{
    remoteId: 'local_abc', title: 'Bundled', body: 'Line', category: 'Manqabat',
    subcategory: 'Qataat', group: '2007', isVerified: false, source: 'local'
  }]);
  assert.deepEqual(plan.decisions, [{ remoteId: 'local_abc', updatedAt: 6000 }]);
  assert.deepEqual(plan.unresolved, []);
});

test('a restore that can\'t be found anywhere stays pending', () => {
  const plan = planUpdate({
    submissions: [],
    decisions: [decision('missing', false, 6000)],
    published: withdrawnState('missing', undefined),
    base: new Map()
  });
  assert.deepEqual(plan.items, []);
  assert.deepEqual(plan.decisions, []);
  assert.deepEqual(plan.unresolved, ['missing']);
});

test('a restore of a withdrawal that never went out sends nothing', () => {
  for (const published of [new Map(), new Map([['lyric-1', { item: { remoteId: 'lyric-1' }, removed: false }]])]) {
    const plan = planUpdate({
      submissions: [approved('lyric-1')],
      decisions: [decision('lyric-1', false, 5000)],
      published
    });
    assert.deepEqual(plan.items, []);
    assert.deepEqual(plan.unresolved, []);
    assert.deepEqual(plan.decisions, [{ remoteId: 'lyric-1', updatedAt: 5000 }]);
  }
});

test('a published restore is not sent again', () => {
  const plan = planUpdate({
    submissions: [approved('lyric-1')],
    decisions: [decision('lyric-1', false, 6000, 6000)],
    published: withdrawnState('lyric-1', { remoteId: 'lyric-1', title: 'Ya Abbas' })
  });
  assert.deepEqual(plan.items, []);
  assert.deepEqual(plan.decisions, []);
});

test('the published state replays the updates in manifest order, removals after items', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'published-'));
  const write = (name, update) => fs.writeFileSync(path.join(dir, name), JSON.stringify(update));
  write('u1.json', { items: [{ remoteId: 'a', title: 'A1' }, { remoteId: 'b', title: 'B' }] });
  write('u2.json', { items: [{ remoteId: 'a', title: 'A2' }], removed: ['a', 'local_x'] });
  write('u3.json', { items: [{ remoteId: 'local_x', title: 'X' }] });

  const state = publishedState({ updates: [{ assetName: 'u1.json' }, { assetName: 'u2.json' }, { assetName: 'u3.json' }] }, dir);

  assert.deepEqual(state.get('a'), { item: { remoteId: 'a', title: 'A2' }, removed: true });
  assert.deepEqual(state.get('b'), { item: { remoteId: 'b', title: 'B' }, removed: false });
  assert.deepEqual(state.get('local_x'), { item: { remoteId: 'local_x', title: 'X' }, removed: false });
});

test('the published state of this repository reads every listed update', () => {
  const root = path.join(__dirname, '..');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  const state = publishedState(manifest);
  assert.ok(state.size > 0);
  for (const [remoteId, { item }] of state) {
    if (item) assert.equal(item.remoteId, remoteId);
  }
});

test('the base catalog can come from a local file', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'base-')), 'lyrics.json');
  fs.writeFileSync(file, JSON.stringify({ items: [{ remoteId: 'local_abc', title: 'Bundled' }], generatedAt: 'x' }));
  const base = await loadBaseCatalog(file);
  assert.deepEqual([...base.keys()], ['local_abc']);
});
