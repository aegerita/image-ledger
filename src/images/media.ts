import { createHash } from 'node:crypto';
import type { ImageFormat } from './model';

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function invalidImage(format: string): never {
  throw new Error(`This ${format} image is incomplete or has an invalid header. Export or copy the original image again.`);
}

function uint32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0);
}

function validatePng(bytes: Uint8Array): void {
  let offset = 8;
  let hasHeader = false;
  let hasData = false;
  while (offset + 12 <= bytes.length) {
    const length = uint32(bytes, offset);
    if (length > bytes.length - offset - 12) invalidImage('PNG');
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (offset === 8 && type !== 'IHDR') invalidImage('PNG');
    if (type === 'IHDR') {
      if (hasHeader || length !== 13) invalidImage('PNG');
      const width = uint32(bytes, offset + 8);
      const height = uint32(bytes, offset + 12);
      const depth = bytes[offset + 16];
      const color = bytes[offset + 17];
      const validDepths: Record<number, number[]> = {
        0: [1, 2, 4, 8, 16],
        2: [8, 16],
        3: [1, 2, 4, 8],
        4: [8, 16],
        6: [8, 16],
      };
      if (!width || !height || width > 0x7fffffff || height > 0x7fffffff
        || !validDepths[color]?.includes(depth)
        || bytes[offset + 18] !== 0 || bytes[offset + 19] !== 0 || bytes[offset + 20] > 1) {
        invalidImage('PNG');
      }
      hasHeader = true;
    } else if (type === 'IDAT') {
      hasData ||= length > 0;
    } else if (type === 'IEND') {
      if (length !== 0 || !hasHeader || !hasData) invalidImage('PNG');
      return;
    }
    offset += length + 12;
  }
  return invalidImage('PNG');
}

function validateJpeg(bytes: Uint8Array): void {
  let offset = 2;
  let hasHeader = false;
  while (offset < bytes.length) {
    if (bytes[offset++] !== 0xff) invalidImage('JPEG');
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === undefined || marker === 0x00 || marker === 0xd8 || marker === 0xd9) invalidImage('JPEG');
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) invalidImage('JPEG');
    const length = bytes[offset] * 256 + bytes[offset + 1];
    if (length < 2 || offset + length > bytes.length) invalidImage('JPEG');
    if (SOF_MARKERS.has(marker)) {
      if (length < 8) invalidImage('JPEG');
      const height = bytes[offset + 3] * 256 + bytes[offset + 4];
      const width = bytes[offset + 5] * 256 + bytes[offset + 6];
      const components = bytes[offset + 7];
      if (!width || !height || !components || length !== 8 + 3 * components) invalidImage('JPEG');
      hasHeader = true;
    }
    if (marker === 0xda) {
      if (!hasHeader || length < 6) invalidImage('JPEG');
      // Entropy data may contain stuffed FF00 and restart markers. A real EOI
      // is still required; this checks completeness without decoding pixels.
      for (let end = offset + length; end + 1 < bytes.length; end++) {
        if (bytes[end] === 0xff && bytes[end + 1] === 0xd9) return;
      }
      invalidImage('JPEG');
    }
    offset += length;
  }
  return invalidImage('JPEG');
}

export function detectImageFormat(bytes: Uint8Array): ImageFormat {
  if (PNG_SIGNATURE.every((value, index) => bytes[index] === value)) {
    validatePng(bytes);
    return 'png';
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    validateJpeg(bytes);
    return 'jpg';
  }
  throw new Error('Only JPEG and PNG images are supported. Export HEIC or Live Photos as a still JPEG or PNG, then import that file.');
}

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
