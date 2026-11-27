import assert from 'node:assert/strict';
import test from 'node:test';
import { detectImageFormat, sha256 } from '../src/images/media';
import { repairMpfIndex } from '../src/images/mpf';
import { JPEG, PNG, jpegWithMpf } from './fixtures';

test('identifies valid JPEG and PNG containers by bytes', () => {
  assert.equal(detectImageFormat(JPEG), 'jpg');
  assert.equal(detectImageFormat(PNG), 'png');
});

test('handles a Uint8Array view without reading surrounding unrelated bytes', () => {
  for (const [image, format] of [[JPEG, 'jpg'], [PNG, 'png']] as const) {
    const padded = Buffer.concat([Buffer.alloc(7, 1), image, Buffer.alloc(13, 2)]);
    const view = new Uint8Array(padded.buffer, padded.byteOffset + 7, image.length);
    assert.equal(detectImageFormat(view), format);
    assert.equal(sha256(view), sha256(image));
  }
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

test('MPF repair refuses mismatched image counts and changes to auxiliary frame data', () => {
  const original = jpegWithMpf();
  const tiff = original.indexOf(Buffer.from('MPF\0')) + 4;
  const invalidCount = Buffer.from(original);
  invalidCount.writeUInt32LE(4, tiff + 30);
  assert.equal(repairMpfIndex(original, invalidCount), undefined);
  const changedTrailer = Buffer.from(original);
  changedTrailer[original.length - 4] ^= 1;
  assert.equal(repairMpfIndex(original, changedTrailer), undefined);
  assert.equal(repairMpfIndex(original, original), original);
});
