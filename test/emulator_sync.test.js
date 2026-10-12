// The real sync script against the Firestore emulator, run the way the
// workflow runs it: sync, then --mark-published, with manifest.json kept
// between runs. Each test checks the update files a website submission,
// revision or Owner withdrawal turns into.
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
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const host = process.env.FIRESTORE_EMULATOR_HOST;
const projectId = 'demo-kanz-e-aza';
const skip = host ? false : 'needs FIRESTORE_EMULATOR_HOST (Firestore emulator)';
const script = path.join(__dirname, '../scripts/sync_firestore_to_github.js');

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

// A checkout of this repository: the script, and manifest.json once a run
// has committed it.
function checkout() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kanz-sync-'));
  fs.mkdirSync(path.join(dir, 'scripts'));
  fs.copyFileSync(script, path.join(dir, 'scripts', 'sync_firestore_to_github.js'));
  return { dir, runs: 0, published: [] };
}

function node(repo, args) {
  const env = { ...process.env };
  delete env.GOOGLE_APPLICATION_CREDENTIALS;
  delete env.REMOVE_IDS;
  Object.assign(env, {
    FIRESTORE_EMULATOR_HOST: host,
    FIREBASE_SERVICE_ACCOUNT: serviceAccount,
    RELEASE_TAG: `v1.0.${repo.runs}-test`,
    NODE_PATH: path.join(__dirname, '../node_modules')
  });
  const result = spawnSync(process.execPath, args, { cwd: repo.dir, env, encoding: 'utf8' });
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result;
}

// One workflow run: a clean output/, sync, then (as the last step) mark.
// Returns the update file it published, or null.
function workflowRun(repo, { mark = true } = {}) {
  repo.runs++;
  fs.rmSync(path.join(repo.dir, 'output'), { recursive: true, force: true });
  fs.rmSync(path.join(repo.dir, 'publish_marks.json'), { force: true });
  const { stdout } = node(repo, ['scripts/sync_firestore_to_github.js']);
  const output = path.join(repo.dir, 'output');
  const names = fs.existsSync(output)
    ? fs.readdirSync(output).filter(name => name.startsWith('update_'))
    : [];
  if (!names.length) return { stdout, update: null };
  assert.equal(names.length, 1);
  const bytes = fs.readFileSync(path.join(output, names[0]));
  const manifest = JSON.parse(fs.readFileSync(path.join(output, 'manifest.json'), 'utf8'));
  const run = {
    stdout,
    name: names[0],
    bytes,
    text: bytes.toString('utf8'),
    update: JSON.parse(bytes.toString('utf8')),
    manifest,
    marks: JSON.parse(fs.readFileSync(path.join(repo.dir, 'publish_marks.json'), 'utf8'))
  };
  repo.published.push(run.update);
  if (mark) node(repo, ['scripts/sync_firestore_to_github.js', '--mark-published', 'publish_marks.json']);
  return run;
}

// What a reader builds from the base catalog plus every update, in order:
// each file's items, then the remoteIds it removes (ReleaseCatalogService
// and the app's UpdateService apply them this way).
function catalogAfter(repo, base = {}) {
  const lyrics = new Map(Object.entries(base));
  for (const update of repo.published) {
    for (const item of update.items) lyrics.set(item.remoteId, item);
    for (const id of update.removed ?? []) lyrics.delete(id);
  }
  return lyrics;
}

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
  assert.deepEqual(run.marks, { submissions: ['web-1'], withdrawals: [] });
  assert.ok(!fs.existsSync(path.join(repo.dir, 'output', 'publish_marks.json')));
  // Nothing is marked until the last workflow step.
  assert.equal((await read('web-1')).published, false);

  node(repo, ['scripts/sync_firestore_to_github.js', '--mark-published', 'publish_marks.json']);

  assert.equal((await read('web-1')).published, true);
  assert.equal((await read('web-1')).status, 'approved');
  assert.equal((await read('web-pending')).published, false);
  assert.equal((await read('web-rejected')).published, false);

  const again = workflowRun(repo);
  assert.equal(again.update, null);
  assert.match(again.stdout, /No new approved lyrics or removals to sync/);
});

test('the update file carries no contributor or review fields', { skip }, async () => {
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
  for (const secret of [
    'contributor-9c1e', 'admin-7f3a', 'terms-2026-07', 'poet@example.com',
    'device-55aa', 'checked by phone', 'ownerUid', 'termsVersion', '@'
  ]) {
    assert.ok(!run.text.includes(secret), `update file contains ${secret}`);
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
  assert.equal((await read('rev-1')).published, true);
  const catalog = catalogAfter(repo);
  assert.deepEqual([...catalog.keys()], ['lyric-1']);
  assert.equal(catalog.get('lyric-1').title, 'Original (corrected)');
});

test('two approved revisions of one lyric: the newest approval wins, both are marked', { skip }, async () => {
  const repo = checkout();
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
  const repo = checkout();
  await withdrawal('base-7', true, 4000);
  await put('web-5', websiteSubmission('web-5', { title: 'Same run', ...approval(2000) }));

  const run = workflowRun(repo);

  assert.deepEqual(run.update.removed, ['base-7']);
  assert.deepEqual(run.update.items.map(i => i.remoteId), ['web-5']);
  assert.deepEqual(run.marks.withdrawals, [{ remoteId: 'base-7', updatedAt: 4000 }]);
  const marked = (await db.collection('catalogWithdrawals').doc('base-7').get()).data();
  assert.equal(marked.publishedAt.toMillis(), 4000);
  assert.equal(marked.withdrawn, true);
  assert.ok(!catalogAfter(repo, { 'base-7': { title: 'Bundled' } }).has('base-7'));

  const again = workflowRun(repo);
  assert.equal(again.update, null);
});

// Known gap, Kanz-e-Aza-Lyrics#13: a restore is never published.
test('an Owner restore brings the lyric back', {
  skip,
  todo: 'Known gap Kanz-e-Aza-Lyrics#13: sync only reads withdrawn == true, so a restore never reaches phones or the website'
}, async () => {
  const repo = checkout();
  const base = { 'base-7': { title: 'Bundled' } };
  await withdrawal('base-7', true, 4000);
  workflowRun(repo);
  assert.ok(!catalogAfter(repo, base).has('base-7'));

  await withdrawal('base-7', false, 6000);
  const run = workflowRun(repo);

  assert.notEqual(run.update, null, 'the restore published nothing');
  assert.ok(catalogAfter(repo, base).has('base-7'));
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
  assert.ok(!catalogAfter(repo).has('lyric-1'), 'the withdrawn lyric is back in the catalog');
  assert.equal((await read('rev-1')).published, false, 'the held revision was marked published');
});

// BUG: Verify/Unverify on a published submission is saved (the rules allow
// it and the admin queue offers it), but sync only reads unpublished
// submissions, so the change never reaches phones or the website.
test('verifying a published lyric reaches the catalog', {
  skip,
  todo: 'BUG: sync never republishes a published submission, so its new Verified flag is lost'
}, async () => {
  const repo = checkout();
  await put('web-6', websiteSubmission('web-6', approval(2000)));
  workflowRun(repo);
  assert.equal(catalogAfter(repo).get('web-6').isVerified, false);

  await submission('web-6').update({ isVerified: true, reviewedBy: 'admin-uid', adminReviewedAt: at(3000) });
  workflowRun(repo);

  assert.equal(catalogAfter(repo).get('web-6').isVerified, true);
});
