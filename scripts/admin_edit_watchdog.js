// Always-on watchdog, run on Coolify: when an Admin's own edit is approved,
// it starts the sync workflow so the edit is published within minutes. When
// it's down, Admin edits wait for the 6-hour batch.
//
//   FIREBASE_SERVICE_ACCOUNT  base64 key of a read-only (Cloud Datastore Viewer) account
//   GITHUB_TOKEN              fine-grained token for this repository, Actions: read and write
const { getDb, isAdminEdit } = require('./sync_firestore_to_github');

const REPO = 'The-Tech-Boi/Kanz-e-Aza-Lyrics';
// Edits approved within a minute of the first go out in one release.
const DEBOUNCE_MS = 60 * 1000;
// Waits between attempts to start the workflow, then it gives up.
const RETRY_MS = [10 * 1000, 60 * 1000, 5 * 60 * 1000];

// The sync workflow, told to publish only if an Admin edit is still waiting.
async function startSync(token = process.env.GITHUB_TOKEN) {
  const response = await fetch(
    `https://api.github.com/repos/${REPO}/actions/workflows/sync_lyrics.yml/dispatches`, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28'
      },
      body: JSON.stringify({ ref: 'main', inputs: { only_if_admin_edit: 'true' } })
    });
  if (!response.ok) throw new Error(`GitHub answered ${response.status}: ${await response.text()}`);
}

// The listener for approved, unpublished submissions. Each one gets at most
// one run, so a failed run isn't retried in a loop; it goes out with the
// 6-hour batch. Nothing is remembered across restarts, so on start-up
// anything already waiting gets one run. Logs counts only, no ids.
function watchdog({ start = startSync, wait = ms => new Promise(r => setTimeout(r, ms)), log = console } = {}) {
  let waiting = [];
  const started = new Set();
  let debouncing = false;

  const run = async () => {
    debouncing = false;
    const ids = waiting.filter(id => !started.has(id));
    if (!ids.length) return;
    ids.forEach(id => started.add(id));
    for (let attempt = 0; ; attempt++) {
      try {
        await start();
        log.log(`Started the sync for ${ids.length} Admin edits.`);
        return;
      } catch (err) {
        if (attempt === RETRY_MS.length) {
          log.error(`Couldn't start the sync; the 6-hour batch publishes ${ids.length} Admin edits.`, err);
          return;
        }
        log.warn(`Starting the sync failed, retrying in ${RETRY_MS[attempt] / 1000} s: ${err.message}`);
        await wait(RETRY_MS[attempt]);
      }
    }
  };

  return snapshot => {
    waiting = snapshot.docs.map(doc => ({ id: doc.id, data: doc.data() })).filter(isAdminEdit).map(({ id }) => id);
    // A published submission leaves the query, and the set with it.
    for (const id of started) if (!waiting.includes(id)) started.delete(id);
    if (!debouncing && waiting.some(id => !started.has(id))) {
      debouncing = true;
      wait(DEBOUNCE_MS).then(run);
    }
  };
}

if (require.main === module) {
  if (!process.env.GITHUB_TOKEN) throw new Error('GITHUB_TOKEN env var is required');
  getDb().collection('submissions')
    .where('status', '==', 'approved')
    .where('published', '==', false)
    // The client retries dropped connections itself; an error here ends the
    // listener, so exit and let Coolify restart it.
    .onSnapshot(watchdog(), err => {
      console.error('Firestore listener failed:', err);
      process.exit(1);
    });
  console.log('Watching for Admin edits.');
}

module.exports = { DEBOUNCE_MS, RETRY_MS, watchdog };
