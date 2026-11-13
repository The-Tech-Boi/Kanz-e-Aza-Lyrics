// The Catalog: the current version of every Published Lyric, one file each
// under lyrics/, in the v1 canonical record shape of the RomanUrduLyricsApp
// repository (shared/lyric_metadata/v1/lyric.schema.json) without
// `published`. The sync and the pull request check both read it here.
//
//   node scripts/catalog.js check [<base>]
// checks every lyric file and the update limits and, given a base commit,
// refuses deleted lyric files, and warns, failing, on more lyric changes than one run publishes.
//   node scripts/catalog.js updates <dir>
// checks the update limits on the manifest and update files the sync wrote to <dir>.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');

// The v1 schema's category enum. Categories the Owner adds are any name the
// website's rules take (NAME).
const CANONICAL_CATEGORIES = ['Nohay', 'Manqabat', 'Salaams', 'Marsiya', 'Munajat', 'Qasida'];
const FIELDS = [
  'remoteId', 'title', 'body', 'styling', 'language', 'categories', 'subcategory', 'group',
  'author', 'anjumans', 'verified'
];
// firestore.rules' validNames: 1 to 100 characters on one line, no outer spaces.
const NAME = /^[^\t\n\f\r ](?:[^\n]{0,98}[^\t\n\f\r ])?$/u;
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

// What readers apply in one go. Installed 1.1.2 and 1.1.3 phones apply every
// listed update back to back, each file in one transaction on a busy thread.
// Raise RUN_LYRICS, or drop it, once most phones run 1.1.4.
const RUN_LYRICS = 2000; // changed lyrics (records plus removals) one sync run publishes
const UPDATE_ENTRIES = 500; // items plus removed ids in one update file
const UPDATE_BYTES = 2000000; // one update file as written
const MANIFEST_WARN = 500; // listed updates
const MANIFEST_UPDATES = 1000;
// Listed before these limits, and phones have applied it: splitting or
// renaming it would make them apply it again.
const OVER_LIMIT = new Set(['update_1793650281638']);

// The built-in Personalities of each canonical Category, in taxonomy order.
let subjects;
function subjectsByCategory() {
  if (!subjects) {
    const taxonomy = JSON.parse(fs.readFileSync(path.join(root, 'taxonomy.json'), 'utf8'));
    subjects = new Map(CANONICAL_CATEGORIES.map(category => {
      const list = [...taxonomy.baseSubjects];
      for (const { value, insertAfter } of taxonomy.categoryExceptions[category]?.additionalSubjects ?? []) {
        list.splice(list.indexOf(insertAfter) + 1, 0, value);
      }
      return [category, list];
    }));
  }
  return subjects;
}

// Where a lyric's file lives: folders by the remoteId's last two characters,
// lowercase so Windows checkouts work, never by Category, so a file never moves.
const lyricPath = remoteId =>
  path.posix.join('lyrics', remoteId.slice(-2).toLowerCase(), `${remoteId}.json`);

const serialize = record => JSON.stringify(record, null, 2) + '\n';

const text = value => typeof value === 'string' && /\S/.test(value);
// A title or name readers can see: at least one letter or digit. Format
// characters (zero-width space, ZWNJ and ZWJ, bidi controls, BOM, soft
// hyphen) may be in it, since Urdu uses ZWNJ, but don't count.
const visible = value => typeof value === 'string' && /[\p{L}\p{N}]/u.test(value);
// Titles, Poets and Personalities are one line: the index lists them one
// per line, and the sync's commit message names each change by title.
const oneLine = value => !/[\n\r]/.test(value);

// What is wrong with a lyric record, or null. The v1 rules the phone and the
// website read by, with the Owner's own Category and Personality names
// allowed: a built-in Personality must still fit every Category.
function recordProblem(record, now = new Date()) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return 'not a JSON object';
  const unknown = Object.keys(record).find(key => !FIELDS.includes(key));
  if (unknown) return `unknown field: ${unknown}`;
  for (const key of ['remoteId', 'title', 'body']) {
    if (!text(record[key])) return `${key} is required and must be non-blank`;
  }
  if (!/^[A-Za-z0-9_-]+$/.test(record.remoteId)) return 'remoteId may hold only letters, digits, _ and -';
  // A lyric without Styling leaves it out; readers refuse an empty one.
  if ('styling' in record && !(Array.isArray(record.styling) && record.styling.length &&
    record.styling.every(op => op !== null && typeof op === 'object' && 'insert' in op))) {
    return 'styling must be a non-empty array of objects, each with insert';
  }
  if (!['Roman Urdu', 'Urdu'].includes(record.language)) return 'language must be Roman Urdu or Urdu';
  if (!visible(record.title)) return 'title must have a letter or digit';
  if (!oneLine(record.title)) return 'title must be one line';

  const { categories, anjumans } = record;
  if (!Array.isArray(categories) || !categories.length || !categories.every(text)) {
    return 'categories must be a non-empty array of names';
  }
  if (new Set(categories).size !== categories.length) return 'categories must be unique';
  const badName = categories.find(category => !NAME.test(category));
  if (badName !== undefined) return `not a category name: ${JSON.stringify(badName)}`;
  if (!Array.isArray(anjumans) || !anjumans.every(visible) || new Set(anjumans).size !== anjumans.length) {
    return 'anjumans must be an array of unique names, each with a letter or digit';
  }
  if (anjumans.length && !categories.includes('Nohay')) {
    return 'a lyric in an Anjuman must include the Nohay category';
  }

  if ('subcategory' in record) {
    const personality = record.subcategory;
    if (!visible(personality) || personality === 'General') {
      return 'subcategory must be absent or a name with a letter or digit, other than General';
    }
    if (!oneLine(personality)) return 'subcategory must be one line';
    const lists = subjectsByCategory();
    if ([...lists.values()].some(list => list.includes(personality))) {
      const unfit = categories.find(category => !lists.get(category)?.includes(personality));
      if (unfit) return `${personality} is not a Personality for ${unfit}`;
    }
  }
  const year = now.getFullYear();
  if ('group' in record && !(Number.isInteger(record.group) && record.group >= 1900 && record.group <= year)) {
    return `group must be a release year from 1900 to ${year}`;
  }
  if ('author' in record && !visible(record.author)) return 'author must be absent or have a letter or digit';
  if ('author' in record && !oneLine(record.author)) return 'author must be one line';
  if (typeof record.verified !== 'boolean') return 'verified must be true or false';
  return null;
}

// Every file under lyrics/ as { file, record }; record is undefined when the
// file isn't JSON.
function lyricFiles(dir = root) {
  const files = [];
  const walk = folder => {
    for (const entry of fs.readdirSync(path.join(dir, folder), { withFileTypes: true })) {
      const file = path.posix.join(folder, entry.name);
      if (entry.isDirectory()) walk(file);
      else files.push(file);
    }
  };
  if (fs.existsSync(path.join(dir, 'lyrics'))) walk('lyrics');
  return files.map(file => {
    let record;
    try {
      record = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    } catch {
      // Reported by problems().
    }
    return { file, record };
  });
}

// Every problem with the lyric files, as "file: problem".
function problems(dir = root, now = new Date()) {
  const found = [];
  for (const { file, record } of lyricFiles(dir)) {
    const problem = record === undefined ? 'not valid JSON' : recordProblem(record, now);
    if (problem) found.push(`${file}: ${problem}`);
    else if (file !== lyricPath(record.remoteId)) found.push(`${file}: belongs at ${lyricPath(record.remoteId)}`);
  }
  return found;
}

// The Catalog as a map of remoteId to record. Assumes valid files.
const readCatalog = (dir = root) =>
  new Map(lyricFiles(dir).map(({ record }) => [record.remoteId, record]));

function writeLyric(record, dir = root) {
  const file = path.join(dir, lyricPath(record.remoteId));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, serialize(record));
}

function deleteLyric(remoteId, dir = root) {
  const file = path.join(dir, lyricPath(remoteId));
  fs.rmSync(file, { force: true });
  const folder = path.dirname(file);
  if (fs.existsSync(folder) && !fs.readdirSync(folder).length) fs.rmdirSync(folder);
}

const git = (args, dir = root, options = {}) =>
  execFileSync('git', args, { cwd: dir, encoding: 'utf8', maxBuffer: 1 << 28, ...options }).trim();

// The git tree of lyrics/ as the working tree has it now. Stages lyrics/.
function catalogTree(dir = root) {
  if (!lyricFiles(dir).length) {
    git(['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', 'lyrics'], dir);
    return EMPTY_TREE;
  }
  git(['add', '-A', '--', 'lyrics'], dir);
  return git(['write-tree', '--prefix=lyrics/'], dir);
}

// lyrics/ at a commit, as a tree; the empty tree when it has none.
function treeAt(rev, dir = root) {
  try {
    return git(['rev-parse', '--verify', '--quiet', `${rev}:lyrics`], dir);
  } catch {
    return EMPTY_TREE;
  }
}

// How lyrics/ changed between two trees: the remoteIds added, changed and
// removed, in path order.
function changesBetween(from, to, dir = root) {
  const changes = { added: [], changed: [], removed: [] };
  const out = git(['diff-tree', '-r', '--no-renames', '--name-status', from, to], dir);
  for (const line of out.split('\n').filter(Boolean)) {
    const [status, file] = line.split('\t');
    const remoteId = path.posix.basename(file, '.json');
    (status === 'A' ? changes.added : status === 'D' ? changes.removed : changes.changed).push(remoteId);
  }
  return changes;
}

// A lyric's record in a lyrics/ tree.
const recordIn = (tree, remoteId, dir = root) =>
  JSON.parse(git(['show', `${tree}:${path.posix.relative('lyrics', lyricPath(remoteId))}`], dir));

// Lyrics' records in a lyrics/ tree, by remoteId, read in one go.
function recordsIn(tree, remoteIds, dir = root) {
  const input = remoteIds.map(id => `${tree}:${path.posix.relative('lyrics', lyricPath(id))}\n`).join('');
  const out = execFileSync('git', ['cat-file', '--batch'], { cwd: dir, input, maxBuffer: 1 << 28 });
  const records = new Map();
  let at = 0;
  // Each answer is "<object> blob <size>\n<content>\n".
  for (const remoteId of remoteIds) {
    const header = out.indexOf(10, at);
    const size = Number(out.toString('utf8', at, header).split(' ')[2]);
    records.set(remoteId, JSON.parse(out.toString('utf8', header + 1, header + 1 + size)));
    at = header + 1 + size + 1;
  }
  return records;
}

// The commits on HEAD's first-parent line (main: merged pull requests and
// sync commits) after the newest whose lyrics/ is `tree`, oldest first, each
// with its lyrics/ tree. Empty when no commit there has `tree`.
function commitsSince(tree, dir = root) {
  const commits = git(['rev-list', '--first-parent', 'HEAD'], dir).split('\n');
  const trees = git(['cat-file', '--batch-check=%(objectname)'], dir,
    { input: commits.map(commit => `${commit}:lyrics\n`).join('') }).split('\n');
  const end = trees.indexOf(tree);
  return end < 0 ? [] : commits.slice(0, end).map((commit, i) => ({ commit, tree: trees[i] })).reverse();
}

// A merge commit message with this line on its own publishes nothing: the
// sync moves the manifest's catalogTree past the commit without an update file,
// so its lyric files are the Catalog from then on, and the next Base Catalog
// carries them to phones.
const BASE_ONLY = /^Catalog-Publish: base-only\s*$/m;

// The commits on HEAD's first-parent line whose message has the BASE_ONLY line.
function baseOnlyCommits(dir = root) {
  const log = git(['log', '--first-parent', '--grep=Catalog-Publish: base-only', '--format=%H%x1f%B%x1e', 'HEAD'], dir);
  return new Set(log.split('\x1e')
    .map(entry => entry.trim().split('\x1f'))
    .filter(([, body]) => BASE_ONLY.test(body ?? ''))
    .map(([commit]) => commit));
}

// What breaks the update limits: each of `files` ([update file name, its
// bytes as published]) and the number of updates `manifest` lists. Returns
// { problems, warnings }.
function updateProblems(manifest, files) {
  const problems = [];
  for (const [name, bytes] of files) {
    if (OVER_LIMIT.has(path.basename(name, '.json'))) continue;
    let update;
    try {
      update = JSON.parse(String(bytes));
    } catch {
      problems.push(`${name}: not valid JSON`);
      continue;
    }
    const entries = (update.items?.length ?? 0) + (update.removed?.length ?? 0);
    if (entries > UPDATE_ENTRIES) problems.push(`${name}: ${entries} entries, over ${UPDATE_ENTRIES}`);
    const size = Buffer.byteLength(bytes);
    if (size > UPDATE_BYTES) problems.push(`${name}: ${size} bytes, over ${UPDATE_BYTES}`);
  }
  const listed = manifest.updates?.length ?? 0;
  const warnings = [];
  if (listed > MANIFEST_UPDATES) {
    problems.push(`manifest.json: ${listed} updates listed, over ${MANIFEST_UPDATES}. The Owner removes old ` +
      'entries in a reviewed pull request (README, Publishing).');
  } else if (listed >= MANIFEST_WARN) {
    warnings.push(`manifest.json: ${listed} updates listed; over ${MANIFEST_UPDATES} the sync stops. ` +
      'Remove old entries soon (README, Publishing).');
  }
  return { problems, warnings };
}

// When a lyric's file first came into the Catalog, in ms (the commit time),
// or null if it never had one.
function firstAdded(remoteId, dir = root) {
  const added = git(['log', '--format=%ct', '--diff-filter=A', '--', lyricPath(remoteId)], dir);
  return added ? Number(added.split('\n').at(-1)) * 1000 : null;
}

// A deleted lyric's last version from git history, or null if it never had a file.
function lastVersion(remoteId, dir = root) {
  const file = lyricPath(remoteId);
  const commit = git(['log', '-1', '--format=%H', '--diff-filter=D', '--', file], dir);
  return commit ? JSON.parse(git(['show', `${commit}^:${file}`], dir)) : null;
}

// Markdown-safe on one line of the index.
const escapeMarkdown = value => value.replace(/[\n\r]+/g, ' ').replace(/([\\`*_[\]<>])/g, '\\$1');

// index/<Category>.md for every Category in use: titles grouped by
// Personality, each linking to its file. Built-in Personalities come in
// taxonomy order, then the others by name, then lyrics without one.
function writeIndex(records, dir = root) {
  const indexDir = path.join(dir, 'index');
  fs.rmSync(indexDir, { recursive: true, force: true });
  fs.mkdirSync(indexDir);
  const byCategory = new Map();
  for (const record of records) {
    for (const category of record.categories) {
      byCategory.set(category, [...(byCategory.get(category) ?? []), record]);
    }
  }
  const byTitle = (a, b) => a.title.localeCompare(b.title) || a.remoteId.localeCompare(b.remoteId);
  for (const [category, lyrics] of [...byCategory].sort(([a], [b]) => a.localeCompare(b))) {
    const builtIn = subjectsByCategory().get(category) ?? [];
    const groups = new Map();
    for (const record of lyrics) {
      const key = record.subcategory ?? null;
      groups.set(key, [...(groups.get(key) ?? []), record]);
    }
    const order = name => name === null ? [2, ''] :
      builtIn.includes(name) ? [0, String(builtIn.indexOf(name)).padStart(4, '0')] : [1, name];
    const names = [...groups.keys()].sort((a, b) => {
      const [x, y] = [order(a), order(b)];
      return x[0] - y[0] || x[1].localeCompare(y[1]);
    });
    const lines = [`# ${category}`, '', `${lyrics.length} lyrics.`];
    for (const name of names) {
      lines.push('', `## ${name === null ? 'Without a Personality' : escapeMarkdown(name)}`, '');
      for (const record of groups.get(name).sort(byTitle)) {
        lines.push(`- [${escapeMarkdown(record.title)}](../${lyricPath(record.remoteId)})`);
      }
    }
    const file = `${category.replace(/[\\/:*?"<>|]/g, '-')}.md`;
    fs.writeFileSync(path.join(indexDir, file), lines.join('\n') + '\n');
  }
}

if (require.main === module) {
  const [command, arg] = process.argv.slice(2);
  const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
  // The update limits on `manifest` and the listed updates in `folder`.
  const checkUpdates = (manifest, updates, folder) => {
    const files = updates.map(({ assetName }) => [assetName, fs.readFileSync(path.join(folder, assetName))]);
    const { problems: found, warnings } = updateProblems(manifest, files);
    for (const warning of warnings) console.log(`::warning::${warning}`);
    return found;
  };
  let found;
  if (command === 'check') {
    const base = arg;
    found = problems();
    // A pull request's own updates; without a base, every listed one.
    const manifest = readJson(path.join(root, 'manifest.json'));
    const known = new Set(base ? JSON.parse(git(['show', `${base}:manifest.json`])).updates.map(({ id }) => id) : []);
    found.push(...checkUpdates(manifest, manifest.updates.filter(({ id }) => !known.has(id)), path.join(root, 'updates')));
    if (base) {
      const { added, changed, removed } = changesBetween(treeAt(base), treeAt('HEAD'));
      for (const remoteId of removed) {
        found.push(`${lyricPath(remoteId)}: deleted. Withdraw a lyric from the website's Owner panel instead.`);
      }
      const count = added.length + changed.length + removed.length;
      // The pull request's description says the merge will be base-only.
      if (count > RUN_LYRICS && !BASE_ONLY.test(process.env.PR_BODY ?? '')) {
        found.push(`Warning: lyrics/: ${count} lyrics changed, over the ${RUN_LYRICS} one sync run publishes. Merged, ` +
          'it goes out in one run of its own, and phones on 1.1.2 and 1.1.3 apply it all at once. ' +
          `Split it into pull requests of at most ${RUN_LYRICS}.`);
      }
    }
  } else if (command === 'updates' && arg) {
    const manifest = readJson(path.join(arg, 'manifest.json'));
    found = checkUpdates(manifest, manifest.updates.filter(({ assetName }) => fs.existsSync(path.join(arg, assetName))), arg);
  } else {
    console.error('Usage: node scripts/catalog.js check [<base commit>] | updates <dir>');
    process.exit(2);
  }
  if (found.length) {
    console.error(found.join('\n'));
    process.exit(1);
  }
  console.log(command === 'check' ? `${lyricFiles().length} lyric files are valid.` : 'The updates are within the limits.');
}

module.exports = {
  BASE_ONLY,
  CANONICAL_CATEGORIES,
  MANIFEST_UPDATES,
  MANIFEST_WARN,
  RUN_LYRICS,
  UPDATE_BYTES,
  UPDATE_ENTRIES,
  baseOnlyCommits,
  catalogTree,
  changesBetween,
  commitsSince,
  deleteLyric,
  firstAdded,
  lastVersion,
  lyricFiles,
  lyricPath,
  problems,
  readCatalog,
  recordIn,
  recordProblem,
  recordsIn,
  serialize,
  subjectsByCategory,
  treeAt,
  updateProblems,
  writeIndex,
  writeLyric
};
