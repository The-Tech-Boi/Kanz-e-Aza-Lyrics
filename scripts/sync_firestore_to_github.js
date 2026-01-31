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

// Helper to calculate content hash
function calculateHash(data) {
  const content = `${data.title || ''}|${data.body || ''}|${data.category || ''}|${data.subcategory || ''}|${data.group || ''}`;
  return crypto.createHash('md5').update(content).digest('hex');
}

async function sync() {
  console.log('Starting Smart Sync (Content Hashing)...');

  // 1. Load Registry (stores last known hashes)
  const registryPath = path.join(__dirname, '../lyric_registry.json');
  let registry = {};
  if (fs.existsSync(registryPath)) {
    try {
      registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    } catch (e) {
      console.warn('Warning: lyric_registry.json is invalid, starting fresh.');
    }
  }

  // 2. Query ALL approved lyrics
  console.log('Fetching all approved lyrics from Firestore...');
  const snapshot = await db.collection('submissions')
    .where('status', '==', 'approved')
    .get();

  if (snapshot.empty) {
    console.log('No approved lyrics found in Firestore.');
    process.exit(0);
  }

  // 3. Identify changes (New or Edited)
  const changedLyrics = [];
  const docRefsToMarkPublished = [];

  snapshot.forEach(doc => {
    const data = doc.data();
    const currentHash = calculateHash(data);
    const lastHash = registry[doc.id];

    // If it's new OR if the content has changed
    if (!lastHash || lastHash !== currentHash) {
      console.log(`Change detected in lyric: ${data.title} (${doc.id})`);
      changedLyrics.push({
        remoteId: doc.id,
        title: data.title,
        body: data.body,
        category: data.category || 'Nohay',
        subcategory: data.subcategory || 'General',
        group: data.group || 'General',
        createdBy: data.createdBy || 'unknown',
        source: 'firestore'
      });

      // Update registry in memory
      registry[doc.id] = currentHash;

      // If it wasn't published before, we'll mark it now
      if (data.published !== true) {
        docRefsToMarkPublished.push(doc.ref);
      }
    }
  });

  if (changedLyrics.length === 0) {
    console.log('No changes detected since last sync.');
    process.exit(0);
  }

  console.log(`Syncing ${changedLyrics.length} changes (new/edits).`);

  const timestamp = Date.now();
  const updateId = `update_${timestamp}`;
  const updateFilename = `${updateId}.json`;
  const payload = { items: changedLyrics };

  // 4. Create output directory
  const outputDir = path.join(__dirname, '../output');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // 5. Write update file
  const payloadStr = JSON.stringify(payload, null, 2);
  fs.writeFileSync(path.join(outputDir, updateFilename), payloadStr);

  // 6. Calculate payload SHA256 for manifest
  const payloadSha256 = crypto.createHash('sha256').update(payloadStr).digest('hex');

  // 7. Handle Manifest
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
      console.warn('Existing manifest.json is invalid.');
    }
  }

  // Update manifest with new release info
  const releaseTag = `v1.0.${timestamp}`;
  manifest.latestReleaseTag = releaseTag;
  manifest.updates.push({
    id: updateId,
    assetName: updateFilename,
    sha256: payloadSha256,
    releaseTag: releaseTag
  });

  // Limit manifest to last 50 updates
  if (manifest.updates.length > 50) {
    manifest.updates = manifest.updates.slice(-50);
  }

  // Write files for the GitHub Action to pick up (both to root and output)
  fs.writeFileSync(path.join(outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  // Save registry back to disk (this MUST be committed back to repo)
  fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2));

  // 8. Mark as published in Firestore (as backup logic)
  if (docRefsToMarkPublished.length > 0) {
    console.log(`Marking ${docRefsToMarkPublished.length} docs as published in Firestore...`);
    const batch = db.batch();
    docRefsToMarkPublished.forEach(ref => {
      batch.update(ref, { published: true });
    });
    await batch.commit();
  }

  console.log(`Success! Created ${updateFilename}, updated manifest and registry.`);
}

sync().catch(err => {
  console.error('Error during sync:', err);
  process.exit(1);
});
