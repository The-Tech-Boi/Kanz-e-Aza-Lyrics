const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const catalog = require('./catalog');

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

const URDU_SCRIPT = /[؀-ۿݐ-ݿ]/;
const cleanName = value =>
  typeof value === 'string' && value.trim() && value.trim() !== 'General' ? value.trim() : undefined;

// The formats Styling keeps from the Writer's Quill delta, each with the
// values it may take. Everything else a delta can hold (links, colours,
// images, other embeds and formats) is dropped.
const STYLING_FORMATS = new Map([
  ['align', ['left', 'center', 'right', 'justify']],
  ['bold', [true]],
  ['italic', [true]],
  ['underline', [true]],
  ['size', ['small', 'large', 'huge']],
  ['list', ['ordered', 'bullet']],
  ['direction', ['rtl']]
]);
// The divider embeds, by the token each is in the body.
const DIVIDERS = new Map([['divider', '<<DIVIDER>>'], ['mini-divider', '<<MINI>>']]);

// A submission's contentDelta cleaned to Styling: its text and divider
// inserts with only the formats above. Undefined when it is missing,
// unreadable or left without any format. Urdu loses `direction`, which would
// run its lines left to right, but keeps every `align`: the Writer reads
// left and right as the line's start and end.
function cleanStyling(contentDelta, language) {
  let ops;
  try {
    ops = JSON.parse(contentDelta);
  } catch {
    return undefined;
  }
  if (!Array.isArray(ops)) return undefined;
  const styling = [];
  for (const op of ops) {
    const insert = op?.insert;
    const divider = insert !== null && typeof insert === 'object' &&
      [...DIVIDERS.keys()].find(key => key in insert);
    if (typeof insert !== 'string' && !divider) continue;
    const attributes = Object.fromEntries(Object.entries(op.attributes ?? {}).filter(([key, value]) =>
      STYLING_FORMATS.get(key)?.includes(value) && !(key === 'direction' && language === 'Urdu')));
    styling.push({
      insert: divider ? { [divider]: '' } : insert,
      ...(Object.keys(attributes).length && { attributes })
    });
  }
  return styling.some(op => op.attributes) ? styling : undefined;
}

// The body the Writer saves for `styling`, rebuilt as the app's
// plainTextWithDividersFromDelta (lib/features/writer/lyric_document_codec.dart)
// does: each divider is its token, on a line of its own even when the
// delta has it inside a line.
function stylingBody(styling) {
  let body = '';
  let atLineStart = true;
  let afterToken = false;
  for (const { insert } of styling) {
    const isToken = typeof insert !== 'string';
    const text = isToken ? DIVIDERS.get(Object.keys(insert)[0]) : insert;
    if ((isToken && !atLineStart) || (afterToken && !text.startsWith('\n'))) body += '\n';
    body += text;
    atLineStart = text.endsWith('\n');
    afterToken = isToken;
  }
  return body;
}

const withoutTrailingLines = text => String(text).replace(/\n+$/, '');

// An approved submission as a Catalog record. Built from an allow-list, so
// contributor fields (ownerUid, termsVersion, ...) never reach the Catalog.
// Documents from before contract v1 get its values: `category` becomes
// `categories`, a missing language is read from the title's script, and
// "General" or a group that isn't a year is left out.
// Styling is kept only when its words are the body's, line for line, or
// readers would style the wrong lines; otherwise `onStylingDropped` is called.
function toRecord(remoteId, data, onStylingDropped = () => {}) {
  const categories = Array.isArray(data.categories) && data.categories.length
    ? data.categories
    : [normalizeCategory(data.category)];
  const year = Number.isInteger(data.group) ? data.group
    : /^\d{4}$/.test(String(data.group ?? '')) ? Number(data.group) : undefined;
  const language = data.language || (URDU_SCRIPT.test(data.title ?? '') ? 'Urdu' : 'Roman Urdu');
  let styling = cleanStyling(data.contentDelta, language);
  if (styling && withoutTrailingLines(stylingBody(styling)) !== withoutTrailingLines(data.body)) {
    styling = undefined;
    onStylingDropped();
  }
  const record = {
    remoteId,
    title: data.title,
    body: data.body,
    ...(styling && { styling }),
    language,
    categories
  };
  if (cleanName(data.subcategory)) record.subcategory = cleanName(data.subcategory);
  if (year !== undefined) record.group = year;
  if (cleanName(data.author)) record.author = cleanName(data.author);
  record.anjumans = Array.isArray(data.anjumans) ? data.anjumans : [];
  record.verified = data.isVerified === true;
  return record;
}

// A Catalog record as an item of an old-shape update file, for a manifest
// without a contractVersion. This repository's manifest has "1.0.0", so its
// updates carry whole records instead (buildPayload). This shape has no
// Styling.
function toUpdateItem(record) {
  const { remoteId, categories, anjumans } = record;
  const item = {
    remoteId,
    title: record.title,
    body: record.body,
    category: categories[0],
    categories,
    subcategory: record.subcategory || 'General',
    group: record.group || 'General',
    isVerified: record.verified,
    source: 'firestore'
  };
  if (record.author) item.author = record.author;
  item.language = record.language;
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

// An admin edit is a submission the same admin sent and approved: its
// ownerUid equals its approvedBy. A reader's suggestion an admin approved has
// another ownerUid. `docs` are `{ id, data }`.
const isAdminEdit = ({ data }) => Boolean(data.ownerUid) && data.ownerUid === data.approvedBy;
const hasAdminEdit = docs => docs.some(isAdminEdit);

const newestApproval = docs => docs.reduce((newest, doc) =>
  millis(doc.data.approvedAt) >= millis(newest.data.approvedAt) ? doc : newest);

// The names an approval may use: the Owner's approved Personalities (the
// built-in ones until the Owner saves a list), and every Personality and
// Anjuman the Catalog has. Contributors choose from these and can't add
// others; the Owner adds Anjumans through the Catalog.
function allowedNames(lyrics, personalities) {
  const builtIn = [...catalog.subjectsByCategory().values()].flat();
  const records = [...lyrics.values()];
  return {
    personalities: new Set([...(personalities ?? builtIn), ...records.map(r => r.subcategory).filter(Boolean)]),
    anjumans: new Set(records.flatMap(r => r.anjumans))
  };
}

// The first name in `record` that isn't allowed, as a problem, or null.
// `kept` is the lyric as last published, whose own names stay allowed.
function unapprovedName(record, allowed, kept) {
  const { subcategory, anjumans } = record;
  if (subcategory !== undefined && !allowed.personalities.has(subcategory) && subcategory !== kept?.subcategory) {
    return `the Personality ${JSON.stringify(subcategory)} is not on the approved list`;
  }
  const anjuman = anjumans.find(name => !allowed.anjumans.has(name) && !kept?.anjumans.includes(name));
  return anjuman === undefined ? null : `the Anjuman ${JSON.stringify(anjuman)} is not in the Catalog`;
}

// What one run writes into the Catalog, from Firestore.
//   submissions    approved `submissions` docs, published or not
//   decisions      every `catalogWithdrawals` doc
//   verifications  every `catalogVerifications` doc: an Admin's Verify or
//                  Unverify of a Published Lyric, waiting for this run
//   lyrics         the Catalog before the run (remoteId -> record)
//   lastVersion    a deleted lyric's last record, from git history, or null
//   firstAdded     when a lyric's file first came into the Catalog (ms), or null
//   personalities  the Owner's approved Personalities (taxonomy/personalities
//                  names), or undefined until the Owner saves them
// Docs are `{ id, data }`. Returns the records to write and the lyrics to
// delete, each with the kind of change for the commit message; the
// submission ids, decisions and verifications to mark published; the
// restores that couldn't be found (left pending, unmarked); approvals
// held, each with the submission held and why; and how many approvals lost their
// Styling because its words weren't the body's.
function planUpdate({
  submissions, decisions, verifications = [], lyrics = new Map(), lastVersion = () => null, firstAdded = () => null,
  personalities
}) {
  const withdrawn = new Set(
    decisions.filter(({ data }) => data.withdrawn === true).map(({ id }) => id)
  );
  const restoring = new Set(pendingRestores(decisions).map(({ remoteId }) => remoteId));

  // A submission without `revisionOfRemoteId` is a new lyric under its own
  // ID. Changes to a Published Lyric come only as Revision Submissions, so
  // an unpublished one created after a lyric with its ID came into the
  // Catalog is held instead of replacing that lyric. The submission a lyric
  // was published from is older than its file, so it still goes out when
  // it changed during the run that published it, or wasn't marked.
  const takesPublishedId = ({ id, data }) => {
    if (data.revisionOfRemoteId || data.published !== false) return false;
    const added = firstAdded(id);
    return added !== null && millis(data.createdAt) > added;
  };

  // Approved submissions by the lyric they publish. A Revision Submission is
  // its own document whose `revisionOfRemoteId` names the lyric it replaces.
  const approvals = new Map();
  const held = [];
  for (const doc of submissions) {
    if (takesPublishedId(doc)) {
      held.push({ remoteId: doc.id, id: doc.id, problem: 'a Published Lyric has this ID; send a change to it as a revision' });
      continue;
    }
    const remoteId = doc.data.revisionOfRemoteId || doc.id;
    approvals.set(remoteId, [...(approvals.get(remoteId) ?? []), doc]);
  }

  // The newest approval wins. Every unpublished document is still marked, so
  // a later run can't publish an older version over it. An approval whose
  // record is invalid is held, neither written nor marked.
  const unpublished = docs => docs.filter(({ data }) => data.published === false);
  const writes = new Map();
  const deletes = new Map();
  const submissionIds = [];
  let unstyled = 0;
  const allowed = allowedNames(lyrics, personalities);
  const publish = (remoteId, docs, kind) => {
    const newest = newestApproval(docs);
    const record = toRecord(remoteId, newest.data, () => unstyled++);
    // A Revision Submission doesn't change Anjuman membership: the lyric
    // keeps the Anjumans the Catalog has, or had before a Withdrawal.
    const published = newest.data.revisionOfRemoteId && (lyrics.get(remoteId) ?? lastVersion(remoteId));
    if (published) record.anjumans = published.anjumans;
    // Verified belongs to the text: an edit that keeps the title and body
    // keeps the Catalog's flag; one that changes them brings its own. The
    // Writer's body ends with a line break, so trailing empty lines don't count.
    const current = lyrics.get(remoteId);
    if (current && current.title === record.title &&
        withoutTrailingLines(current.body) === withoutTrailingLines(record.body)) {
      record.verified = current.verified;
    }
    const problem = catalog.recordProblem(record) ??
      unapprovedName(record, allowed, current ?? lastVersion(remoteId));
    if (problem) {
      held.push({ remoteId, id: newest.id, problem });
      return false;
    }
    kind ??= lyrics.has(remoteId) ? (isAdminEdit(newest) ? 'admin edit' : 'suggested edit')
      : restoring.has(remoteId) ? 'restore' : 'new';
    writes.set(remoteId, { record, kind });
    submissionIds.push(...unpublished(docs).map(({ id }) => id));
    return true;
  };

  for (const [remoteId, docs] of approvals) {
    // The Owner's withdrawal wins over an approval: held, neither published
    // nor marked, until the Owner restores the lyric.
    if (withdrawn.has(remoteId)) continue;
    if (unpublished(docs).length) publish(remoteId, docs);
  }

  // A restore writes the lyric back: an approval held while it was withdrawn,
  // else its last version from git history, else its newest approval. A
  // withdrawal that never reached the Catalog needs nothing written.
  const restores = [];
  const unresolved = [];
  for (const restore of pendingRestores(decisions)) {
    const { remoteId } = restore;
    if (!lyrics.has(remoteId) && !writes.has(remoteId)) {
      const docs = approvals.get(remoteId) ?? [];
      const last = unpublished(docs).length ? null : lastVersion(remoteId);
      if (last) {
        writes.set(remoteId, { record: last, kind: 'restore' });
      } else if (!docs.length || !publish(remoteId, docs, 'restore')) {
        unresolved.push(remoteId);
        continue;
      }
    }
    restores.push(restore);
  }

  // Verify/Unverify changes only the flag of the lyric as this run leaves
  // it. The later of a Verify and an approval wins: an approval since
  // decided the flag itself. A Verify of a withdrawn lyric, or of one the
  // Catalog doesn't have yet, waits, unmarked.
  const verified = [];
  for (const doc of verifications) {
    const remoteId = doc.id;
    const docs = approvals.get(remoteId);
    if (docs && millis(newestApproval(docs).data.approvedAt) > millis(doc.data.updatedAt)) {
      verified.push(doc);
      continue;
    }
    const current = writes.get(remoteId)?.record ?? lyrics.get(remoteId);
    if (withdrawn.has(remoteId) || !current) continue;
    verified.push(doc);
    const flag = doc.data.verified === true;
    if (current.verified !== flag) {
      writes.set(remoteId, {
        record: { ...current, verified: flag },
        kind: writes.get(remoteId)?.kind ?? (flag ? 'verified' : 'unverified')
      });
    }
  }

  const withdrawals = pendingWithdrawals(decisions);
  for (const { remoteId } of withdrawals) {
    if (lyrics.has(remoteId)) deletes.set(remoteId, { title: lyrics.get(remoteId).title, kind: 'withdrawal' });
  }
  return {
    writes,
    deletes,
    submissionIds,
    decisions: [...withdrawals, ...restores],
    verifications: verified.map(({ id, updateTime }) => ({ remoteId: id, updateTime })),
    unresolved,
    held,
    unstyled
  };
}

// The lyrics whose Firestore change has to wait for a later run: the plan's
// changes to the Catalog beyond the first `room`, the longest waiting first.
// `lyrics` is the Catalog before the run; `firestore` the docs the plan read.
// An approval that leaves its file as it is costs no room.
function waitingChanges(plan, lyrics, { submissions, decisions, verifications }, room) {
  // When each lyric's oldest change still waiting in Firestore came in (ms).
  const since = new Map();
  const add = (remoteId, ms) => since.set(remoteId, Math.min(since.get(remoteId) ?? Infinity, ms));
  for (const { id, data } of submissions) {
    if (data.published === false) add(data.revisionOfRemoteId || id, millis(data.approvedAt));
  }
  for (const { remoteId, updatedAt } of unpublishedDecisions(decisions)) add(remoteId, updatedAt);
  for (const { id, data } of verifications) add(id, millis(data.updatedAt));

  const changes = [
    ...[...plan.writes]
      .filter(([id, { record }]) => !lyrics.has(id) || catalog.serialize(record) !== catalog.serialize(lyrics.get(id)))
      .map(([id]) => id),
    ...plan.deletes.keys()
  ];
  changes.sort((a, b) => (since.get(a) ?? 0) - (since.get(b) ?? 0));
  return new Set(changes.slice(room));
}

// `plan` without its changes to `remoteIds`: neither written nor marked, so
// they stay pending in Firestore and the next run publishes them.
function withoutLyrics(plan, remoteIds, submissions) {
  const lyricOf = new Map(submissions.map(({ id, data }) => [id, data.revisionOfRemoteId || id]));
  const keep = remoteId => !remoteIds.has(remoteId);
  return {
    ...plan,
    writes: new Map([...plan.writes].filter(([remoteId]) => keep(remoteId))),
    deletes: new Map([...plan.deletes].filter(([remoteId]) => keep(remoteId))),
    submissionIds: plan.submissionIds.filter(id => keep(lyricOf.get(id))),
    decisions: plan.decisions.filter(({ remoteId }) => keep(remoteId)),
    verifications: plan.verifications.filter(({ remoteId }) => keep(remoteId))
  };
}

const CONTRACT_VERSION = '1.0.0';

// The update file for `records` and `removed`, or null when both are empty.
// The manifest's contractVersion says which shape readers take: none means
// the old shape every installed build reads. `removed` goes beside `items`,
// not in it: older builds fail on an entry there without a title, but ignore
// other keys.
function buildPayload(records, removed, contractVersion) {
  if (!records.length && !removed.length) return null;
  const payload = contractVersion === CONTRACT_VERSION
    ? { contractVersion, items: records }
    : { items: records.map(toUpdateItem) };
  return removed.length ? { ...payload, removed } : payload;
}

// The update files for `records` then `removed`, in that order, as written:
// as few as hold at most UPDATE_ENTRIES entries and UPDATE_BYTES bytes each.
// Changes that fit one file make the one file earlier runs wrote, byte for byte.
function splitUpdate(records, removed, contractVersion) {
  const entries = [...records, ...removed];
  const text = (from, to) => {
    const part = entries.slice(from, to);
    const payload = buildPayload(
      part.filter(entry => typeof entry !== 'string'), part.filter(entry => typeof entry === 'string'), contractVersion);
    return JSON.stringify(payload, null, 2) + '\n';
  };
  const fits = (from, to) => Buffer.byteLength(text(from, to)) <= catalog.UPDATE_BYTES;
  const files = [];
  for (let from = 0; from < entries.length;) {
    // The most entries from `from` that fit, found by halving.
    let low = from + 1;
    let high = Math.min(from + catalog.UPDATE_ENTRIES, entries.length);
    if (fits(from, high)) low = high;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (fits(from, middle)) low = middle;
      else high = middle - 1;
    }
    if (!fits(from, low)) {
      throw new Error(`${entries[from].remoteId}: one lyric over ${catalog.UPDATE_BYTES} bytes as an update file. Nothing published.`);
    }
    files.push(text(from, low));
    from = low;
  }
  return files;
}

// Every update stays listed. The website and a fresh install build the
// catalog from the bundled base catalog plus every update in this list, so
// an update dropped from it takes its lyrics and withdrawals with it.
// `catalogTree` is the git tree of lyrics/ readers have once they apply it;
// the next run publishes what changed since.
function applyUpdateToManifest(manifest, { updateId, updateFilename, sha256, releaseTag, catalogTree }) {
  return {
    ...manifest,
    manifestVersion: 1,
    latestReleaseTag: releaseTag,
    catalogTree,
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

// The sync bot's commit message: each change by title and kind. It names no
// Contributor or Admin.
function commitMessage(changes) {
  const lines = changes.map(({ title, kind }) => `- ${title}: ${kind}`);
  const count = changes.length === 1 ? '1 lyric change' : `${changes.length} lyric changes`;
  return `Publish ${count} [skip ci]\n\n${lines.join('\n')}\n`;
}

const marksPath = path.join(__dirname, '../publish_marks.json');
const messagePath = path.join(__dirname, '../commit_message.txt');
// For notify_new_lyrics.js: the lyrics this run published as new.
const newLyricsPath = path.join(__dirname, '../new_lyrics.json');

function checkLyricFiles(dir) {
  const problems = catalog.problems(dir);
  if (problems.length) {
    throw new Error(`Invalid lyric files, nothing published:\n${problems.join('\n')}`);
  }
}

// One run: write what Firestore approved into lyrics/, check every lyric
// file, then publish everything in lyrics/ that changed since the tree the
// manifest names, whoever changed it.
async function sync(db = getDb(), dir = path.join(__dirname, '..')) {
  const releaseTag = getRequiredReleaseTag();
  const manifestPath = path.join(dir, 'manifest.json');
  let manifest = loadManifest(manifestPath);
  if (!manifest.catalogTree) {
    throw new Error('manifest.json has no catalogTree: the tree of lyrics/ readers already have.');
  }

  console.log('Fetching approved lyrics from Firestore...');
  const docs = snapshot => snapshot.docs.map(doc => ({ id: doc.id, data: doc.data() }));
  // A run the watchdog starts publishes only for an admin edit; once it does,
  // everything waiting goes out with it. Readers' suggestions wait for the
  // 6-hour run.
  // Only the unpublished submissions are read to decide, so a quiet run is cheap.
  if (process.env.ONLY_IF_ADMIN_EDIT === '1') {
    const waiting = docs(await db.collection('submissions')
      .where('status', '==', 'approved')
      .where('published', '==', false)
      .get());
    if (!hasAdminEdit(waiting)) {
      console.log('No admin edit waiting; the next 6-hour run publishes the rest.');
      return;
    }
  }

  checkLyricFiles(dir);
  const before = catalog.readCatalog(dir);
  // Published ones too: a restore may send the lyric's newest approved
  // version, and an approval newer than a Verify decides the flag.
  const approved = await db.collection('submissions').where('status', '==', 'approved').get();
  const firestore = {
    submissions: docs(approved),
    decisions: docs(await db.collection('catalogWithdrawals').get()),
    // Only waiting ones: --mark-published deletes each once it is out. The
    // exact updateTime lets it delete only a doc nobody changed since.
    verifications: (await db.collection('catalogVerifications').get()).docs.map(doc => ({
      id: doc.id,
      data: doc.data(),
      updateTime: { seconds: doc.updateTime.seconds, nanoseconds: doc.updateTime.nanoseconds }
    }))
  };
  let plan = planUpdate({
    ...firestore,
    lyrics: before,
    lastVersion: remoteId => catalog.lastVersion(remoteId, dir),
    firstAdded: remoteId => catalog.firstAdded(remoteId, dir),
    personalities: docs(await db.collection('taxonomy').get()).find(({ id }) => id === 'personalities')?.data.names
  });
  // Only a count: which lyric, and why, go onto the Submission for Admins.
  if (plan.held.length) {
    console.warn(`${plan.held.length} approval(s) held, not published; each Submission says why.`);
  }
  for (const remoteId of plan.unresolved) {
    console.warn(`Restore of ${remoteId} not published: no approval or earlier file has it. It stays pending.`);
  }
  // Only a count: which lyric, and what its Styling said, stay out of the
  // public workflow log.
  if (plan.unstyled) {
    console.warn(`Styling left out of ${plan.unstyled} approval(s): its words differ from the body.`);
  }

  // A run publishes at most RUN_LYRICS changed lyrics; the rest wait for the
  // next runs. First what lyrics/ gained since the last update (the Owner's
  // merged pull requests), whole commits in order, then Firestore's changes,
  // the longest waiting first.
  const baseline = manifest.catalogTree;
  const changeCount = tree => {
    const { added, changed, removed } = catalog.changesBetween(baseline, tree, dir);
    return added.length + changed.length + removed.length;
  };
  const committed = changeCount(catalog.catalogTree(dir));
  // When lyrics/ as it is now is over the limit: the newest commit on main
  // whose lyrics/ is within it. Its tree is in history, so the next run can
  // compare with it.
  let target;
  if (committed > catalog.RUN_LYRICS) {
    const commits = catalog.commitsSince(baseline, dir).map(c => ({ ...c, count: changeCount(c.tree) }));
    target = commits.findLast(({ count }) => count > 0 && count <= catalog.RUN_LYRICS);
    if (!target) {
      const over = commits.find(({ count }) => count > catalog.RUN_LYRICS);
      throw new Error(`${committed} lyrics changed in lyrics/ since the last update, over the ${catalog.RUN_LYRICS} a run publishes, ` +
        (over ? `and commit ${over.commit} alone changes ${over.count}. Revert it and merge its changes in pull requests of at most ${catalog.RUN_LYRICS}.`
          : 'and no commit on main since the last update changes fewer.') + ' Nothing published.');
    }
    console.log(`Publishing lyrics/ as of ${target.commit}; the later commits wait for the next run.`);
  }
  const waiting = waitingChanges(plan, before, firestore, target ? 0 : catalog.RUN_LYRICS - committed);
  if (waiting.size) {
    plan = withoutLyrics(plan, waiting, firestore.submissions);
    console.log(`${waiting.size} approved change(s) wait for the next run.`);
  }

  for (const { record } of plan.writes.values()) catalog.writeLyric(record, dir);
  for (const remoteId of plan.deletes.keys()) catalog.deleteLyric(remoteId, dir);
  checkLyricFiles(dir);

  // What --mark-published marks. Kept out of output/, which the release
  // uploads: submission ids aren't catalog data. Each submission with the
  // exact updateTime this run read, so only a version nobody changed since
  // is marked. `held` are the held submissions whose stored reason is not
  // this run's. `withdrawals` lists the catalogWithdrawals docs published,
  // withdrawals and restores alike. Written even when the Catalog already
  // had everything, so an approval a failed run wrote is still marked.
  const read = new Map(approved.docs.map(doc => [doc.id, doc]));
  const updateTime = id => {
    const { seconds, nanoseconds } = read.get(id).updateTime;
    return { seconds, nanoseconds };
  };
  const held = plan.held
    .filter(({ id, problem }) => read.get(id).data().held?.reason !== problem)
    .map(({ id, problem }) => ({ id, reason: problem, updateTime: updateTime(id) }));
  const writeMarks = () => {
    if (!plan.submissionIds.length && !held.length && !plan.decisions.length && !plan.verifications.length) return;
    const submissions = plan.submissionIds.map(id => ({ id, updateTime: updateTime(id) }));
    fs.writeFileSync(path.join(dir, path.basename(marksPath)), JSON.stringify(
      { submissions, held, withdrawals: plan.decisions, verifications: plan.verifications },
      null, 2) + '\n');
  };

  const published = target?.tree ?? catalog.catalogTree(dir);
  const { added, changed, removed } = catalog.changesBetween(baseline, published, dir);
  // This run's approvals first, in the order the plan wrote them.
  const edited = new Set([...added, ...changed]);
  const ids = [...new Set([...[...plan.writes.keys()].filter(id => edited.has(id)), ...edited])];
  if (!ids.length && !removed.length) {
    writeMarks();
    console.log('No lyric changed since the last update.');
    return;
  }
  // As in the tree published. An earlier commit's file may since have been
  // fixed, and readers refuse a whole update for one bad record.
  const records = catalog.recordsIn(published, ids, dir);
  const invalid = ids.map(id => [id, catalog.recordProblem(records.get(id))]).filter(([, problem]) => problem);
  if (invalid.length) {
    throw new Error(`Invalid lyric files in ${target?.commit ?? 'lyrics/'}, nothing published:\n` +
      invalid.map(([id, problem]) => `${catalog.lyricPath(id)}: ${problem}`).join('\n'));
  }
  console.log(`Publishing ${ids.length} changed lyrics and ${removed.length} removals.`);

  // update_<ms>, 1 ms apart: unique and increasing, in the order readers apply them.
  const firstId = Date.now();
  const updates = splitUpdate(ids.map(id => records.get(id)), removed, manifest.contractVersion)
    .map((text, i) => ({ updateFilename: `update_${firstId + i}.json`, text }));
  for (const { updateFilename, text } of updates) {
    manifest = applyUpdateToManifest(manifest, {
      updateId: path.basename(updateFilename, '.json'),
      updateFilename,
      // Hash the exact bytes published; the app rejects an update whose hash differs.
      sha256: crypto.createHash('sha256').update(text).digest('hex'),
      releaseTag,
      catalogTree: published
    });
  }
  const limits = catalog.updateProblems(manifest, updates.map(({ updateFilename, text }) => [updateFilename, text]));
  for (const warning of limits.warnings) console.warn(warning);
  if (limits.problems.length) {
    throw new Error(`Update limits broken, nothing published:\n${limits.problems.join('\n')}`);
  }

  const outputDir = path.join(dir, 'output');
  fs.mkdirSync(outputDir, { recursive: true });
  for (const { updateFilename, text } of updates) fs.writeFileSync(path.join(outputDir, updateFilename), text);
  const manifestStr = JSON.stringify(manifest, null, 2) + '\n';
  fs.writeFileSync(path.join(outputDir, 'manifest.json'), manifestStr);
  fs.writeFileSync(manifestPath, manifestStr);
  writeMarks();

  catalog.writeIndex([...catalog.readCatalog(dir).values()], dir);
  const kindOf = (id, fallback) => plan.writes.get(id)?.kind ?? fallback;
  fs.writeFileSync(path.join(dir, path.basename(messagePath)), commitMessage([
    ...ids.map(id => ({ title: records.get(id).title, kind: kindOf(id, added.includes(id) ? 'new' : 'Owner edit') })),
    ...removed.map(id => plan.deletes.get(id) ?? { title: catalog.recordIn(baseline, id, dir).title, kind: 'removed' })
  ]));
  // New to readers: a restore brings back a lyric they had.
  const fresh = added.filter(id => plan.writes.get(id)?.kind !== 'restore');
  if (fresh.length) {
    fs.writeFileSync(path.join(dir, path.basename(newLyricsPath)), JSON.stringify(
      fresh.map(id => ({ remoteId: id, title: records.get(id).title })), null, 2) + '\n');
  }
  console.log(`Success! Created ${updates.map(({ updateFilename }) => updateFilename).join(', ')} and updated manifest.json.`);
}

// Counts the docs `write` changed. Each write has the updateTime this run
// read as precondition, and runs on its own, so a doc changed since
// (FAILED_PRECONDITION) or gone (NOT_FOUND) is skipped without stopping the
// others; the next run reads it as it is now.
async function writeUnchanged(docs, write) {
  let written = 0;
  for (const doc of docs) {
    try {
      await write(doc, { lastUpdateTime: new admin.firestore.Timestamp(doc.updateTime.seconds, doc.updateTime.nanoseconds) });
      written++;
    } catch (err) {
      if (err.code !== 9 && err.code !== 5) throw err;
    }
  }
  return written;
}

// Runs as the workflow's last step, after the release exists. If any earlier
// step fails, the lyrics stay unpublished and the next run publishes them again.
async function markPublished(file = marksPath, db = getDb()) {
  const { submissions = [], held = [], withdrawals = [], verifications = [] } =
    JSON.parse(fs.readFileSync(file, 'utf8'));
  const { FieldValue, Timestamp } = admin.firestore;
  // A submission changed since this run read it (rejected, edited and
  // approved again, say) stays unpublished: the next run publishes the
  // version it has now. A published one is no longer held.
  const marked = await writeUnchanged(submissions, ({ id }, precondition) =>
    db.collection('submissions').doc(id).update({ published: true, held: FieldValue.delete() }, precondition));
  // Why an approval is held, for the Admins' queues. One an Admin changed
  // since is left for the next run to judge again.
  const flagged = await writeUnchanged(held, ({ id, reason }, precondition) =>
    db.collection('submissions').doc(id).update({ held: { reason, at: Timestamp.now() } }, precondition));
  // Withdrawals and restores. The updatedAt this run saw: if the Owner
  // changed the decision since, updatedAt stays newer and the next run
  // publishes it again.
  const batch = db.batch();
  for (const { remoteId, updatedAt } of withdrawals) {
    batch.update(db.collection('catalogWithdrawals').doc(remoteId), {
      publishedAt: admin.firestore.Timestamp.fromMillis(updatedAt)
    });
  }
  await batch.commit();
  // A published Verify is deleted, unless an Admin changed it since this run
  // read it; then it waits for the next run.
  const deleted = await writeUnchanged(verifications, ({ remoteId }, precondition) =>
    db.collection('catalogVerifications').doc(remoteId).delete(precondition));
  console.log(`Marked ${marked} submissions, ${withdrawals.length} withdrawals and ${deleted} verifications as published; ${flagged} submissions held.`);
}

if (require.main === module) {
  const [mode, file] = process.argv.slice(2);
  (mode === '--mark-published' ? markPublished(file) : sync()).catch(err => {
    console.error('Error during sync:', err);
    process.exit(1);
  });
}

module.exports = {
  CONTRACT_VERSION,
  applyUpdateToManifest,
  buildPayload,
  commitMessage,
  getDb,
  getRequiredReleaseTag,
  hasAdminEdit,
  isAdminEdit,
  loadManifest,
  markPublished,
  newLyricsPath,
  normalizeCategory,
  pendingRestores,
  pendingWithdrawals,
  planUpdate,
  splitUpdate,
  sync,
  toRecord,
  toUpdateItem
};
