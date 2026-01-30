const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Initialize Firebase Admin
const serviceAccount = JSON.parse(
  Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT, 'base64').toString('ascii')
);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

async function sync() {
  console.log('Fetching approved lyrics from Firestore...');
  
  // 1. Query for approved but unpublished lyrics
  const snapshot = await db.collection('submissions')
    .where('status', '==', 'approved')
    .where('published', '==', false)
    .get();

  if (snapshot.empty) {
    console.log('No new approved lyrics to sync.');
    process.exit(0);
  }

  console.log(`Found ${snapshot.size} new lyrics.`);

  // 2. Prepare the update payload
  const newLyrics = [];
  const docRefs = [];

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
    docRefs.push(doc.ref);
  });

  const timestamp = Date.now();
  const updateId = `update_${timestamp}`;
  const updateFilename = `${updateId}.json`;
  const payload = { items: newLyrics };
  
  // 3. Create output directory
  const outputDir = path.join(__dirname, '../output');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // 4. Write update file
  const payloadStr = JSON.stringify(payload, null, 2);
  fs.writeFileSync(path.join(outputDir, updateFilename), payloadStr);
  
  // 5. Calculate SHA256
  const sha256 = crypto.createHash('sha256').update(payloadStr).digest('hex');

  // 6. Handle Manifest
  // We'll look for an existing manifest in the root of the repo
  const manifestPath = path.join(__dirname, '../manifest.json');
  let manifest = {
    manifestVersion: 1,
    latestReleaseTag: '', // Will be filled by Action or script
    updates: []
  };

  if (fs.existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (e) {
      console.warn('Existing manifest.json is invalid, starting fresh.');
    }
  }

  // Update manifest
  const releaseTag = `v1.0.${timestamp}`; // Temporary tag format
  manifest.latestReleaseTag = releaseTag;
  manifest.updates.push({
    id: updateId,
    assetName: updateFilename,
    sha256: sha256,
    releaseTag: releaseTag
  });

  // Keep only the last 50 updates to prevent manifest bloat
  if (manifest.updates.length > 50) {
    manifest.updates = manifest.updates.slice(-50);
  }

  fs.writeFileSync(path.join(outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  
  // Also write to root for next run (Git will commit this if configured)
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  // 7. Mark as published in Firestore
  console.log('Marking documents as published in Firestore...');
  const batch = db.batch();
  docRefs.forEach(ref => {
    batch.update(ref, { published: true });
  });
  await batch.commit();

  console.log(`Success! Created ${updateFilename} and updated manifest.json.`);
}

sync().catch(err => {
  console.error('Error during sync:', err);
  process.exit(1);
});
