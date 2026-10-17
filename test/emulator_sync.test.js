// The real sync script against the Firestore emulator, run the way the
// workflow runs it: sync, commit the Catalog and the update, then
// --mark-published. Each test checks the update files a website submission,
// revision, Verify change or Owner withdrawal or restore turns into.
//
//   firebase emulators:exec --only firestore --project demo-kanz-e-aza "npm test"
// or, with an emulator already running:
//   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 npm test
//
// Without FIRESTORE_EMULATOR_HOST these tests are skipped, so the workflow's
// `npm test` step needs no emulator. The service account is a key generated
// here for the demo- project; it only ever lives in the child's environment.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const catalog = require('../scripts/catalog');
const { catalogRepo, commit, git } = require('./catalog_repo');

const host = process.env.FIRESTORE_EMULATOR_HOST;
const projectId = 'demo-kanz-e-aza';
const skip = host ? false : 'needs FIRESTORE_EMULATOR_HOST (Firestore emulator)';

let db;
let Timestamp;
if (host) {
  const admin = require('firebase-admin');
  const app = admin.initializeApp({ projectId }, 'emulator-sync-test');
  db = app.firestore();
  Timestamp = admin.firestore.Timestamp;
}

const at = ms => Timestamp.fromMillis(ms);

function throwawayServiceAccount() {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const key = {
    type: 'service_account',
    project_id: projectId,
    private_key_id: 'local-test',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    client_email: `sync-test@${projectId}.iam.gserviceaccount.com`,
    client_id: '0'
  };
  return Buffer.from(JSON.stringify(key)).toString('base64');
}

const serviceAccount = host ? throwawayServiceAccount() : '';

async function clearFirestore() {
  const res = await fetch(
    `http://${host}/emulator/v1/projects/${projectId}/databases/(default)/documents`,
    { method: 'DELETE' }
  );
  assert.ok(res.ok, `clearing the emulator: ${res.status}`);
}

// A lyric every reader already has, so lyrics/ is never empty.
const alreadyPublished = {
  remoteId: 'base-1',
  title: 'Already published',
  body: 'Pehli line',
  language: 'Roman Urdu',
  categories: ['Nohay'],
  anjumans: [],
  verified: false
};

// A git checkout of this repository whose Catalog holds `lyrics`, which
// readers already have; each run commits to it as the workflow does.
const checkout = ({ lyrics = [] } = {}) =>
  ({ dir: catalogRepo([alreadyPublished, ...lyrics]), runs: 0, published: [] });

const lyricFile = (repo, remoteId) => path.join(repo.dir, catalog.lyricPath(remoteId));

function node(repo, args) {
  const env = { ...process.env };
  delete env.GOOGLE_APPLICATION_CREDENTIALS;
  delete env.ONLY_IF_ADMIN_EDIT;
  Object.assign(env, {
    FIRESTORE_EMULATOR_HOST: host,
    FIREBASE_SERVICE_ACCOUNT: serviceAccount,
    RELEASE_TAG: `v1.0.${repo.runs}-test`,
    NODE_PATH: [path.join(__dirname, '../node_modules'), process.env.NODE_PATH]
      .filter(Boolean).join(path.delimiter)
  });
  const result = spawnSync(process.execPath, args, { cwd: repo.dir, env, encoding: 'utf8' });
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result;
}

// One workflow run: a clean output/, sync, commit lyrics/, index/, the
// manifest and the update file (as "Commit the Catalog and the Update"
// does), then, as the last step, mark whatever the sync left marks for.
// Returns the update file it published, or null.
function workflowRun(repo, { mark = true } = {}) {
  repo.runs++;
  for (const leftover of ['output', 'publish_marks.json', 'commit_message.txt']) {
    fs.rmSync(path.join(repo.dir, leftover), { recursive: true, force: true });
  }
  const { stdout, stderr } = node(repo, ['scripts/sync_firestore_to_github.js']);
  const marksFile = path.join(repo.dir, 'publish_marks.json');
  const marks = fs.existsSync(marksFile) ? JSON.parse(fs.readFileSync(marksFile, 'utf8')) : null;
  let run = { stdout, stderr, marks, update: null };
  const output = path.join(repo.dir, 'output');
  if (fs.existsSync(output)) {
    const names = fs.readdirSync(output).filter(name => name.startsWith('update_'));
    assert.equal(names.length, 1);
    const bytes = fs.readFileSync(path.join(output, names[0]));
    fs.mkdirSync(path.join(repo.dir, 'updates'), { recursive: true });
    fs.copyFileSync(path.join(output, names[0]), path.join(repo.dir, 'updates', names[0]));
    git(repo.dir, 'add', 'manifest.json', 'updates', 'lyrics', 'index');
    git(repo.dir, 'commit', '-q', '-F', 'commit_message.txt');
    run = {
      ...run,
      name: names[0],
      bytes,
      text: bytes.toString('utf8'),
      update: JSON.parse(bytes.toString('utf8')),
      manifest: JSON.parse(fs.readFileSync(path.join(output, 'manifest.json'), 'utf8')),
      message: git(repo.dir, 'log', '-1', '--format=%B')
    };
    repo.published.push(run.update);
  }
  if (mark && marks) node(repo, ['scripts/sync_firestore_to_github.js', '--mark-published', 'publish_marks.json']);
  return run;
}

// One update applied the way readers apply it: its items, then the
// remoteIds it removes (ReleaseCatalogService and the app's UpdateService).
// A phone deletes a removed lyric, so only a later item brings it back.
function apply(lyrics, update) {
  for (const item of update.items) lyrics.set(item.remoteId, item);
  for (const id of update.removed ?? []) lyrics.delete(id);
  return lyrics;
}

// What a reader builds from the base catalog plus every update, in order:
// the website on every visit, or a fresh install.
function catalogAfter(repo, base = {}) {
  return repo.published.reduce(apply, new Map(Object.entries(base)));
}

const decisionDoc = async remoteId =>
  (await db.collection('catalogWithdrawals').doc(remoteId).get()).data();

// A submission exactly as the website writes it (WebSubmissionDraft.toFirestore
// plus the repository's timestamps), see firestore_tests/web_submission.json
// in the app repository.
const websiteSubmission = (remoteId, fields = {}) => ({
  remoteId,
  title: 'Ya Abbas',
  body: 'Pehli line\n<<DIVIDER>>\n_Doosri line_',
  language: 'Roman Urdu',
  categories: ['Nohay'],
  subcategory: 'Hazrat Abbas (a.s)',
  group: 2024,
  author: 'Example Poet',
  anjumans: [],
  termsVersion: 'dev-draft',
  ownerUid: 'web-uid',
  status: 'pending',
  published: false,
  isVerified: false,
  isUserSubmission: true,
  createdAt: at(1000),
  lastEdited: at(1000),
  ...fields
});

// FirestoreWebConsoleRepository.approve / reject / setVerified.
const approval = (ms, adminUid = 'admin-uid') => ({
  status: 'approved',
  approvedAt: at(ms),
  approvedBy: adminUid,
  reviewedBy: adminUid,
  adminReviewedAt: at(ms)
});
const rejection = (ms, reason, adminUid = 'admin-uid') => ({
  status: 'rejected',
  rejectedReason: reason,
  rejectedAt: at(ms),
  rejectedBy: adminUid,
  reviewedBy: adminUid,
  adminReviewedAt: at(ms)
});

const submission = id => db.collection('submissions').doc(id);
const put = (id, data) => submission(id).set(data);
const read = async id => (await submission(id).get()).data();
// FirestoreWebConsoleRepository.setWithdrawn: a set, so it replaces the doc.
const withdrawal = (remoteId, withdrawn, ms) =>
  db.collection('catalogWithdrawals').doc(remoteId).set({
    withdrawn,
    updatedBy: 'owner-uid',
    updatedAt: at(ms)
  });

// A bundled lyric as its Catalog file holds it.
const bundled = {
  remoteId: 'base-7',
  title: 'Bundled',
  body: 'Pehli line\n<<DIVIDER>>\nDoosri line',
  language: 'Roman Urdu',
  categories: ['Manqabat'],
  subcategory: 'Qataat',
  group: 2007,
  anjumans: [],
  verified: false
};
// The same lyric as readers had it before any update.
const bundledItem = { remoteId: 'base-7', title: 'Bundled' };

test.beforeEach(async () => {
  if (host) await clearFirestore();
});

test('an approved website lyric is published with its metadata, then marked', { skip }, async () => {
  const repo = checkout();
  await put('web-1', websiteSubmission('web-1', {
    title: 'یا عباس',
    body: 'پہلی لائن\n<<DIVIDER>>\n_دوسری لائن_\n<<MINI>>\nآخری لائن',
    language: 'Urdu',
    categories: ['Nohay', 'Salaams'],
    isVerified: true,
    ...approval(2000)
  }));
  await put('web-pending', websiteSubmission('web-pending', { title: 'Still pending' }));
  await put('web-rejected', websiteSubmission('web-rejected', {
    title: 'Was rejected',
    ...rejection(2000, 'Line 2 is missing')
  }));

  const run = workflowRun(repo, { mark: false });

  assert.deepEqual(run.update, {
    items: [{
      remoteId: 'web-1',
      title: 'یا عباس',
      body: 'پہلی لائن\n<<DIVIDER>>\n_دوسری لائن_\n<<MINI>>\nآخری لائن',
      category: 'Nohay',
      categories: ['Nohay', 'Salaams'],
      subcategory: 'Hazrat Abbas (a.s)',
      group: 2024,
      isVerified: true,
      source: 'firestore',
      author: 'Example Poet',
      language: 'Urdu'
    }]
  });
  // The manifest entry the website checks the downloaded bytes against.
  const entry = run.manifest.updates.at(-1);
  assert.equal(entry.assetName, run.name);
  assert.equal(entry.releaseTag, 'v1.0.1-test');
  assert.equal(run.manifest.latestReleaseTag, 'v1.0.1-test');
  assert.equal(entry.sha256, crypto.createHash('sha256').update(run.bytes).digest('hex'));
  assert.equal(run.manifest.catalogTree, catalog.treeAt('HEAD', repo.dir));
  assert.deepEqual(run.marks, { submissions: ['web-1'], withdrawals: [] });
  assert.ok(!fs.existsSync(path.join(repo.dir, 'output', 'publish_marks.json')));
  assert.equal(run.message, 'Publish 1 lyric change [skip ci]\n\n- یا عباس: new');
  assert.equal(JSON.parse(fs.readFileSync(lyricFile(repo, 'web-1'), 'utf8')).language, 'Urdu');
  // Nothing is marked until the last workflow step.
  assert.equal((await read('web-1')).published, false);

  node(repo, ['scripts/sync_firestore_to_github.js', '--mark-published', 'publish_marks.json']);

  assert.equal((await read('web-1')).published, true);
  assert.equal((await read('web-1')).status, 'approved');
  assert.equal((await read('web-pending')).published, false);
  assert.equal((await read('web-rejected')).published, false);

  const again = workflowRun(repo);
  assert.equal(again.update, null);
  assert.match(again.stdout, /No lyric changed since the last update/);
});

test('the update file, lyric file and commit carry no contributor or review fields', { skip }, async () => {
  const repo = checkout();
  await put('web-2', websiteSubmission('web-2', {
    ...approval(2000, 'admin-7f3a'),
    ownerUid: 'contributor-9c1e',
    termsVersion: 'terms-2026-07',
    contentDelta: '[{"insert":"x"}]',
    adminNote: 'checked by phone',
    deviceUserUuid: 'device-55aa',
    contributorEmail: 'poet@example.com'
  }));

  const run = workflowRun(repo);

  const [item] = run.update.items;
  assert.deepEqual(Object.keys(item).sort(), [
    'author', 'body', 'categories', 'category', 'group', 'isVerified',
    'language', 'remoteId', 'source', 'subcategory', 'title'
  ]);
  const file = fs.readFileSync(lyricFile(repo, 'web-2'), 'utf8');
  for (const secret of [
    'contributor-9c1e', 'admin-7f3a', 'terms-2026-07', 'poet@example.com',
    'device-55aa', 'checked by phone', 'ownerUid', 'termsVersion', '@'
  ]) {
    assert.ok(!run.text.includes(secret), `update file contains ${secret}`);
    assert.ok(!file.includes(secret), `lyric file contains ${secret}`);
    assert.ok(!run.message.includes(secret), `commit message contains ${secret}`);
  }
});

test('a lyric without personality, poet or year publishes the placeholders the app expects', { skip }, async () => {
  const repo = checkout();
  const { subcategory, group, author, ...plain } = websiteSubmission('web-3');
  await put('web-3', { ...plain, ...approval(2000) });

  const [item] = workflowRun(repo).update.items;

  assert.equal(item.subcategory, 'General');
  assert.equal(item.group, 'General');
  assert.ok(!('author' in item));
});

test('a revision replaces the published lyric instead of adding one', { skip }, async () => {
  const repo = checkout();
  await put('lyric-1', websiteSubmission('lyric-1', { title: 'Original', ...approval(2000) }));
  workflowRun(repo);

  await put('rev-1', websiteSubmission('rev-1', {
    title: 'Original (corrected)',
    body: 'Corrected line',
    revisionOfRemoteId: 'lyric-1',
    ownerUid: 'another-contributor',
    ...approval(3000)
  }));
  const run = workflowRun(repo);

  assert.deepEqual(run.update.items.map(i => [i.remoteId, i.title, i.body]), [
    ['lyric-1', 'Original (corrected)', 'Corrected line']
  ]);
  assert.equal(run.message, 'Publish 1 lyric change [skip ci]\n\n- Original (corrected): suggested edit');
  assert.equal((await read('rev-1')).published, true);
  const catalogNow = catalogAfter(repo);
  assert.deepEqual([...catalogNow.keys()], ['lyric-1']);
  assert.equal(catalogNow.get('lyric-1').title, 'Original (corrected)');
});

test('two approved revisions of one lyric: the newest approval wins, both are marked', { skip }, async () => {
  const repo = checkout({ lyrics: [bundled] });
  // Created in the opposite order to their approval.
  await put('rev-b', websiteSubmission('rev-b', {
    title: 'Approved first',
    revisionOfRemoteId: 'base-7',
    createdAt: at(1000),
    ...approval(5000)
  }));
  await put('rev-a', websiteSubmission('rev-a', {
    title: 'Approved last',
    revisionOfRemoteId: 'base-7',
    createdAt: at(2000),
    ...approval(9000)
  }));

  const run = workflowRun(repo);

  assert.deepEqual(run.update.items.map(i => [i.remoteId, i.title]), [['base-7', 'Approved last']]);
  assert.deepEqual(run.marks.submissions.sort(), ['rev-a', 'rev-b']);
  assert.equal((await read('rev-a')).published, true);
  assert.equal((await read('rev-b')).published, true);
  assert.equal(workflowRun(repo).update, null);
});

test('a lyric rejected after approval, before the run, is not published', { skip }, async () => {
  const repo = checkout();
  await put('web-4', websiteSubmission('web-4', { ...approval(2000), ...rejection(3000, 'Wrong poet') }));

  assert.equal(workflowRun(repo).update, null);
  assert.equal((await read('web-4')).published, false);
});

test('an Owner withdrawal is published once and not sent again', { skip }, async () => {
  const repo = checkout({ lyrics: [bundled] });
  await withdrawal('base-7', true, 4000);
  await put('web-5', websiteSubmission('web-5', { title: 'Same run', ...approval(2000) }));

  const run = workflowRun(repo);

  assert.deepEqual(run.update.removed, ['base-7']);
  assert.deepEqual(run.update.items.map(i => i.remoteId), ['web-5']);
  assert.ok(!fs.existsSync(lyricFile(repo, 'base-7')));
  assert.deepEqual(run.marks.withdrawals, [{ remoteId: 'base-7', updatedAt: 4000 }]);
  const marked = await decisionDoc('base-7');
  assert.equal(marked.publishedAt.toMillis(), 4000);
  assert.equal(marked.withdrawn, true);
  assert.ok(!catalogAfter(repo, { 'base-7': bundledItem }).has('base-7'));

  const again = workflowRun(repo);
  assert.equal(again.update, null);
});

test('an Owner restore brings the lyric back from git history', { skip }, async () => {
  const repo = checkout({ lyrics: [bundled] });
  const base = { 'base-7': bundledItem };
  // A phone with the base catalog that applies each update as it comes.
  const phone = new Map(Object.entries(base));
  await withdrawal('base-7', true, 4000);
  apply(phone, workflowRun(repo).update);
  assert.ok(!phone.has('base-7'));
  assert.ok(!catalogAfter(repo, base).has('base-7'));

  await withdrawal('base-7', false, 6000);
  const run = workflowRun(repo);

  assert.notEqual(run.update, null, 'the restore published nothing');
  // The file as it was before the withdrawal, in the update format.
  assert.equal(fs.readFileSync(lyricFile(repo, 'base-7'), 'utf8'), catalog.serialize(bundled));
  assert.deepEqual(run.update, {
    items: [{
      remoteId: 'base-7',
      title: 'Bundled',
      body: 'Pehli line\n<<DIVIDER>>\nDoosri line',
      category: 'Manqabat',
      categories: ['Manqabat'],
      subcategory: 'Qataat',
      group: 2007,
      isVerified: false,
      source: 'firestore',
      language: 'Roman Urdu'
    }]
  });
  assert.equal(run.message, 'Publish 1 lyric change [skip ci]\n\n- Bundled: restore');
  assert.deepEqual(run.marks, { submissions: [], withdrawals: [{ remoteId: 'base-7', updatedAt: 6000 }] });
  apply(phone, run.update);
  assert.equal(phone.get('base-7').title, 'Bundled');
  assert.equal(catalogAfter(repo, base).get('base-7').title, 'Bundled');
  const marked = await decisionDoc('base-7');
  assert.equal(marked.withdrawn, false);
  assert.equal(marked.publishedAt.toMillis(), 6000);

  assert.equal(workflowRun(repo).update, null);

  // Withdrawn again, and that goes out too.
  await withdrawal('base-7', true, 8000);
  assert.deepEqual(workflowRun(repo).update, { items: [], removed: ['base-7'] });
  assert.ok(!catalogAfter(repo, base).has('base-7'));
});

test('a restore sends the newest approved text, with the revision held while withdrawn', { skip }, async () => {
  const repo = checkout();
  await put('lyric-1', websiteSubmission('lyric-1', { title: 'Original', ...approval(2000) }));
  workflowRun(repo);
  await withdrawal('lyric-1', true, 4000);
  workflowRun(repo);
  await put('rev-1', websiteSubmission('rev-1', {
    revisionOfRemoteId: 'lyric-1',
    title: 'Revised',
    body: 'Corrected line',
    ...approval(5000)
  }));
  assert.equal(workflowRun(repo).update, null);

  await withdrawal('lyric-1', false, 6000);
  const run = workflowRun(repo);

  assert.deepEqual(run.update.items.map(i => [i.remoteId, i.title, i.body]), [
    ['lyric-1', 'Revised', 'Corrected line']
  ]);
  assert.ok(!('removed' in run.update));
  assert.deepEqual(run.marks, {
    submissions: ['rev-1'],
    withdrawals: [{ remoteId: 'lyric-1', updatedAt: 6000 }]
  });
  assert.equal((await read('rev-1')).published, true);
  assert.equal(catalogAfter(repo).get('lyric-1').title, 'Revised');
  assert.equal(workflowRun(repo).update, null);
});

test('a lyric withdrawn and restored between runs publishes nothing, and both are marked', { skip }, async () => {
  const repo = checkout();
  await put('lyric-1', websiteSubmission('lyric-1', { title: 'Original', ...approval(2000) }));
  workflowRun(repo);
  await withdrawal('lyric-1', true, 4000);
  await withdrawal('lyric-1', false, 5000);

  const run = workflowRun(repo);
  assert.equal(run.update, null);
  assert.deepEqual(run.marks.withdrawals, [{ remoteId: 'lyric-1', updatedAt: 5000 }]);
  assert.equal((await decisionDoc('lyric-1')).publishedAt.toMillis(), 5000);
  assert.equal(catalogAfter(repo).get('lyric-1').title, 'Original');
});

test('a restore the sync cannot find stays pending until it can', { skip }, async () => {
  const repo = checkout();
  // Withdrawn before the Catalog ever had it: nothing to delete, still marked.
  await withdrawal('base-7', true, 4000);
  assert.equal(workflowRun(repo).update, null);
  assert.equal((await decisionDoc('base-7')).publishedAt.toMillis(), 4000);
  await withdrawal('base-7', false, 6000);

  // Not in Firestore, the Catalog or its history.
  const held = workflowRun(repo);
  assert.equal(held.update, null);
  assert.equal(held.marks, null);
  assert.match(held.stderr, /Restore of base-7 not published/);
  assert.equal((await decisionDoc('base-7')).publishedAt, undefined);

  // The Owner adds its file.
  catalog.writeLyric(bundled, repo.dir);
  commit(repo.dir, 'Add base-7');
  const run = workflowRun(repo);
  assert.deepEqual(run.update.items.map(i => i.remoteId), ['base-7']);
  assert.equal((await decisionDoc('base-7')).publishedAt.toMillis(), 6000);
});

// The Owner's withdrawal wins: an approved revision of a withdrawn lyric
// waits, unpublished, until the Owner restores the lyric.
test('a revision approved after a withdrawal does not bring the lyric back', { skip }, async () => {
  const repo = checkout();
  await put('lyric-1', websiteSubmission('lyric-1', { title: 'Original', ...approval(2000) }));
  workflowRun(repo);
  // A revision is waiting for review when the Owner withdraws the lyric.
  await put('rev-1', websiteSubmission('rev-1', { revisionOfRemoteId: 'lyric-1', title: 'Revised' }));
  await withdrawal('lyric-1', true, 4000);
  workflowRun(repo);
  assert.ok(!catalogAfter(repo).has('lyric-1'));

  await put('rev-1', websiteSubmission('rev-1', {
    revisionOfRemoteId: 'lyric-1',
    title: 'Revised',
    ...approval(5000)
  }));
  const run = workflowRun(repo);

  assert.equal(run.update, null, 'the held revision was published');
  assert.ok(!fs.existsSync(lyricFile(repo, 'lyric-1')), 'the withdrawn lyric is back in the Catalog');
  assert.ok(!catalogAfter(repo).has('lyric-1'), 'the withdrawn lyric is back for readers');
  assert.equal((await read('rev-1')).published, false, 'the held revision was marked published');
});

// FirestoreWebConsoleRepository.setVerified: the rules allow it on a
// published submission, and the admin queue offers it there.
const setVerified = (id, verified, ms) => submission(id).update({
  isVerified: verified,
  reviewedBy: 'admin-uid',
  adminReviewedAt: at(ms)
});

test('verifying a published lyric reaches the catalog', { skip }, async () => {
  const repo = checkout();
  await put('web-6', websiteSubmission('web-6', approval(2000)));
  workflowRun(repo);
  assert.equal(catalogAfter(repo).get('web-6').isVerified, false);

  await setVerified('web-6', true, 3000);
  const run = workflowRun(repo);

  assert.notEqual(run.update, null, 'the Verify change published nothing');
  assert.deepEqual(run.update.items.map(i => [i.remoteId, i.title, i.isVerified]), [
    ['web-6', 'Ya Abbas', true]
  ]);
  assert.equal(run.marks, null);
  assert.equal(run.message, 'Publish 1 lyric change [skip ci]\n\n- Ya Abbas: verified');
  assert.equal(catalogAfter(repo).get('web-6').isVerified, true);
  assert.equal(workflowRun(repo).update, null);

  await setVerified('web-6', false, 4000);
  assert.deepEqual(workflowRun(repo).update.items.map(i => [i.remoteId, i.isVerified]), [['web-6', false]]);
  assert.equal(catalogAfter(repo).get('web-6').isVerified, false);

  // Verified and unverified again between runs: nothing changed for readers.
  await setVerified('web-6', true, 5000);
  await setVerified('web-6', false, 5500);
  assert.equal(workflowRun(repo).update, null);
});

test('verifying a published revision republishes the lyric it changed', { skip }, async () => {
  const repo = checkout();
  await put('lyric-1', websiteSubmission('lyric-1', { title: 'Original', ...approval(2000) }));
  workflowRun(repo);
  await put('rev-1', websiteSubmission('rev-1', {
    revisionOfRemoteId: 'lyric-1',
    title: 'Revised',
    ...approval(3000)
  }));
  workflowRun(repo);

  // The older version isn't what readers have: verifying it changes nothing.
  await setVerified('lyric-1', true, 4000);
  assert.equal(workflowRun(repo).update, null);

  await setVerified('rev-1', true, 5000);
  const run = workflowRun(repo);
  assert.deepEqual(run.update.items.map(i => [i.remoteId, i.title, i.isVerified]), [
    ['lyric-1', 'Revised', true]
  ]);
  assert.deepEqual([...catalogAfter(repo).keys()], ['lyric-1']);
});

test('a Verify change on a withdrawn lyric waits for the restore', { skip }, async () => {
  const repo = checkout();
  await put('web-6', websiteSubmission('web-6', approval(2000)));
  workflowRun(repo);
  await withdrawal('web-6', true, 3000);
  workflowRun(repo);

  await setVerified('web-6', true, 4000);
  assert.equal(workflowRun(repo).update, null);
  assert.ok(!catalogAfter(repo).has('web-6'));

  await withdrawal('web-6', false, 5000);
  assert.deepEqual(workflowRun(repo).update.items.map(i => i.remoteId), ['web-6']);
  // The restore brings back the file as it was; the flag follows by the
  // next run at the latest.
  workflowRun(repo);
  assert.equal(catalogAfter(repo).get('web-6').isVerified, true);
});
