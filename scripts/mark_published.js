const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

// Marks Firestore submissions as published only after the GitHub release and
// its required assets are confirmed to exist. This keeps Firestore as the final
// confirmation step instead of an optimistic pre-release update.
const serviceAccount = JSON.parse(
  Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT, 'base64').toString('ascii')
);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function githubJson(url, token) {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    }
  });
  if (!response.ok) {
    throw new Error(`GitHub API ${response.status} for ${url}: ${await response.text()}`);
  }
  return response.json();
}

async function findRelease(owner, repo, tag, token) {
  const encodedTag = encodeURIComponent(tag);
  return githubJson(`https://api.github.com/repos/${owner}/${repo}/releases/tags/${encodedTag}`, token);
}

function loadPublishedDocs() {
  const file = path.join(__dirname, '../output/published_docs.json');
  if (!fs.existsSync(file)) {
    throw new Error('output/published_docs.json not found; refusing to mark Firestore published.');
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

async function main() {
  const releaseTag = requireEnv('RELEASE_TAG');
  const githubToken = requireEnv('GITHUB_TOKEN');
  const repository = requireEnv('GITHUB_REPOSITORY');
  const [owner, repo] = repository.split('/');
  const manifestPath = path.join(__dirname, '../output/manifest.json');

  if (!owner || !repo) throw new Error(`Invalid GITHUB_REPOSITORY: ${repository}`);
  if (!fs.existsSync(manifestPath)) throw new Error('output/manifest.json not found.');

  const published = loadPublishedDocs();
  if (published.releaseTag !== releaseTag) {
    throw new Error(`Release tag mismatch: docs=${published.releaseTag} env=${releaseTag}`);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const update = manifest.updates.find(item => item.id === published.updateId);
  if (!update) throw new Error(`Manifest does not contain update ${published.updateId}`);

  console.log(`Verifying GitHub release ${releaseTag} before marking Firestore...`);
  const release = await findRelease(owner, repo, releaseTag, githubToken);
  const assetNames = new Set((release.assets || []).map(asset => asset.name));
  const requiredAssets = ['manifest.json', update.assetName, 'published_docs.json'];

  for (const name of requiredAssets) {
    if (!assetNames.has(name)) {
      throw new Error(`Release ${releaseTag} is missing required asset: ${name}`);
    }
  }

  const docIds = Array.isArray(published.docIds) ? published.docIds.filter(Boolean) : [];
  if (docIds.length === 0) {
    console.log('No Firestore docs listed for publication. Nothing to mark.');
    return;
  }

  console.log(`Marking ${docIds.length} Firestore submissions as published for ${releaseTag}...`);
  let batch = db.batch();
  let count = 0;

  for (const docId of docIds) {
    const ref = db.collection('submissions').doc(docId);
    batch.update(ref, {
      published: true,
      publishedAt: admin.firestore.FieldValue.serverTimestamp(),
      publishedReleaseTag: releaseTag
    });
    count += 1;
    if (count % 500 === 0) {
      await batch.commit();
      batch = db.batch();
    }
  }

  if (count % 500 !== 0) {
    await batch.commit();
  }

  console.log(`Firestore publication flags updated for release ${releaseTag}.`);
}

main().catch(err => {
  console.error('Error marking Firestore published:', err);
  process.exit(1);
});
