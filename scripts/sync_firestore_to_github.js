const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Generates release assets from Firestore only. It intentionally does NOT mark
// Firestore submissions as published. The GitHub Actions workflow runs
// mark_published.js after the release exists and its assets are visible, so a
// failed release cannot strand approved lyrics with published=true.
const serviceAccount = JSON.parse(
  Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT, 'base64').toString('ascii')
);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

function requireReleaseTag() {
  const tag = process.env.RELEASE_TAG;
  if (!tag) {
    throw new Error('RELEASE_TAG is required. The workflow must provide one tag used by both manifest.json and the GitHub Release.');
  }
  return tag;
}

async function sync() {
  const releaseTag = requireReleaseTag();
  console.log(`Fetching approved lyrics from Firestore for release ${releaseTag}...`);

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
  const publishedDocs = [];

  snapshot.forEach(doc => {
    const data = doc.data();
    newLyrics.push({
      remoteId: doc.id,
      title: data.title,
      body: data.body,
      category: data.category || 'Nohay',
      subcategory: data.subcategory || 'General',
      group: data.group || 'General',
      createdBy: data.createdBy || 'unknown',
      source: 'firestore'
    });
    publishedDocs.push(doc.id);
  });

  const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const updateId = `update_${timestamp}`;
  const updateFilename = `${updateId}.json`;
  const payload = { items: newLyrics };

  const outputDir = path.join(__dirname, '../output');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const payloadStr = JSON.stringify(payload, null, 2);
  fs.writeFileSync(path.join(outputDir, updateFilename), payloadStr);

  const sha256 = crypto.createHash('sha256').update(payloadStr).digest('hex');

  const manifestPath = path.join(__dirname, '../manifest.json');
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

  manifest.manifestVersion = 1;
  manifest.latestReleaseTag = releaseTag;
  manifest.updates.push({
    id: updateId,
    assetName: updateFilename,
    sha256: sha256,
    releaseTag: releaseTag
  });

  if (manifest.updates.length > 50) {
    manifest.updates = manifest.updates.slice(-50);
  }

  fs.writeFileSync(path.join(outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  fs.writeFileSync(
    path.join(outputDir, 'published_docs.json'),
    JSON.stringify({ releaseTag, updateId, updateFilename, docIds: publishedDocs }, null, 2)
  );

  console.log(`Success! Created ${updateFilename}, manifest.json, and published_docs.json.`);
}

sync().catch(err => {
  console.error('Error during sync:', err);
  process.exit(1);
});
