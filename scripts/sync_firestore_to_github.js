const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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

// One published catalog item, in the update format every app version reads.
// Built from an allow-list, so contributor fields (ownerUid, termsVersion, ...)
// never reach the public catalog.
function toUpdateItem(remoteId, data) {
  const categories = Array.isArray(data.categories) && data.categories.length
    ? data.categories
    : [normalizeCategory(data.category)];
  const anjumans = Array.isArray(data.anjumans) ? data.anjumans : [];
  const item = {
    remoteId,
    title: data.title,
    body: data.body,
    category: categories[0],
    categories,
    subcategory: data.subcategory || 'General',
    group: data.group || 'General',
    isVerified: data.isVerified === true,
    source: 'firestore'
  };
  if (data.author) item.author = data.author;
  if (data.language) item.language = data.language;
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

// The fields a published item may carry. A lyric sent again from an earlier
// update or from the base catalog keeps only these, so nothing else it holds
// (an old `createdBy`, page metadata) is published.
const ITEM_FIELDS = [
  'remoteId', 'title', 'body', 'category', 'categories', 'subcategory', 'group',
  'isVerified', 'source', 'author', 'language', 'anjumans', 'categoryMappings'
];
const catalogItem = item =>
  Object.fromEntries(ITEM_FIELDS.filter(key => key in item).map(key => [key, item[key]]));

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

const newestApproval = docs => docs.reduce((newest, doc) =>
  millis(doc.data.approvedAt) >= millis(newest.data.approvedAt) ? doc : newest);

// What readers have from the published updates, replayed the way phones and
// the website apply them: every update the manifest lists, in order, each
// file's items and then its removals. Maps a remoteId to the item last
// published for it (none for a base catalog lyric) and whether it is
// withdrawn now. The workflow commits every update file to updates/, and
// manifest_sha.test.js checks they are all there.
function publishedState(manifest, updatesDir = path.join(__dirname, '../updates')) {
  const state = new Map();
  for (const { assetName } of manifest.updates) {
    const update = JSON.parse(fs.readFileSync(path.join(updatesDir, assetName), 'utf8'));
    for (const item of update.items) state.set(item.remoteId, { item, removed: false });
    for (const remoteId of update.removed ?? []) {
      state.set(remoteId, { item: state.get(remoteId)?.item, removed: true });
    }
  }
  return state;
}

// The base catalog phones and the website start from isn't in this
// repository; the data snapshot release carries a copy of it. BASE_CATALOG
// (a URL or a local file) reads another one, such as a newer snapshot.
const DEFAULT_BASE_CATALOG =
  'https://github.com/The-Tech-Boi/Kanz-e-Aza-Lyrics/releases/download/data-v2026.09.24/lyrics.json';

async function loadBaseCatalog(source = process.env.BASE_CATALOG || DEFAULT_BASE_CATALOG) {
  let text;
  if (/^https?:\/\//.test(source)) {
    const response = await fetch(source);
    if (!response.ok) throw new Error(`GET ${source} failed with ${response.status}`);
    text = await response.text();
  } else {
    text = fs.readFileSync(source, 'utf8');
  }
  return new Map(JSON.parse(text).items.map(item => [item.remoteId, item]));
}

// One run's update, from Firestore and what readers already have.
//   submissions  approved `submissions` docs, published or not
//   decisions    every `catalogWithdrawals` doc
//   published    publishedState()
//   base         the base catalog; only needed when `unresolved` says so
// Docs are `{ id, data }`. Returns the update's `items` and `removed`, the
// submission ids and decisions to mark published, and the restores whose
// lyric couldn't be found (left pending, unmarked).
function planUpdate({ submissions, decisions, published = new Map(), base = null }) {
  const withdrawn = new Set(
    decisions.filter(({ data }) => data.withdrawn === true).map(({ id }) => id)
  );

  // Approved submissions by the lyric they publish. A Revision Submission is
  // its own document whose `revisionOfRemoteId` names the lyric it replaces.
  const lyrics = new Map();
  for (const doc of submissions) {
    const remoteId = doc.data.revisionOfRemoteId || doc.id;
    lyrics.set(remoteId, [...(lyrics.get(remoteId) ?? []), doc]);
  }

  // The newest approval wins. Every unpublished document is still marked, so
  // a later run can't publish an older version over it.
  const unpublished = docs => docs.filter(({ data }) => data.published === false);
  const items = new Map();
  const submissionIds = [];
  const publish = (remoteId, docs) => {
    items.set(remoteId, toUpdateItem(remoteId, newestApproval(docs).data));
    submissionIds.push(...unpublished(docs).map(({ id }) => id));
  };

  for (const [remoteId, docs] of lyrics) {
    // The Owner's withdrawal wins over an approval: held, neither published
    // nor marked, until the Owner restores the lyric.
    if (withdrawn.has(remoteId)) continue;
    if (unpublished(docs).length) publish(remoteId, docs);
  }

  // Phones delete a withdrawn lyric, so a restore sends it again as an item:
  // its newest approved version, else the item last published for it, else
  // its base catalog entry. A withdrawal that never reached readers needs
  // nothing sent.
  const restores = [];
  const unresolved = [];
  for (const restore of pendingRestores(decisions)) {
    const { remoteId } = restore;
    const live = published.get(remoteId);
    if (live?.removed && !items.has(remoteId)) {
      if (lyrics.has(remoteId)) {
        publish(remoteId, lyrics.get(remoteId));
      } else if (live.item) {
        items.set(remoteId, catalogItem(live.item));
      } else if (base?.has(remoteId)) {
        items.set(remoteId, catalogItem(base.get(remoteId)));
      } else {
        unresolved.push(remoteId);
        continue;
      }
    }
    restores.push(restore);
  }

  const withdrawals = pendingWithdrawals(decisions);
  return {
    items: [...items.values()],
    removed: withdrawals.map(({ remoteId }) => remoteId),
    submissionIds,
    decisions: [...withdrawals, ...restores],
    unresolved
  };
}

// The update file, or null when there is nothing to publish. `removeIds`
// (comma or space separated) withdraws those remoteIds from phones. They go
// beside `items`, not in it: every app build requires `items` and older builds
// fail on an entry there without a title, but ignore other keys.
function buildPayload(items, removeIds = '') {
  const removed = [...new Set(removeIds.split(/[\s,]+/).filter(Boolean))];
  if (!items.length && !removed.length) return null;
  return removed.length ? { items, removed } : { items };
}

// Every update stays listed. The website and a fresh install build the
// catalog from the bundled base catalog plus every update in this list, so
// an update dropped from it takes its lyrics and withdrawals with it.
function applyUpdateToManifest(manifest, { updateId, updateFilename, sha256, releaseTag }) {
  return {
    manifestVersion: 1,
    latestReleaseTag: releaseTag,
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

async function sync() {
  const db = getDb();
  const releaseTag = getRequiredReleaseTag();

  console.log('Fetching approved lyrics from Firestore...');

  const docs = snapshot => snapshot.docs.map(doc => ({ id: doc.id, data: doc.data() }));
  const manifestPath = path.join(__dirname, '../manifest.json');
  let manifest = loadManifest(manifestPath);
  const input = {
    // Published ones too: a restore sends the lyric's newest approved version.
    submissions: docs(await db.collection('submissions').where('status', '==', 'approved').get()),
    decisions: docs(await db.collection('catalogWithdrawals').get()),
    published: publishedState(manifest)
  };
  let plan = planUpdate(input);
  if (plan.unresolved.length) {
    try {
      plan = planUpdate({ ...input, base: await loadBaseCatalog() });
    } catch (err) {
      console.warn(`Could not read the base catalog: ${err.message}`);
    }
  }
  for (const remoteId of plan.unresolved) {
    console.warn(
      `Restore of ${remoteId} not published: it isn't in Firestore, the published updates ` +
      'or the base catalog snapshot (BASE_CATALOG). It stays pending.'
    );
  }
  const { items, submissionIds, decisions } = plan;
  const payload = buildPayload(items, [process.env.REMOVE_IDS, ...plan.removed].join(' '));
  if (!payload) {
    console.log('No new approved lyrics or removals to sync.');
    process.exit(0);
  }

  console.log(`Found ${payload.items.length} new lyrics, ${payload.removed?.length ?? 0} removals.`);

  const timestamp = Date.now();
  const updateId = `update_${timestamp}`;
  const updateFilename = `${updateId}.json`;

  const outputDir = path.join(__dirname, '../output');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const payloadStr = JSON.stringify(payload, null, 2) + '\n';
  fs.writeFileSync(path.join(outputDir, updateFilename), payloadStr);

  // Hash the exact bytes published; the app rejects an update whose hash differs.
  const sha256 = crypto.createHash('sha256').update(payloadStr).digest('hex');

  manifest = applyUpdateToManifest(manifest, {
    updateId,
    updateFilename,
    sha256,
    releaseTag
  });

  fs.writeFileSync(
    path.join(outputDir, 'manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n'
  );
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

  // What --mark-published marks. Kept out of output/, which the release
  // uploads: submission ids aren't catalog data. `withdrawals` lists the
  // catalogWithdrawals docs published, withdrawals and restores alike.
  fs.writeFileSync(
    marksPath,
    JSON.stringify({ submissions: submissionIds, withdrawals: decisions }, null, 2) + '\n'
  );

  console.log(`Success! Created ${updateFilename} and updated manifest.json.`);
}

const marksPath = path.join(__dirname, '../publish_marks.json');

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
  applyUpdateToManifest,
  getDb,
  getRequiredReleaseTag,
  loadBaseCatalog,
  markPublished,
  loadManifest,
  normalizeCategory,
  pendingRestores,
  pendingWithdrawals,
  planUpdate,
  publishedState,
  buildPayload,
  toUpdateItem
};
