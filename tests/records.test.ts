import assert from 'node:assert/strict';
import test from 'node:test';
import { BASE_CONTENT, markdownEmbed, normalizeDescription, parseRecord, parseRecordSnapshot, serializeRecord, serializeSidecar } from '../src/records';
import type { ImageRecord } from '../src/types';

const id = '91d1699d-f733-45a9-905c-f630cc2e5426';
function fixture(overrides: Partial<ImageRecord> = {}): ImageRecord {
  return {
    schemaVersion: 2,
    id,
    description: 'Canoe beside the dock at sunset.',
    captionStatus: 'confirmed',
    imagePath: `2026/images/${id}.jpg`,
    recordPath: `2026/image-records/${id}.md`,
    sidecarPath: `2026/images/${id}.xmp`,
    sourceName: 'IMG_0042.jpg',
    sourceLastModified: 1792254442000,
    ingestMethod: 'clipboard',
    importedAt: '2026-10-17T14:00:00.000Z',
    sourceNotes: ['2026/October/17.md'],
    sha256: 'a'.repeat(64),
    bytes: 1024,
    format: 'jpg',
    metadata: {
      capturedAt: '2026-10-16T19:07:22-04:00',
      captureTimeRaw: '2026:10:16 19:07:22',
      captureTimeOffset: '-04:00',
      captureTimeStatus: 'source_offset',
      width: 4032,
      height: 3024,
      orientation: 1,
      cameraMake: 'Apple',
      cameraModel: 'iPhone',
      raw: { DateTimeOriginal: '2026-10-16T23:07:22.000Z', GPSLatitude: 43.6, unusual: 'Quote " and ]\nline', array: [1, 2, 3] },
    },
    ...overrides,
  };
}

test('portable record round trips every field, preserving raw metadata', () => {
  const record = fixture();
  assert.deepEqual(parseRecord(serializeRecord(record)), record);
  assert.match(serializeRecord(record), /local_file: "\[\[2026\/images\//);
  assert.match(serializeRecord(record), /source_notes:\n  - "\[\[2026\/October\/17\]\]"/);
  assert.match(serializeRecord(record), /capture_time_status: "source_offset"/);
});

test('snapshot parser accepts only current records and matching markers', () => {
  const note = serializeRecord(fixture());
  assert.equal(parseRecordSnapshot(note.replace('"schemaVersion": 2', '"schemaVersion": 99')), null);
  assert.equal(parseRecordSnapshot(note.replace('"schemaVersion": 2,', '"schemaVersion": 2, "unknownField": true,')), null);
  assert.equal(parseRecordSnapshot(note.replace('<!-- image-ledger:record -->', '<!-- other:record -->')), null);
  assert.equal(parseRecordSnapshot(note.replace('<!-- /image-ledger:record -->', '<!-- /other:record -->')), null);
  assert.equal(parseRecordSnapshot(note.replace('"sourceNotes": [', '"unknownNotes": [')), null);
});

test('captions normalize whitespace and reject empty values', () => {
  assert.equal(normalizeDescription('  The\t red\n canoe\r\n at sunset  '), 'The red canoe at sunset');
  assert.throws(() => normalizeDescription(' \n\t '), /description is required/);
});

test('YAML quoting protects captions and filenames containing punctuation', () => {
  const record = fixture({ description: 'A "quoted": canoe #1 [dock] \\ coast', sourceName: 'a: "b"\nc.jpg' });
  const note = serializeRecord(record);
  assert.match(note, /description: "A \\"quoted\\": canoe #1 \[dock\] \\\\ coast"/);
  assert.deepEqual(parseRecord(note), record);
});

test('Markdown embeds escape alt brackets and backslashes, fold newlines, and encode paths', () => {
  const record = fixture({ imagePath: `2026 year/images/${id}.jpg`, description: 'The [red] \\ boat\n at sunset' });
  assert.equal(markdownEmbed(record, '2025/December trip/31.md'), `![The \\[red\\] \\\\ boat at sunset](../../2026%20year/images/${id}.jpg)`);
  assert.equal(markdownEmbed(fixture(), '2026/October/17.md'), `![Canoe beside the dock at sunset.](../images/${id}.jpg)`);
});

test('record supports paths across years and spaces', () => {
  const record = fixture({
    imagePath: `2026 year/images/${id}.jpg`,
    recordPath: `2026 year/image records/${id}.md`,
    sidecarPath: `2026 year/images/${id}.xmp`,
    sourceNotes: ['2025/December trip/31.md', '2026 year/October/17.md'],
  });
  assert.deepEqual(parseRecord(serializeRecord(record)), record);
});

test('description and caption status edits from Bases override the portable snapshot', () => {
  const record = fixture({ captionStatus: 'pending' });
  const note = serializeRecord(record)
    .replace('description: "Canoe beside the dock at sunset."', "description: 'My aunt''s red canoe'")
    .replace('caption_status: "pending"', 'caption_status: confirmed');
  const parsed = parseRecord(note)!;
  assert.equal(parsed.description, "My aunt's red canoe");
  assert.equal(parsed.captionStatus, 'confirmed');
  assert.equal(parsed.sha256, record.sha256);
  assert.equal(parseRecord(serializeRecord(parsed))?.description, "My aunt's red canoe");
});

test('manually folded captions stay one line; blank captions are rejected', () => {
  const note = serializeRecord(fixture());
  const folded = note.replace('description: "Canoe beside the dock at sunset."', 'description: >-\n  A red canoe\n  at sunset');
  assert.equal(parseRecord(folded)?.description, 'A red canoe at sunset');
  assert.equal(parseRecord(note.replace('description: "Canoe beside the dock at sunset."', 'description: "  "')), null);
});

test('parser rejects malformed or mismatched identity and unsafe paths', () => {
  const note = serializeRecord(fixture());
  assert.equal(parseRecord('ordinary Markdown'), null);
  assert.equal(parseRecord(note.replace('"sha256": "' + 'a'.repeat(64) + '"', '"sha256": "bad"')), null);
  assert.equal(parseRecord(note.replace(`image_id: "${id}"`, 'image_id: "not-a-uuid"')), null);
  assert.equal(parseRecord(note.replace('type: "image-ledger-image"', 'type: "other"')), null);
  assert.equal(parseRecord(note.replace('"imagePath": "2026/images/', '"imagePath": "../images/')), null);
  assert.equal(parseRecord(note.replace('"recordPath": "2026/image-records/', '"recordPath": "/outside/')), null);
  assert.equal(parseRecord(note.replace('  - "[[2026/October/17]]"', '  - "[[../outside]]"')), null);
  assert.throws(() => serializeRecord(fixture({ sidecarPath: '../bad.xmp' })), /invalid image record/);
  assert.throws(() => markdownEmbed(fixture(), '../outside.md'), /traversal/);
});

test('XMP contains escaped description, stable UUID, and original capture date only when known', () => {
  const record = fixture({ description: 'A <canoe> & "dock" by Sam\'s cabin' });
  const sidecar = serializeSidecar(record);
  assert.match(sidecar, /<dc:identifier><rdf:Bag><rdf:li>urn:uuid:91d1699d/);
  assert.match(sidecar, /A &lt;canoe&gt; &amp; &quot;dock&quot; by Sam&apos;s cabin/);
  assert.match(sidecar, /<xmp:CreateDate>2026-10-16T19:07:22-04:00<\/xmp:CreateDate>/);
  const missing = fixture();
  missing.metadata = { ...missing.metadata, capturedAt: null, captureTimeStatus: 'missing_from_received_file', captureTimeRaw: null, captureTimeOffset: null };
  assert.doesNotMatch(serializeSidecar(missing), /xmp:CreateDate/);
  assert.doesNotMatch(serializeSidecar(missing), /2026-10-17T14:00/);
});

test('empty source note lists remain valid YAML arrays', () => {
  const record = fixture({ sourceNotes: [] });
  assert.match(serializeRecord(record), /source_notes: \[\]/);
  assert.deepEqual(parseRecord(serializeRecord(record)), record);
});

test('Bases selects image records and displays useful editable fields', () => {
  assert.match(BASE_CONTENT, /type == "image-ledger-image"/);
  for (const key of ['description', 'local_file', 'captured_at', 'imported_at', 'caption_status', 'source_notes']) {
    assert.match(BASE_CONTENT, new RegExp(`      - note\\.${key}`));
  }
});


test('keeps last serialized caption for synchronization even after frontmatter edits', () => {
  const before = fixture();
  const note = serializeRecord(before).replace('description: "Canoe beside the dock at sunset."', 'description: "Updated in Bases"');
  assert.equal(parseRecord(note)?.description, 'Updated in Bases');
  assert.equal(parseRecordSnapshot(note)?.description, before.description);
});

test('normal Obsidian source note link updates override the portable snapshot', () => {
  const note = serializeRecord(fixture()).replace('  - "[[2026/October/17]]"', '  - "[[2026/October/renamed]]"');
  assert.deepEqual(parseRecord(note)?.sourceNotes, ['2026/October/renamed.md']);
  assert.deepEqual(parseRecordSnapshot(note)?.sourceNotes, ['2026/October/17.md']);
});
