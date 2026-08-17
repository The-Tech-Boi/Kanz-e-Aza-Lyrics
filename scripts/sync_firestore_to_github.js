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

  if (snapshot.empty) {
    console.log('No new approved lyrics to sync.');
    process.exit(0);
  }

  console.log(`Found ${snapshot.size} new lyrics.`);

  const newLyrics = [];
  const docRefs = [];

  snapshot.forEach(doc => {
    const data = doc.data();
    newLyrics.push({
      remoteId: doc.id,
      title: data.title,
      body: data.body,
      category: normalizeCategory(data.category),
      subcategory: data.subcategory || 'General',
      group: data.group || 'General',
      createdBy: data.createdBy || 'unknown',
      source: 'firestore'
    });
    docRefs.push(doc.ref);
  });

  const timestamp = Date.now();
  const updateId = `update_${timestamp}`;
  const updateFilename = `${updateId}.json`;
  const payload = { items: newLyrics };

  const outputDir = path.join(__dirname, '../output');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const payloadStr = JSON.stringify(payload, null, 2);
  fs.writeFileSync(path.join(outputDir, updateFilename), payloadStr + '\n');

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

  console.log('Marking documents as published in Firestore...');
  const batch = db.batch();
  docRefs.forEach(ref => {
    batch.update(ref, { published: true });
  });
  await batch.commit();

  console.log(`Success! Created ${updateFilename} and updated manifest.json.`);
}

if (require.main === module) {
  sync().catch(err => {
    console.error('Error during sync:', err);
    process.exit(1);
  });
}

module.exports = {
  applyUpdateToManifest,
  getRequiredReleaseTag,
  loadManifest,
  normalizeCategory
};
