const test = require('node:test');
const assert = require('node:assert/strict');

const { planUpdate, toRecord, toUpdateItem } = require('../scripts/sync_firestore_to_github');

// A submission as the app writes it (contract v1), plus workflow fields.
const submission = {
  remoteId: 'doc1',
  title: 'Ya Ali',
  body: 'Line one',
  language: 'Roman Urdu',
  categories: ['Manqabat', 'Qasida'],
  subcategory: 'Imam Ali (a.s)',
  group: 2024,
  author: 'Mir Anees',
  anjumans: [],
  status: 'approved',
  published: false,
  isVerified: true,
  ownerUid: 'user-123',
  termsVersion: '1.0',
  contentDelta: '[]',
  reviewedBy: 'admin-1'
};

test('an approved submission becomes a Catalog record without contributor fields', () => {
  assert.deepEqual(toRecord('doc1', submission), {
    remoteId: 'doc1',
    title: 'Ya Ali',
    body: 'Line one',
    language: 'Roman Urdu',
    categories: ['Manqabat', 'Qasida'],
    subcategory: 'Imam Ali (a.s)',
    group: 2024,
    author: 'Mir Anees',
    anjumans: [],
    verified: true
  });
});

test('a published item keeps the poet, language and every category', () => {
  assert.deepEqual(toUpdateItem(toRecord('doc1', submission)), {
    remoteId: 'doc1',
    title: 'Ya Ali',
    body: 'Line one',
    category: 'Manqabat',
    categories: ['Manqabat', 'Qasida'],
    subcategory: 'Imam Ali (a.s)',
    group: 2024,
    isVerified: true,
    source: 'firestore',
    author: 'Mir Anees',
    language: 'Roman Urdu'
  });
});

test('anjumans reach the app through categoryMappings', () => {
  const item = toUpdateItem(toRecord('doc2', {
    ...submission,
    categories: ['Nohay'],
    anjumans: ['Anjuman-e-Abbasia']
  }));
  assert.deepEqual(item.anjumans, ['Anjuman-e-Abbasia']);
  assert.deepEqual(item.categoryMappings, [
    'Nohay',
    { category: 'Anjuman', subcategory: 'Anjuman-e-Abbasia' }
  ]);
});

test('legacy documents still publish, without contributor fields', () => {
  const record = toRecord('doc3', {
    title: 'Old',
    body: 'Body',
    category: 'oldnouhay',
    subcategory: 'General',
    group: 'General',
    createdBy: 'device-uuid',
    deviceUserUuid: 'device-uuid'
  });
  assert.deepEqual(record, {
    remoteId: 'doc3',
    title: 'Old',
    body: 'Body',
    language: 'Roman Urdu',
    categories: ['Nohay'],
    anjumans: [],
    verified: false
  });
  // Readers before contract v1 still get the placeholders they expect.
  const item = toUpdateItem(record);
  assert.equal(item.subcategory, 'General');
  assert.equal(item.group, 'General');
  assert.ok(!('author' in item));
});

test('a legacy document\'s language comes from its title, and a year written as text is kept', () => {
  const record = toRecord('doc4', { title: 'یا علی', body: 'Body', category: 'Nohay', group: '2019' });
  assert.equal(record.language, 'Urdu');
  assert.equal(record.group, 2019);
});

// What the sync makes of a Writer's contentDelta. The phone and the website
// fall back to the plain body when Styling and body disagree, so these cases
// live here only, not in a fixture shared with the app.
const styled = (body, delta, language = 'Roman Urdu') => {
  let dropped = 0;
  const contentDelta = typeof delta === 'string' ? delta : JSON.stringify(delta);
  const record = toRecord('doc5', { ...submission, body, language, contentDelta }, () => dropped++);
  return { record, styling: record.styling, dropped };
};

test('contentDelta becomes styling, right after the body', () => {
  const delta = [
    { insert: 'Pehli ', attributes: { bold: true } },
    { insert: 'line', attributes: { italic: true, underline: true, size: 'large' } },
    { insert: '\n', attributes: { align: 'right' } },
    { insert: 'Doosri line' },
    { insert: '\n', attributes: { list: 'bullet', align: 'justify' } },
    { insert: 'Teesri line', attributes: { size: 'small' } },
    { insert: '\n', attributes: { list: 'ordered', direction: 'rtl', align: 'center' } },
    { insert: 'Aakhri line', attributes: { size: 'huge' } },
    { insert: '\n', attributes: { align: 'left' } }
  ];
  const { record, dropped } = styled('Pehli line\nDoosri line\nTeesri line\nAakhri line', delta);
  assert.deepEqual(record.styling, delta);
  assert.deepEqual(Object.keys(record), [
    'remoteId', 'title', 'body', 'styling', 'language', 'categories', 'subcategory', 'group',
    'author', 'anjumans', 'verified'
  ]);
  assert.equal(dropped, 0);
});

test('styling keeps only text and divider inserts, with the formats readers show', () => {
  const { styling } = styled('Pehli line\n<<DIVIDER>>\nDoosri line\n<<MINI>>', [
    { insert: 'Pehli line', attributes: { bold: true, link: 'mailto:poet@example.com', color: '#ff0000', background: '#000' } },
    { insert: { image: 'https://example.com/a.png' } },
    { insert: '\n', attributes: { align: 'center', header: 1 } },
    { insert: { divider: { anything: 'else' } }, attributes: { color: 'red' } },
    { insert: '\n' },
    { insert: 'Doosri line', attributes: { bold: 'yes', size: '14', script: 'super', strike: true } },
    { insert: '\n', attributes: { align: 'start', list: 'checked', direction: 'ltr', indent: 1 } },
    { insert: { 'mini-divider': null } },
    { insert: { video: 'x' } },
    { insert: '\n', attributes: { constructor: 'x', toString: true } },
    { retain: 3, attributes: { bold: true } },
    { delete: 1 },
    'Doosri line',
    null
  ]);
  assert.deepEqual(styling, [
    { insert: 'Pehli line', attributes: { bold: true } },
    { insert: '\n', attributes: { align: 'center' } },
    { insert: { divider: '' } },
    { insert: '\n' },
    { insert: 'Doosri line' },
    { insert: '\n' },
    { insert: { 'mini-divider': '' } },
    { insert: '\n' }
  ]);
});

test('Urdu styling loses direction and keeps every alignment, left and right too', () => {
  const urdu = (left, right) => styled('پہلی لائن\nدوسری لائن', [
    { insert: 'پہلی لائن' }, { insert: '\n', attributes: left },
    { insert: 'دوسری لائن' }, { insert: '\n', attributes: right }
  ], 'Urdu').styling;
  assert.deepEqual(urdu({ align: 'left', direction: 'rtl' }, { align: 'right', direction: 'rtl' }), [
    { insert: 'پہلی لائن' }, { insert: '\n', attributes: { align: 'left' } },
    { insert: 'دوسری لائن' }, { insert: '\n', attributes: { align: 'right' } }
  ]);
  // Direction was all it had.
  assert.equal(urdu({ direction: 'rtl' }, {}), undefined);
});

test('a divider inside a line counts as a line of its own, as in the Writer', () => {
  const delta = [
    { insert: 'Pehli line' },
    { insert: { 'mini-divider': '' } },
    { insert: 'Doosri line', attributes: { bold: true } },
    { insert: '\n' }
  ];
  assert.deepEqual(styled('Pehli line\n<<MINI>>\nDoosri line', delta).styling, delta);
});

test('styling whose lines aren\'t the body\'s is left out and counted; trailing empty lines don\'t count', () => {
  const aligned = text => [{ insert: text }, { insert: '\n', attributes: { align: 'right' } }];
  assert.ok(styled('Pehli line', [...aligned('Pehli line'), { insert: '\n\n' }]).styling);
  assert.ok(styled('Pehli line\n\n', aligned('Pehli line')).styling);
  for (const [body, delta] of [
    ['Pehli line\nDoosri line', aligned('Pehli line\nTeesri line')],
    // A body trimmed of a leading blank line would style every line one off.
    ['Pehli line', aligned('\nPehli line')],
    ['Pehli line\n<<DIVIDER>>', aligned('Pehli line\n<<MINI>>')],
    ['Pehli line', aligned('Pehli line ')]
  ]) {
    const { record, dropped } = styled(body, delta);
    assert.ok(!('styling' in record), JSON.stringify(delta));
    assert.equal(dropped, 1);
  }
});

test('a delta that is missing, unreadable, empty or without a format adds no styling', () => {
  const plain = toRecord('doc5', { ...submission, contentDelta: undefined });
  for (const delta of [
    undefined, '', 'not json', '{"ops":[]}', 'null', '[]',
    [{ insert: 'Line one\n' }],
    [{ insert: 'Line one' }, { insert: { divider: '' } }, { insert: '\n' }],
    [{ insert: 'Line one', attributes: { link: 'https://example.com' } }, { insert: '\n' }]
  ]) {
    const { record, dropped } = styled('Line one', delta);
    assert.deepEqual(record, plain, JSON.stringify(delta));
    assert.equal(dropped, 0);
  }
});

const at = ms => ({ toMillis: () => ms });

// The Catalog before the run.
const lyrics = new Map([['lyric-7', toRecord('lyric-7', { ...submission, title: 'Published' })]]);
const approved = (submissions, decisions = []) => planUpdate({ submissions, decisions, lyrics });
const written = ({ writes }) => [...writes].map(([remoteId, { record, kind }]) => [remoteId, record.title, kind]);

test('a revision is written over the lyric it changes', () => {
  const plan = approved([
    { id: 'rev-1', data: { ...submission, title: 'Ya Ali (fixed)', revisionOfRemoteId: 'lyric-7' } }
  ]);
  assert.deepEqual(written(plan), [['lyric-7', 'Ya Ali (fixed)', 'suggested edit']]);
  assert.deepEqual(plan.submissionIds, ['rev-1']);
});

test('the newest approved revision of a lyric wins and every one is marked', () => {
  const plan = approved([
    { id: 'rev-new', data: { ...submission, title: 'Newer', revisionOfRemoteId: 'lyric-7', approvedAt: at(2000) } },
    { id: 'rev-old', data: { ...submission, title: 'Older', revisionOfRemoteId: 'lyric-7', approvedAt: at(1000) } },
    { id: 'doc9', data: { ...submission, title: 'New lyric' } }
  ]);
  assert.deepEqual(written(plan), [['lyric-7', 'Newer', 'suggested edit'], ['doc9', 'New lyric', 'new']]);
  assert.deepEqual(plan.submissionIds, ['rev-new', 'rev-old', 'doc9']);
});

test('an approved revision goes out over an already published version, which stays marked', () => {
  const plan = approved([
    { id: 'lyric-7', data: { ...submission, title: 'Published', published: true, approvedAt: at(1000) } },
    { id: 'rev-1', data: { ...submission, title: 'Revised', revisionOfRemoteId: 'lyric-7', approvedAt: at(2000) } }
  ]);
  assert.deepEqual(written(plan), [['lyric-7', 'Revised', 'suggested edit']]);
  assert.deepEqual(plan.submissionIds, ['rev-1']);
});

test('an Admin\'s own edit is an admin edit; a reader\'s approved suggestion is not', () => {
  const edit = ownerUid => written(approved([{
    id: 'rev-1',
    data: { ...submission, revisionOfRemoteId: 'lyric-7', ownerUid, approvedBy: 'admin-1' }
  }]))[0][2];
  assert.equal(edit('admin-1'), 'admin edit');
  assert.equal(edit('reader-1'), 'suggested edit');
});

test('published submissions alone write nothing', () => {
  assert.equal(approved([
    { id: 'lyric-7', data: { ...submission, title: 'Published', published: true } }
  ]).writes.size, 0);
});

test('an approved document without a published flag is left alone, as before', () => {
  const { published, ...legacy } = submission;
  const plan = approved([{ id: 'legacy-1', data: legacy }]);
  assert.equal(plan.writes.size, 0);
  assert.deepEqual(plan.submissionIds, []);
});

test('submissions for a withdrawn lyric are held, neither written nor marked', () => {
  const plan = approved([
    { id: 'rev-1', data: { ...submission, revisionOfRemoteId: 'lyric-7' } },
    { id: 'lyric-7', data: { ...submission, title: 'The lyric itself' } },
    { id: 'doc9', data: { ...submission, title: 'New lyric' } }
  ], [{ id: 'lyric-7', data: { withdrawn: true, updatedAt: at(500), publishedAt: at(500) } }]);
  assert.deepEqual(written(plan), [['doc9', 'New lyric', 'new']]);
  assert.deepEqual(plan.submissionIds, ['doc9']);
});

test('an approval whose record breaks the Catalog rules is held, neither written nor marked', () => {
  const plan = approved([
    { id: 'rev-1', data: { ...submission, revisionOfRemoteId: 'lyric-7', group: 3000 } }
  ]);
  assert.equal(plan.writes.size, 0);
  assert.deepEqual(plan.submissionIds, []);
  assert.equal(plan.held.length, 1);
  assert.equal(plan.held[0].remoteId, 'lyric-7');
  assert.match(plan.held[0].problem, /^group must be a release year/);
});

test('revision fields stay out of the record', () => {
  const [[, { record }]] = approved([
    { id: 'rev-1', data: { ...submission, revisionOfRemoteId: 'lyric-7' } }
  ]).writes;
  assert.ok(!('revisionOfRemoteId' in record));
});
