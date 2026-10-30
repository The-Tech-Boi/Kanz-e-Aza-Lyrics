// The Catalog: the current version of every Published Lyric, one file each
// under lyrics/, in the v1 canonical record shape of the RomanUrduLyricsApp
// repository (shared/lyric_metadata/v1/lyric.schema.json) without
// `published`. The sync and the pull request check both read it here.
//
//   node scripts/catalog.js check [<base>]
// checks every lyric file and, given a base commit, refuses deleted ones.
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
  if ('styling' in record && !(Array.isArray(record.styling) &&
    record.styling.every(op => op !== null && typeof op === 'object' && 'insert' in op))) {
    return 'styling must be an array of objects, each with insert';
  }
  if (!['Roman Urdu', 'Urdu'].includes(record.language)) return 'language must be Roman Urdu or Urdu';

  const { categories, anjumans } = record;
  if (!Array.isArray(categories) || !categories.length || !categories.every(text)) {
    return 'categories must be a non-empty array of names';
  }
  if (new Set(categories).size !== categories.length) return 'categories must be unique';
  const badName = categories.find(category => !NAME.test(category));
  if (badName !== undefined) return `not a category name: ${JSON.stringify(badName)}`;
  if (!Array.isArray(anjumans) || !anjumans.every(text) || new Set(anjumans).size !== anjumans.length) {
    return 'anjumans must be an array of unique non-blank names';
  }
  if (anjumans.length && !categories.includes('Nohay')) {
    return 'a lyric in an Anjuman must include the Nohay category';
  }

  if ('subcategory' in record) {
    const personality = record.subcategory;
    if (!text(personality) || personality === 'General') {
      return 'subcategory must be absent or a non-blank name other than General';
    }
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
  if ('author' in record && !text(record.author)) return 'author must be absent or non-blank';
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

const git = (args, dir = root) =>
  execFileSync('git', args, { cwd: dir, encoding: 'utf8', maxBuffer: 1 << 28 }).trim();

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

const escapeMarkdown = value => value.replace(/([\\`*_[\]<>])/g, '\\$1');

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
  const [command, base] = process.argv.slice(2);
  if (command !== 'check') {
    console.error('Usage: node scripts/catalog.js check [<base commit>]');
    process.exit(2);
  }
  const found = problems();
  if (base) {
    for (const remoteId of changesBetween(treeAt(base), treeAt('HEAD')).removed) {
      found.push(`${lyricPath(remoteId)}: deleted. Withdraw a lyric from the website's Owner panel instead.`);
    }
  }
  if (found.length) {
    console.error(found.join('\n'));
    process.exit(1);
  }
  console.log(`${lyricFiles().length} lyric files are valid.`);
}

module.exports = {
  CANONICAL_CATEGORIES,
  catalogTree,
  changesBetween,
  deleteLyric,
  firstAdded,
  lastVersion,
  lyricFiles,
  lyricPath,
  problems,
  readCatalog,
  recordIn,
  recordProblem,
  serialize,
  subjectsByCategory,
  treeAt,
  writeIndex,
  writeLyric
};
