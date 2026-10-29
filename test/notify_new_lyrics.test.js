const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Timestamp } = require('firebase-admin/firestore');

const { messages, notify } = require('../scripts/notify_new_lyrics');

const HOUR = 60 * 60 * 1000;
const lyric = remoteId => ({ remoteId, title: `Title of ${remoteId}` });

// The queue doc as Firestore holds it, and every message sent.
function stand_in() {
  const store = {};
  const sent = [];
  const db = {
    collection: name => ({
      doc: id => ({
        get: async () => ({ data: () => store[`${name}/${id}`] }),
        set: async data => { store[`${name}/${id}`] = data; }
      })
    })
  };
  return { db, sent, store, messaging: { send: async m => { sent.push(m); } } };
}

// The new_lyrics.json a sync run leaves, or none.
function runFile(lyrics) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'notify-')), 'new_lyrics.json');
  if (lyrics) fs.writeFileSync(file, JSON.stringify(lyrics));
  return file;
}

const quiet = t => t.mock.method(console, 'log', () => {});

test('one new lyric opens it; several open Home; each topic in its language', () => {
  const [en, ur] = messages([lyric('a1')]);
  assert.deepEqual(en, {
    topic: 'catalog-updates-v1-en',
    notification: { title: 'New lyric', body: 'Title of a1' },
    data: { schema: '1', type: 'lyric', remoteId: 'a1' }
  });
  assert.equal(ur.topic, 'catalog-updates-v1-ur');
  assert.equal(ur.notification.title, 'نیا کلام');
  assert.deepEqual(ur.data, en.data);

  const several = messages([lyric('a1'), lyric('b2'), lyric('c3')]);
  assert.deepEqual(several.map(m => m.data), [{ schema: '1', type: 'home' }, { schema: '1', type: 'home' }]);
  assert.equal(several[0].notification.body, '3 new lyrics in Kanz e Aza');
  assert.match(several[1].notification.body, /3/);
});

test('at most one notification a day, covering every lyric queued since', async t => {
  quiet(t);
  const { db, sent, store, messaging } = stand_in();
  const start = Date.UTC(2026, 9, 30, 6);

  // First run with new lyrics: nothing sent before, so it goes out at once.
  await notify({ db, messaging, file: runFile([lyric('a1'), lyric('b2')]), now: start });
  assert.equal(sent.length, 2);
  assert.equal(sent[0].data.type, 'home');
  assert.deepEqual(store['notifications/newLyrics'].pending, []);

  // Six hours later: queued, not sent. The same lyric twice is queued once.
  await notify({ db, messaging, file: runFile([lyric('c3'), lyric('c3')]), now: start + 6 * HOUR });
  await notify({ db, messaging, file: runFile([lyric('c3')]), now: start + 12 * HOUR });
  assert.equal(sent.length, 2);
  assert.deepEqual(store['notifications/newLyrics'].pending, [lyric('c3')]);

  // A day after the last one, a run with nothing new sends the queue.
  await notify({ db, messaging, file: runFile(null), now: start + 24 * HOUR });
  assert.equal(sent.length, 4);
  assert.deepEqual(sent[2].data, { schema: '1', type: 'lyric', remoteId: 'c3' });
  assert.equal(store['notifications/newLyrics'].lastSentAt.toMillis(), start + 24 * HOUR);

  // Nothing queued: nothing sent, whatever the time.
  await notify({ db, messaging, file: runFile(null), now: start + 72 * HOUR });
  assert.equal(sent.length, 4);
});

test('a failed send keeps the queue for the next run', async t => {
  quiet(t);
  const { db, store } = stand_in();
  store['notifications/newLyrics'] = { pending: [lyric('a1')], lastSentAt: Timestamp.fromMillis(0) };
  const failing = { send: async () => { throw new Error('messaging/unavailable'); } };

  await assert.rejects(notify({ db, messaging: failing, file: runFile(null), now: Date.now() }));
  assert.deepEqual(store['notifications/newLyrics'].pending, [lyric('a1')]);
});
