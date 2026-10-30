const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const catalog = require('../scripts/catalog');
const { catalogRepo, commit } = require('./catalog_repo');

const lyric = (remoteId, fields = {}) => ({
  remoteId,
  title: `Title of ${remoteId}`,
  body: 'Pehli line\n<<DIVIDER>>\nDoosri line',
  language: 'Roman Urdu',
  categories: ['Nohay'],
  anjumans: [],
  verified: false,
  ...fields
});

const june2026 = new Date('2026-06-01T00:00:00Z');
const problem = (fields, now = june2026) => catalog.recordProblem(lyric('lyric-a1', fields), now);

test('a record with every field the v1 rules allow is valid', () => {
  assert.equal(problem({
    categories: ['Nohay', 'Salaams'],
    subcategory: 'Hazrat Abbas (a.s)',
    group: 2024,
    author: 'Mir Anees',
    verified: true,
    styling: [{ insert: 'Pehli line' }, { insert: '\n', attributes: { align: 'center' } }]
  }), null);
  assert.equal(problem({ anjumans: ['Anjuman-e-Abbasia'] }), null);
});

test('styling is an array of objects, each with insert', () => {
  for (const styling of ['[]', {}, [null], ['Pehli line'], [[]], [{ attributes: { bold: true } }]]) {
    assert.equal(problem({ styling }), 'styling must be an array of objects, each with insert', JSON.stringify(styling));
  }
});

// Readers have every Catalog lyric; whether it is published lives in Firestore.
test('published is not a Catalog field', () => {
  assert.equal(problem({ published: true }), 'unknown field: published');
});

test('the Owner\'s own Category and Personality names are allowed', () => {
  assert.equal(problem({ subcategory: 'الوداع' }), null);
  assert.equal(problem({ categories: ['Rubai'], subcategory: 'Shaheed-e-Salis' }), null);
});

// Format characters alone: zero-width space, ZWNJ and ZWJ, bidi isolates,
// a bidi override, BOM, soft hyphen, and a mix with spaces. The same inputs
// as the visible-text cases of shared/lyric_metadata/v1/fixtures/invalid.json
// in the RomanUrduLyricsApp repository.
const invisible = ['\u200B', '\u200C\u200D', '\u2066\u2069', '\u202E', '\uFEFF', '\u00AD', ' \u200B\u200F '];

test('a title, Poet, Personality and Anjuman need a letter or digit', () => {
  for (const value of invisible) {
    const shown = JSON.stringify(value);
    // A BOM is white space to JavaScript, so it already fails the blank check.
    assert.match(problem({ title: value }), /^title (is required|must have a letter or digit)/, shown);
    assert.equal(problem({ author: value }), 'author must be absent or have a letter or digit', shown);
    assert.equal(problem({ subcategory: value }),
      'subcategory must be absent or a name with a letter or digit, other than General', shown);
    assert.equal(problem({ anjumans: [value] }),
      'anjumans must be an array of unique names, each with a letter or digit', shown);
  }
});

test('format characters inside visible text are allowed', () => {
  // Urdu joins with ZWNJ.
  assert.equal(problem({
    title: 'ہم\u200Cسفر',
    author: 'Mir\u00ADAnees',
    subcategory: '\u2066Alam\u2069',
    anjumans: ['Anjuman\u200B A']
  }), null);
  assert.equal(problem({ title: '1857' }), null);
});

test('a built-in Personality must fit every Category of the lyric', () => {
  // Ibteda-e-Aza is a Nohay Personality only.
  assert.equal(problem({ subcategory: 'Ibteda-e-Aza' }), null);
  assert.equal(
    problem({ categories: ['Nohay', 'Manqabat'], subcategory: 'Ibteda-e-Aza' }),
    'Ibteda-e-Aza is not a Personality for Manqabat'
  );
});

test('a lyric in an Anjuman includes the Nohay category', () => {
  assert.equal(problem({ categories: ['Nohay', 'Manqabat'], anjumans: ['Anjuman-e-Abbasia'] }), null);
  for (const categories of [['Manqabat'], ['Salaams', 'Manqabat']]) {
    assert.equal(
      problem({ categories, anjumans: ['Anjuman-e-Abbasia'] }),
      'a lyric in an Anjuman must include the Nohay category'
    );
  }
});

test('group is a release year from 1900 to this year', () => {
  assert.equal(problem({ group: 2026 }), null);
  for (const group of [2027, 1899, '2024', 2024.5]) {
    assert.equal(problem({ group }), 'group must be a release year from 1900 to 2026', String(group));
  }
});

test('a file is a problem when it isn\'t JSON or sits at the wrong path', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kanz-lyrics-'));
  catalog.writeLyric(lyric('lyric-a1'), dir);
  fs.mkdirSync(path.join(dir, 'lyrics', 'zz'));
  fs.writeFileSync(path.join(dir, 'lyrics', 'zz', 'lyric-b2.json'), catalog.serialize(lyric('lyric-b2')));
  fs.writeFileSync(path.join(dir, 'lyrics', 'zz', 'notes.json'), '{ not json');
  assert.deepEqual(catalog.problems(dir).sort(), [
    'lyrics/zz/lyric-b2.json: belongs at lyrics/b2/lyric-b2.json',
    'lyrics/zz/notes.json: not valid JSON'
  ]);
});

test('a lyric\'s folder is the last two characters of its id, lowercase', () => {
  assert.equal(catalog.lyricPath('d3qvT9xQ'), 'lyrics/xq/d3qvT9xQ.json');
});

test('the index lists each Category\'s titles by Personality, linking to each file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kanz-index-'));
  fs.mkdirSync(path.join(dir, 'index'));
  fs.writeFileSync(path.join(dir, 'index', 'Retired.md'), '# Retired\n');
  catalog.writeIndex([
    lyric('no-personality', { title: 'Without one' }),
    lyric('owner-z', { title: 'Zuljanah aya', subcategory: 'Zuljanah' }),
    lyric('owner-a', { title: 'Alam utha', subcategory: 'Alam' }),
    lyric('akbar-1', { title: 'Akbar', subcategory: 'Ali Akbar (a.s)' }),
    lyric('abbas-2', { title: 'Saqi-e-Sakina', subcategory: 'Hazrat Abbas (a.s)', categories: ['Nohay', 'Salaams'] }),
    lyric('abbas-1', { title: 'Ghazi *Abbas*', subcategory: 'Hazrat Abbas (a.s)' })
  ], dir);

  assert.deepEqual(fs.readdirSync(path.join(dir, 'index')).sort(), ['Nohay.md', 'Salaams.md']);
  // Built-in Personalities in taxonomy order (Abbas before Akbar), then the
  // Owner's by name, then lyrics without one; titles by name in each.
  assert.equal(fs.readFileSync(path.join(dir, 'index', 'Nohay.md'), 'utf8'), [
    '# Nohay',
    '',
    '6 lyrics.',
    '',
    '## Hazrat Abbas (a.s)',
    '',
    '- [Ghazi \\*Abbas\\*](../lyrics/-1/abbas-1.json)',
    '- [Saqi-e-Sakina](../lyrics/-2/abbas-2.json)',
    '',
    '## Ali Akbar (a.s)',
    '',
    '- [Akbar](../lyrics/-1/akbar-1.json)',
    '',
    '## Alam',
    '',
    '- [Alam utha](../lyrics/-a/owner-a.json)',
    '',
    '## Zuljanah',
    '',
    '- [Zuljanah aya](../lyrics/-z/owner-z.json)',
    '',
    '## Without a Personality',
    '',
    '- [Without one](../lyrics/ty/no-personality.json)',
    ''
  ].join('\n'));
});

test('changes between two trees of lyrics/ are the ids added, changed and removed', () => {
  const dir = catalogRepo([lyric('lyric-a1'), lyric('lyric-b2'), lyric('lyric-c3')]);
  const before = catalog.treeAt('HEAD', dir);
  catalog.writeLyric(lyric('lyric-a1', { verified: true }), dir);
  catalog.deleteLyric('lyric-b2', dir);
  catalog.writeLyric(lyric('lyric-d4'), dir);
  const after = catalog.catalogTree(dir);

  assert.deepEqual(catalog.changesBetween(before, after, dir), {
    added: ['lyric-d4'],
    changed: ['lyric-a1'],
    removed: ['lyric-b2']
  });
  assert.equal(catalog.recordIn(before, 'lyric-b2', dir).title, 'Title of lyric-b2');
});

// The Catalog with every lyric withdrawn.
test('a Catalog with no lyric file has the empty tree', () => {
  const dir = catalogRepo([lyric('lyric-a1')]);
  catalog.deleteLyric('lyric-a1', dir);
  assert.equal(catalog.catalogTree(dir), '4b825dc642cb6eb9a060e54bf8d69288fbee4904');
});

test('a deleted lyric\'s last version is the one before the commit that deleted it', () => {
  const dir = catalogRepo([lyric('lyric-a1')]);
  catalog.writeLyric(lyric('lyric-a1', { title: 'Corrected' }), dir);
  commit(dir, 'Correct lyric-a1');
  catalog.deleteLyric('lyric-a1', dir);
  commit(dir, 'Withdraw lyric-a1');

  assert.deepEqual(catalog.lastVersion('lyric-a1', dir), lyric('lyric-a1', { title: 'Corrected' }));
  assert.equal(catalog.lastVersion('never-had-a-file', dir), null);
});

// The pull request check, run as check_catalog.yml runs it.
const check = (dir, ...args) => spawnSync(
  process.execPath, [path.join('scripts', 'catalog.js'), 'check', ...args],
  { cwd: dir, encoding: 'utf8' }
);

test('the check passes valid lyric files, edited or added since the base', () => {
  const dir = catalogRepo([lyric('lyric-a1'), lyric('lyric-b2')]);
  catalog.writeLyric(lyric('lyric-a1', { author: 'Mir Anees' }), dir);
  catalog.writeLyric(lyric('lyric-c3'), dir);
  commit(dir, 'Owner edits');

  const result = check(dir, 'main~1');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /3 lyric files are valid/);
});

test('the check refuses a lyric file deleted since the base', () => {
  const dir = catalogRepo([lyric('lyric-a1'), lyric('lyric-b2')]);
  catalog.deleteLyric('lyric-b2', dir);
  commit(dir, 'Delete lyric-b2');

  const result = check(dir, 'main~1');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /lyrics\/b2\/lyric-b2\.json: deleted/);
  // Without a base only the files are checked.
  assert.equal(check(dir).status, 0);
});

test('the check refuses an invalid lyric file', () => {
  const dir = catalogRepo([lyric('lyric-a1')]);
  catalog.writeLyric(lyric('lyric-b2', { published: true }), dir);
  catalog.writeLyric(lyric('lyric-c3', { styling: '[{"insert":"Pehli line\\n"}]' }), dir);

  const result = check(dir);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /lyrics\/b2\/lyric-b2\.json: unknown field: published/);
  assert.match(result.stderr, /lyrics\/c3\/lyric-c3\.json: styling must be an array of objects, each with insert/);
});
