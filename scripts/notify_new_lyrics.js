const admin = require('firebase-admin');
const fs = require('fs');
const { getDb, newLyricsPath } = require('./sync_firestore_to_github');

// The app's topics, one per app language (lib/services/push_notifications.dart).
const TOPICS = { en: 'catalog-updates-v1-en', ur: 'catalog-updates-v1-ur' };
const DAY_MS = 24 * 60 * 60 * 1000;

// One message per topic, in its language. The app opens the lyric for one,
// Home for several (schema 1, docs/push-notifications.md in the app repo).
function messages(lyrics) {
  const one = lyrics.length === 1;
  const data = one
    ? { schema: '1', type: 'lyric', remoteId: lyrics[0].remoteId }
    : { schema: '1', type: 'home' };
  return [
    {
      topic: TOPICS.en,
      notification: one
        ? { title: 'New lyric', body: lyrics[0].title }
        : { title: 'New lyrics', body: `${lyrics.length} new lyrics in Kanz e Aza` },
      data
    },
    {
      topic: TOPICS.ur,
      notification: one
        ? { title: 'نیا کلام', body: lyrics[0].title }
        : { title: 'نئے کلام', body: `کنزِ عزا میں ${lyrics.length} نئے کلام` },
      data
    }
  ];
}

// Queues this run's new lyrics, then sends once the last notification is a
// day old: at most one a day, covering every lyric queued since. Runs last in
// the sync, so a failed run queues nothing and the next one publishes again.
// ponytail: a lyric withdrawn while queued still counts; its tap falls back to Home.
async function notify({ db, messaging, file = newLyricsPath, now = Date.now() }) {
  const ref = db.collection('notifications').doc('newLyrics');
  const queue = (await ref.get()).data() ?? {};
  const pending = [...(queue.pending ?? [])];
  const added = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
  for (const lyric of added) {
    if (!pending.some(p => p.remoteId === lyric.remoteId)) pending.push(lyric);
  }
  const lastSent = queue.lastSentAt?.toMillis() ?? 0;
  if (!pending.length || now - lastSent < DAY_MS) {
    if (added.length) await ref.set({ ...queue, pending });
    console.log(`${pending.length} new lyrics queued; nothing sent.`);
    return [];
  }
  const sent = messages(pending);
  for (const message of sent) await messaging.send(message);
  await ref.set({ pending: [], lastSentAt: admin.firestore.Timestamp.fromMillis(now) });
  console.log(`Sent one notification per language for ${pending.length} new lyrics.`);
  return sent;
}

if (require.main === module) {
  const db = getDb();
  notify({ db, messaging: admin.messaging() }).catch(err => {
    console.error('Error sending the new-lyric notification:', err);
    process.exit(1);
  });
}

module.exports = { TOPICS, messages, notify };
