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

// Approved submissions as update items. A Revision Submission is its own
// document whose `revisionOfRemoteId` names the published lyric it replaces.
// When several are approved for one lyric, the newest approval wins; every
// document is still marked published, so a later run can't publish an older
// version over it. `docs` are `{ id, data }`.
function collectApproved(docs) {
  const newest = new Map();
  for (const doc of docs) {
    const remoteId = doc.data.revisionOfRemoteId || doc.id;
    const current = newest.get(remoteId);
    if (!current || millis(doc.data.approvedAt) >= millis(current.data.approvedAt)) {
      newest.set(remoteId, doc);
    }
  }
  return {
    items: [...newest].map(([remoteId, doc]) => toUpdateItem(remoteId, doc.data)),
    submissionIds: docs.map(doc => doc.id)
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

function applyUpdateToManifest(manifest, { updateId, updateFilename, sha256, releaseTag }) {
  const nextManifest = {
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

  if (nextManifest.updates.length > 50) {
    nextManifest.updates = nextManifest.updates.slice(-50);
  }

  return nextManifest;
}

async function sync() {
  const db = getDb();
  const releaseTag = getRequiredReleaseTag();

  console.log('Fetching approved lyrics from Firestore...');

  const snapshot = await db.collection('submissions')
    .where('status', '==', 'approved')
    .where('published', '==', false)
    .get();

  const { items, submissionIds } = collectApproved(
    snapshot.docs.map(doc => ({ id: doc.id, data: doc.data() }))
  );
  const payload = buildPayload(items, process.env.REMOVE_IDS);
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

  const manifestPath = path.join(__dirname, '../manifest.json');
  let manifest = loadManifest(manifestPath);
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
  // uploads: submission ids aren't catalog data.
  fs.writeFileSync(marksPath, JSON.stringify({ submissions: submissionIds }, null, 2) + '\n');

  console.log(`Success! Created ${updateFilename} and updated manifest.json.`);
}

const marksPath = path.join(__dirname, '../publish_marks.json');

// Runs as the workflow's last step, after the release exists. If any earlier
// step fails, the lyrics stay unpublished and the next run publishes them again.
async function markPublished(file = marksPath, db = getDb()) {
  const { submissions = [] } = JSON.parse(fs.readFileSync(file, 'utf8'));
  const batch = db.batch();
  for (const id of submissions) {
    batch.update(db.collection('submissions').doc(id), { published: true });
  }
  await batch.commit();
  console.log(`Marked ${submissions.length} submissions as published.`);
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
  collectApproved,
  getDb,
  getRequiredReleaseTag,
  markPublished,
  loadManifest,
  normalizeCategory,
  buildPayload,
  toUpdateItem
};
