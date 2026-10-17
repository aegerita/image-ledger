import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { detectImageFormat, extractMetadata, newImageId, sha256 } from '../src/media';

// Tiny, fully encoded 2 × 3 RGB fixtures generated with Pillow. These contain
// no personal photographs and need no image utility at test or runtime.
const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAADAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDGooor7U+RP//Z', 'base64');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAAFElEQVR4nGOUq7jEwMDAxMDAgKAAGlgBbuw7gIkAAAAASUVORK5CYII=', 'base64');

function exifTiff(options: { date?: string; offset?: string; subsecond?: string; digitized?: boolean } = {}): Buffer {
  const buffer = Buffer.alloc(4096);
  buffer.write('II', 0);
  buffer.writeUInt16LE(42, 2);
  buffer.writeUInt32LE(8, 4);
  const fields: [number, string][] = [[options.digitized ? 0x9004 : 0x9003, options.date ?? '2026:10:17 12:34:56']];
  if (options.offset !== undefined) fields.push([options.digitized ? 0x9012 : 0x9011, options.offset]);
  if (options.subsecond !== undefined) fields.push([options.digitized ? 0x9292 : 0x9291, options.subsecond]);
  const exifStart = 8 + 2 + 4 * 12 + 4;
  let dataOffset = exifStart + 2 + fields.length * 12 + 4;
  function ascii(entry: number, tag: number, value: string): void {
    const text = Buffer.from(`${value}\0`, 'ascii');
    buffer.writeUInt16LE(tag, entry);
    buffer.writeUInt16LE(2, entry + 2);
    buffer.writeUInt32LE(text.length, entry + 4);
    if (text.length <= 4) text.copy(buffer, entry + 8);
    else {
      buffer.writeUInt32LE(dataOffset, entry + 8);
      text.copy(buffer, dataOffset);
      dataOffset += text.length;
    }
  }
  buffer.writeUInt16LE(4, 8);
  ascii(10, 0x010f, 'Test camera maker');
  ascii(22, 0x0110, 'Test camera model');
  buffer.writeUInt16LE(0x0112, 34);
  buffer.writeUInt16LE(3, 36);
  buffer.writeUInt32LE(1, 38);
  buffer.writeUInt16LE(6, 42);
  buffer.writeUInt16LE(0x8769, 46);
  buffer.writeUInt16LE(4, 48);
  buffer.writeUInt32LE(1, 50);
  buffer.writeUInt32LE(exifStart, 54);
  buffer.writeUInt16LE(fields.length, exifStart);
  fields.forEach(([tag, value], index) => ascii(exifStart + 2 + 12 * index, tag, value));
  return buffer.subarray(0, dataOffset);
}

function jpegWithExif(options: Parameters<typeof exifTiff>[0] = {}): Buffer {
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'ascii'), exifTiff(options)]);
  const header = Buffer.from([0xff, 0xe1, 0, 0]);
  header.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([JPEG.subarray(0, 2), header, payload, JPEG.subarray(2)]);
}

function pngWithExif(options: Parameters<typeof exifTiff>[0] = {}): Buffer {
  const payload = exifTiff(options);
  const chunk = Buffer.alloc(payload.length + 12);
  chunk.writeUInt32BE(payload.length);
  chunk.write('eXIf', 4);
  payload.copy(chunk, 8);
  let crc = 0xffffffff;
  for (const byte of chunk.subarray(4, -4)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4);
  return Buffer.concat([PNG.subarray(0, 33), chunk, PNG.subarray(33)]);
}

test('identifies encoded JPEG and PNG by bytes, and reads actual stored dimensions', async () => {
  assert.equal(detectImageFormat(JPEG), 'jpg');
  assert.equal(detectImageFormat(PNG), 'png');
  for (const image of [JPEG, PNG]) {
    const result = await extractMetadata(image);
    assert.equal(result.width, 2);
    assert.equal(result.height, 3);
    assert.equal(result.capturedAt, null);
    assert.equal(result.captureTimeStatus, 'missing_from_received_file');
  }
});

test('retains raw EXIF date, offset, subseconds, orientation and camera fields', async () => {
  const bytes = jpegWithExif({ offset: '-04:00', subsecond: '0074' });
  const before = Buffer.from(bytes);
  const metadata = await extractMetadata(bytes);
  assert.equal(metadata.capturedAt, '2026-10-17T12:34:56.0074-04:00');
  assert.equal(metadata.captureTimeRaw, '2026:10:17 12:34:56');
  assert.equal(metadata.captureTimeOffset, '-04:00');
  assert.equal(metadata.captureTimeStatus, 'source_offset');
  assert.equal(metadata.raw.SubSecTimeOriginal, '0074');
  assert.equal(metadata.raw.OffsetTimeOriginal, '-04:00');
  assert.equal(metadata.raw.DateTimeOriginal, '2026:10:17 12:34:56');
  assert.equal(metadata.orientation, 6);
  assert.equal(metadata.cameraMake, 'Test camera maker');
  assert.equal(metadata.cameraModel, 'Test camera model');
  assert.deepEqual(bytes, before);
  assert.equal(sha256(bytes), createHash('sha256').update(before).digest('hex'));
  assert.deepEqual(JSON.parse(JSON.stringify(metadata.raw)), metadata.raw);
});

test('does not invent the Mac timezone when source EXIF has no offset', async () => {
  const metadata = await extractMetadata(jpegWithExif({ subsecond: '90' }));
  assert.equal(metadata.capturedAt, '2026-10-17T12:34:56.90');
  assert.equal(metadata.captureTimeStatus, 'timezone_unknown');
  assert.equal(metadata.captureTimeOffset, null);
  assert.equal(typeof metadata.raw.DateTimeOriginal, 'string');
});

test('reads EXIF embedded in PNG and accepts a real non-hour source offset', async () => {
  const metadata = await extractMetadata(pngWithExif({ offset: '+05:45', subsecond: '123' }));
  assert.equal(metadata.capturedAt, '2026-10-17T12:34:56.123+05:45');
  assert.equal(metadata.captureTimeStatus, 'source_offset');
  assert.equal(metadata.orientation, 6);
});

test('supports digitized capture date only when the original date is absent', async () => {
  const metadata = await extractMetadata(jpegWithExif({ digitized: true, offset: '+01:00' }));
  assert.equal(metadata.capturedAt, '2026-10-17T12:34:56+01:00');
  assert.equal(metadata.captureTimeStatus, 'source_offset');
});

test('preserves invalid source dates and offsets without silently correcting them', async () => {
  const invalidDate = await extractMetadata(jpegWithExif({ date: '2026:02:30 12:34:56' }));
  assert.equal(invalidDate.capturedAt, null);
  assert.equal(invalidDate.captureTimeRaw, '2026:02:30 12:34:56');
  assert.match(invalidDate.warning ?? '', /could not be interpreted/);
  const invalidOffset = await extractMetadata(jpegWithExif({ offset: '+99:99' }));
  assert.equal(invalidOffset.capturedAt, '2026-10-17T12:34:56');
  assert.equal(invalidOffset.captureTimeOffset, '+99:99');
  assert.equal(invalidOffset.captureTimeStatus, 'timezone_unknown');
  assert.match(invalidOffset.warning ?? '', /without an assumed timezone/);
});

test('handles a Uint8Array view without reading surrounding unrelated bytes', async () => {
  const image = jpegWithExif({ offset: '+00:00' });
  const padded = Buffer.concat([Buffer.alloc(7, 1), image, Buffer.alloc(13, 2)]);
  const view = new Uint8Array(padded.buffer, padded.byteOffset + 7, image.length);
  assert.equal(detectImageFormat(view), 'jpg');
  assert.equal(sha256(view), sha256(image));
  assert.equal((await extractMetadata(view)).capturedAt, '2026-10-17T12:34:56+00:00');
});

test('rejects unsupported files including HEIC with an actionable message', () => {
  for (const bytes of [Buffer.from('GIF89a'), Buffer.from('0000ftypheic'), Buffer.from('<svg/>'), new Uint8Array()]) {
    assert.throws(() => detectImageFormat(bytes), /JPEG and PNG.*HEIC.*still JPEG or PNG/);
  }
});

test('rejects truncated and malformed JPEG/PNG containers before ingestion', () => {
  const zeroWidthPng = Buffer.from(PNG);
  zeroWidthPng.writeUInt32BE(0, 16);
  const hugeChunkPng = Buffer.from(PNG);
  hugeChunkPng.writeUInt32BE(0xffffffff, 8);
  for (const bytes of [JPEG.subarray(0, 3), JPEG.subarray(0, -2), PNG.subarray(0, 8), PNG.subarray(0, -4), zeroWidthPng, hugeChunkPng]) {
    assert.throws(() => detectImageFormat(bytes), /incomplete or has an invalid header/);
  }
});

test('hashes exact file bytes and generates collision-resistant UUIDv4 image names', () => {
  assert.equal(sha256(Buffer.from('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  const ids = Array.from({ length: 100 }, newImageId);
  ids.forEach(id => assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/));
  assert.equal(new Set(ids).size, ids.length);
});
