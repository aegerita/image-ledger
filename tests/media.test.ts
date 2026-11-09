import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { detectImageFormat, extractMetadata, gpsMetadata, sha256 } from '../src/images/media';

import { JPEG, PNG, jpegWithExif, pngWithExif } from './fixtures';

test('identifies encoded JPEG and PNG by bytes, and reads actual stored dimensions', async () => {
  assert.equal(detectImageFormat(JPEG), 'jpg');
  assert.equal(detectImageFormat(PNG), 'png');
  for (const image of [JPEG, PNG]) {
    const result = await extractMetadata(image);
    assert.equal(result.width, 2);
    assert.equal(result.height, 3);
    assert.equal(result.capturedAt, null);
    assert.equal(result.captureTimeStatus, 'missing_from_received_file');
    assert.equal(result.latitude, undefined);
    assert.equal(result.longitude, undefined);
    assert.equal(result.altitude, undefined);
  }
});

test('keeps decimal GPS coordinates and signed altitude from JPEG and PNG without raw metadata', async () => {
  for (const bytes of [jpegWithExif({gps: true}), pngWithExif({gps: true})]) {
    const original = Buffer.from(bytes);
    const metadata = await extractMetadata(bytes);
    assert.equal(metadata.latitude, -12.5);
    assert.equal(metadata.longitude, -45.25);
    assert.equal(metadata.altitude, -25);
    assert.equal('raw' in metadata, false);
    assert.deepEqual(bytes, original);
  }
});

test('GPS selection keeps zero values and omits invalid coordinates or unknown altitude references', () => {
  assert.deepEqual(gpsMetadata({latitude: 0, longitude: 0, GPSAltitude: 0, GPSAltitudeRef: [0]}), {
    latitude: 0, longitude: 0, altitude: 0,
  });
  assert.deepEqual(gpsMetadata({GPSAltitude: 25, GPSAltitudeRef: 0}), {altitude: 25});
  assert.deepEqual(gpsMetadata({latitude: 91, longitude: Infinity, GPSAltitude: 25}), {});
  assert.deepEqual(gpsMetadata({latitude: NaN, longitude: -181, GPSAltitude: -25, GPSAltitudeRef: 1}), {});
});

test('retains raw EXIF date, offset, subseconds, orientation and camera fields', async () => {
  const bytes = jpegWithExif({ offset: '-04:00', subsecond: '0074' });
  const before = Buffer.from(bytes);
  const metadata = await extractMetadata(bytes);
  assert.equal(metadata.capturedAt, '2026-10-17T12:34:56.0074-04:00');
  assert.equal(metadata.captureTimeRaw, '2026:10:17 12:34:56');
  assert.equal(metadata.captureTimeOffset, '-04:00');
  assert.equal(metadata.captureTimeStatus, 'source_offset');
  assert.equal('raw' in metadata, false);
  assert.equal(metadata.orientation, 6);
  assert.equal(metadata.cameraMake, 'Test camera maker');
  assert.equal(metadata.cameraModel, 'Test camera model');
  assert.deepEqual(bytes, before);
  assert.equal(sha256(bytes), createHash('sha256').update(before).digest('hex'));
});

test('does not invent the Mac timezone when source EXIF has no offset', async () => {
  const metadata = await extractMetadata(jpegWithExif({ subsecond: '90' }));
  assert.equal(metadata.capturedAt, '2026-10-17T12:34:56.90');
  assert.equal(metadata.captureTimeStatus, 'timezone_unknown');
  assert.equal(metadata.captureTimeOffset, null);
});

test('reads EXIF embedded in PNG and accepts a real non-hour source offset', async () => {
  const metadata = await extractMetadata(pngWithExif({ offset: '+05:45', subsecond: '123' }));
  assert.equal(metadata.capturedAt, '2026-10-17T12:34:56.123+05:45');
  assert.equal(metadata.captureTimeStatus, 'source_offset');
  assert.equal('raw' in metadata, false);
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

test('hashes exact file bytes', () => {
  assert.equal(sha256(Buffer.from('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});
