const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const catalog = require('./catalog');

function getRequiredReleaseTag() {
  const releaseTag = process.env.RELEASE_TAG;
  if (!releaseTag) {
    throw new Error('RELEASE_TAG env var is required');
  }
  return releaseTag;
}

function getDb() {
  const encodedServiceAccount = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!encodedServiceAccount) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT env var is required');
  }

  const serviceAccount = JSON.parse(
    Buffer.from(encodedServiceAccount, 'base64').toString('ascii')
  );

  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
  }

  return admin.firestore();
}

function loadManifest(manifestPath) {
  let manifest = {
    manifestVersion: 1,
    latestReleaseTag: '',
    updates: []
  };

  if (fs.existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (e) {
      console.warn('Existing manifest.json is invalid, starting fresh.');
    }
  }

  if (!Array.isArray(manifest.updates)) {
    manifest.updates = [];
  }

  return manifest;
}

function normalizeCategory(category) {
  const value = (category || '').trim();
  if (!value) {
    return 'Nohay';
  }

  if (value.toLowerCase() === 'oldnouhay') {
    return 'Nohay';
  }

  return value;
}

const URDU_SCRIPT = /[؀-ۿݐ-ݿ]/;
const cleanName = value =>
  typeof value === 'string' && value.trim() && value.trim() !== 'General' ? value.trim() : undefined;

// An approved submission as a Catalog record. Built from an allow-list, so
// contributor fields (ownerUid, termsVersion, ...) never reach the Catalog.
// Documents from before contract v1 get its values: `category` becomes
// `categories`, a missing language is read from the title's script, and
// "General" or a group that isn't a year is left out.
function toRecord(remoteId, data) {
  const categories = Array.isArray(data.categories) && data.categories.length
    ? data.categories
    : [normalizeCategory(data.category)];
  const year = Number.isInteger(data.group) ? data.group
    : /^\d{4}$/.test(String(data.group ?? '')) ? Number(data.group) : undefined;
  const record = {
    remoteId,
    title: data.title,
    body: data.body,
    language: data.language || (URDU_SCRIPT.test(data.title ?? '') ? 'Urdu' : 'Roman Urdu'),
    categories
  };
  if (cleanName(data.subcategory)) record.subcategory = cleanName(data.subcategory);
  if (year !== undefined) record.group = year;
  if (cleanName(data.author)) record.author = cleanName(data.author);
  record.anjumans = Array.isArray(data.anjumans) ? data.anjumans : [];
  record.verified = data.isVerified === true;
  return record;
}

// A Catalog record as an item of an old-shape update file, which every
// installed build reads. Until the switch-over (manifest.json's
// contractVersion), updates use this shape.
function toUpdateItem(record) {
  const { remoteId, categories, anjumans } = record;
  const item = {
    remoteId,
    title: record.title,
    body: record.body,
    category: categories[0],
    categories,
    subcategory: record.subcategory || 'General',
    group: record.group || 'General',
    isVerified: record.verified,
    source: 'firestore'
  };
  if (record.author) item.author = record.author;
  item.language = record.language;
  if (anjumans.length) {
    item.anjumans = anjumans;
    // The app reads Anjuman membership from categoryMappings.
    item.categoryMappings = [
      ...categories,
      ...anjumans.map(name => ({ category: 'Anjuman', subcategory: name }))
    ];
  }
  return item;
}

const millis = timestamp =>
  timestamp && typeof timestamp.toMillis === 'function' ? timestamp.toMillis() : 0;

// The Owner's decisions from the website (`catalogWithdrawals/{remoteId}`)
// that readers haven't received yet: never published, or changed since.
// The website replaces the doc on every change, so a fresh decision has no
// publishedAt. `docs` are `{ id, data }`.
const unpublishedDecisions = docs => docs
  .filter(({ data }) => !data.publishedAt || millis(data.updatedAt) > millis(data.publishedAt))
  .map(({ id, data }) => ({ remoteId: id, updatedAt: millis(data.updatedAt) }));

// Withdrawals (`withdrawn == true`) readers haven't received yet.
const pendingWithdrawals = docs =>
  unpublishedDecisions(docs.filter(({ data }) => data.withdrawn === true));

// Restores (`withdrawn == false`) readers haven't received yet.
const pendingRestores = docs =>
  unpublishedDecisions(docs.filter(({ data }) => data.withdrawn !== true));

// An admin edit is a submission the same admin sent and approved: its
// ownerUid equals its approvedBy. A reader's suggestion an admin approved has
// another ownerUid. `docs` are `{ id, data }`.
const isAdminEdit = ({ data }) => Boolean(data.ownerUid) && data.ownerUid === data.approvedBy;
const hasAdminEdit = docs => docs.some(isAdminEdit);

const newestApproval = docs => docs.reduce((newest, doc) =>
  millis(doc.data.approvedAt) >= millis(newest.data.approvedAt) ? doc : newest);

// What one run writes into the Catalog, from Firestore.
//   submissions  approved `submissions` docs, published or not
//   decisions    every `catalogWithdrawals` doc
//   lyrics       the Catalog before the run (remoteId -> record)
//   lastVersion  a deleted lyric's last record, from git history, or null
// Docs are `{ id, data }`. Returns the records to write and the lyrics to
// delete, each with the kind of change for the commit message; the
// submission ids and decisions to mark published; the restores that couldn't
// be found (left pending, unmarked); and approvals held because their record
// is invalid.
function planUpdate({ submissions, decisions, lyrics = new Map(), lastVersion = () => null }) {
  const withdrawn = new Set(
    decisions.filter(({ data }) => data.withdrawn === true).map(({ id }) => id)
  );
  const restoring = new Set(pendingRestores(decisions).map(({ remoteId }) => remoteId));

  // Approved submissions by the lyric they publish. A Revision Submission is
  // its own document whose `revisionOfRemoteId` names the lyric it replaces.
  const approvals = new Map();
  for (const doc of submissions) {
    const remoteId = doc.data.revisionOfRemoteId || doc.id;
    approvals.set(remoteId, [...(approvals.get(remoteId) ?? []), doc]);
  }

  // The newest approval wins. Every unpublished document is still marked, so
  // a later run can't publish an older version over it. An approval whose
  // record is invalid is held, neither written nor marked.
  const unpublished = docs => docs.filter(({ data }) => data.published === false);
  const writes = new Map();
  const deletes = new Map();
  const submissionIds = [];
  const held = [];
  const publish = (remoteId, docs, kind) => {
    const newest = newestApproval(docs);
    const record = toRecord(remoteId, newest.data);
    const problem = catalog.recordProblem(record);
    if (problem) {
      held.push({ remoteId, problem });
      return false;
    }
    kind ??= lyrics.has(remoteId) ? (isAdminEdit(newest) ? 'admin edit' : 'suggested edit')
      : restoring.has(remoteId) ? 'restore' : 'new';
    writes.set(remoteId, { record, kind });
    submissionIds.push(...unpublished(docs).map(({ id }) => id));
    return true;
  };

  for (const [remoteId, docs] of approvals) {
    // The Owner's withdrawal wins over an approval: held, neither published
    // nor marked, until the Owner restores the lyric.
    if (withdrawn.has(remoteId)) continue;
    if (unpublished(docs).length) {
      publish(remoteId, docs);
      continue;
    }
    // Verify/Unverify on a published submission: the Catalog has the newest
    // approved version's title and body, but not its Verified flag. Only the
    // flag changes, so an Owner's later edit of other fields stays.
    const current = lyrics.get(remoteId);
    const { title, body, isVerified } = newestApproval(docs).data;
    const verified = isVerified === true;
    if (current && current.title === title && current.body === body && current.verified !== verified) {
      writes.set(remoteId, { record: { ...current, verified }, kind: verified ? 'verified' : 'unverified' });
    }
  }

  // A restore writes the lyric back: an approval held while it was withdrawn,
  // else its last version from git history, else its newest approval. A
  // withdrawal that never reached the Catalog needs nothing written.
  const restores = [];
  const unresolved = [];
  for (const restore of pendingRestores(decisions)) {
    const { remoteId } = restore;
    if (!lyrics.has(remoteId) && !writes.has(remoteId)) {
      const docs = approvals.get(remoteId) ?? [];
      const last = unpublished(docs).length ? null : lastVersion(remoteId);
      if (last) {
        // With a Verify or Unverify made while it was withdrawn.
        const newest = docs.length ? newestApproval(docs).data : null;
        const verified = newest && newest.title === last.title && newest.body === last.body
          ? newest.isVerified === true : last.verified;
        writes.set(remoteId, { record: { ...last, verified }, kind: 'restore' });
      } else if (!docs.length || !publish(remoteId, docs, 'restore')) {
        unresolved.push(remoteId);
        continue;
      }
    }
    restores.push(restore);
  }

  const withdrawals = pendingWithdrawals(decisions);
  for (const { remoteId } of withdrawals) {
    if (lyrics.has(remoteId)) deletes.set(remoteId, { title: lyrics.get(remoteId).title, kind: 'withdrawal' });
  }
  return {
    writes,
    deletes,
    submissionIds,
    decisions: [...withdrawals, ...restores],
    unresolved,
    held
  };
}

const CONTRACT_VERSION = '1.0.0';

// The update file for `records` and `removed`, or null when both are empty.
// The manifest's contractVersion says which shape readers take: none means
// the old shape every installed build reads. `removed` goes beside `items`,
// not in it: older builds fail on an entry there without a title, but ignore
// other keys.
function buildPayload(records, removed, contractVersion) {
  if (!records.length && !removed.length) return null;
  const payload = contractVersion === CONTRACT_VERSION
    ? { contractVersion, items: records }
    : { items: records.map(toUpdateItem) };
  return removed.length ? { ...payload, removed } : payload;
}

// Every update stays listed. The website and a fresh install build the
// catalog from the bundled base catalog plus every update in this list, so
// an update dropped from it takes its lyrics and withdrawals with it.
// `catalogTree` is the git tree of lyrics/ readers have once they apply it;
// the next run publishes what changed since.
function applyUpdateToManifest(manifest, { updateId, updateFilename, sha256, releaseTag, catalogTree }) {
  return {
    ...manifest,
    manifestVersion: 1,
    latestReleaseTag: releaseTag,
    catalogTree,
    updates: [
      ...(Array.isArray(manifest.updates) ? manifest.updates : []),
      {
        id: updateId,
        assetName: updateFilename,
        sha256,
        releaseTag
      }
    ]
  };
}

// The sync bot's commit message: each change by title and kind. It names no
// Contributor or Admin.
function commitMessage(changes) {
  const lines = changes.map(({ title, kind }) => `- ${title}: ${kind}`);
  const count = changes.length === 1 ? '1 lyric change' : `${changes.length} lyric changes`;
  return `Publish ${count} [skip ci]\n\n${lines.join('\n')}\n`;
}

const marksPath = path.join(__dirname, '../publish_marks.json');
const messagePath = path.join(__dirname, '../commit_message.txt');

function checkLyricFiles(dir) {
  const problems = catalog.problems(dir);
  if (problems.length) {
    throw new Error(`Invalid lyric files, nothing published:\n${problems.join('\n')}`);
  }
}

// One run: write what Firestore approved into lyrics/, check every lyric
// file, then publish everything in lyrics/ that changed since the tree the
// manifest names, whoever changed it.
async function sync(db = getDb(), dir = path.join(__dirname, '..')) {
  const releaseTag = getRequiredReleaseTag();
  const manifestPath = path.join(dir, 'manifest.json');
  let manifest = loadManifest(manifestPath);
  if (!manifest.catalogTree) {
    throw new Error('manifest.json has no catalogTree: the tree of lyrics/ readers already have.');
  }

  console.log('Fetching approved lyrics from Firestore...');
  const docs = snapshot => snapshot.docs.map(doc => ({ id: doc.id, data: doc.data() }));
  // A run the watchdog starts publishes only for an admin edit; once it does,
  // everything waiting goes out with it. Readers' suggestions wait for the
  // 6-hour run.
  // Only the unpublished submissions are read to decide, so a quiet run is cheap.
  if (process.env.ONLY_IF_ADMIN_EDIT === '1') {
    const waiting = docs(await db.collection('submissions')
      .where('status', '==', 'approved')
      .where('published', '==', false)
      .get());
    if (!hasAdminEdit(waiting)) {
      console.log('No admin edit waiting; the next 6-hour run publishes the rest.');
      return;
    }
  }

  checkLyricFiles(dir);
  const before = catalog.readCatalog(dir);
  const plan = planUpdate({
    // Published ones too: a restore may send the lyric's newest approved
    // version, and Verify/Unverify can change a published one.
    submissions: docs(await db.collection('submissions').where('status', '==', 'approved').get()),
    decisions: docs(await db.collection('catalogWithdrawals').get()),
    lyrics: before,
    lastVersion: remoteId => catalog.lastVersion(remoteId, dir)
  });
  for (const { remoteId, problem } of plan.held) {
    console.warn(`Approval of ${remoteId} held, not published: ${problem}`);
  }
  for (const remoteId of plan.unresolved) {
    console.warn(`Restore of ${remoteId} not published: no approval or earlier file has it. It stays pending.`);
  }

  for (const { record } of plan.writes.values()) catalog.writeLyric(record, dir);
  for (const remoteId of plan.deletes.keys()) catalog.deleteLyric(remoteId, dir);
  checkLyricFiles(dir);

  // What --mark-published marks. Kept out of output/, which the release
  // uploads: submission ids aren't catalog data. `withdrawals` lists the
  // catalogWithdrawals docs published, withdrawals and restores alike.
  // Written even when the Catalog already had everything, so an approval
  // a failed run wrote is still marked.
  if (plan.submissionIds.length || plan.decisions.length) {
    fs.writeFileSync(path.join(dir, path.basename(marksPath)), JSON.stringify(
      { submissions: plan.submissionIds, withdrawals: plan.decisions }, null, 2) + '\n');
  }

  const baseline = manifest.catalogTree;
  const tree = catalog.catalogTree(dir);
  const { added, changed, removed } = catalog.changesBetween(baseline, tree, dir);
  const after = catalog.readCatalog(dir);
  // This run's approvals first, in the order the plan wrote them.
  const edited = new Set([...added, ...changed]);
  const ids = [...new Set([...[...plan.writes.keys()].filter(id => edited.has(id)), ...edited])];
  const payload = buildPayload(ids.map(id => after.get(id)), removed, manifest.contractVersion);
  if (!payload) {
    console.log('No lyric changed since the last update.');
    return;
  }
  console.log(`Publishing ${ids.length} changed lyrics and ${removed.length} removals.`);

  const updateId = `update_${Date.now()}`;
  const updateFilename = `${updateId}.json`;
  const outputDir = path.join(dir, 'output');
  fs.mkdirSync(outputDir, { recursive: true });
  const payloadStr = JSON.stringify(payload, null, 2) + '\n';
  fs.writeFileSync(path.join(outputDir, updateFilename), payloadStr);
  // Hash the exact bytes published; the app rejects an update whose hash differs.
  const sha256 = crypto.createHash('sha256').update(payloadStr).digest('hex');

  manifest = applyUpdateToManifest(manifest, { updateId, updateFilename, sha256, releaseTag, catalogTree: tree });
  const manifestStr = JSON.stringify(manifest, null, 2) + '\n';
  fs.writeFileSync(path.join(outputDir, 'manifest.json'), manifestStr);
  fs.writeFileSync(manifestPath, manifestStr);

  catalog.writeIndex([...after.values()], dir);
  const kindOf = (id, fallback) => plan.writes.get(id)?.kind ?? fallback;
  fs.writeFileSync(path.join(dir, path.basename(messagePath)), commitMessage([
    ...ids.map(id => ({ title: after.get(id).title, kind: kindOf(id, added.includes(id) ? 'new' : 'Owner edit') })),
    ...removed.map(id => plan.deletes.get(id) ?? { title: catalog.recordIn(baseline, id, dir).title, kind: 'removed' })
  ]));
  console.log(`Success! Created ${updateFilename} and updated manifest.json.`);
}

// Runs as the workflow's last step, after the release exists. If any earlier
// step fails, the lyrics stay unpublished and the next run publishes them again.
async function markPublished(file = marksPath, db = getDb()) {
  const { submissions = [], withdrawals = [] } = JSON.parse(fs.readFileSync(file, 'utf8'));
  const batch = db.batch();
  for (const id of submissions) {
    batch.update(db.collection('submissions').doc(id), { published: true });
  }
  // Withdrawals and restores. The updatedAt this run saw: if the Owner
  // changed the decision since, updatedAt stays newer and the next run
  // publishes it again.
  for (const { remoteId, updatedAt } of withdrawals) {
    batch.update(db.collection('catalogWithdrawals').doc(remoteId), {
      publishedAt: admin.firestore.Timestamp.fromMillis(updatedAt)
    });
  }
  await batch.commit();
  console.log(`Marked ${submissions.length} submissions and ${withdrawals.length} withdrawals as published.`);
}

if (require.main === module) {
  const [mode, file] = process.argv.slice(2);
  (mode === '--mark-published' ? markPublished(file) : sync()).catch(err => {
    console.error('Error during sync:', err);
    process.exit(1);
  });
}

module.exports = {
  CONTRACT_VERSION,
  applyUpdateToManifest,
  buildPayload,
  commitMessage,
  getDb,
  getRequiredReleaseTag,
  hasAdminEdit,
  isAdminEdit,
  loadManifest,
  markPublished,
  normalizeCategory,
  pendingRestores,
  pendingWithdrawals,
  planUpdate,
  sync,
  toRecord,
  toUpdateItem
};
