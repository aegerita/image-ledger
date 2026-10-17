import { createHash, randomUUID } from 'node:crypto';
import exifr from 'exifr';
import type { ImageFormat, ImageMetadata } from './types';

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
type Dimensions = { width: number; height: number };

function invalidImage(format: string): never {
  throw new Error(`This ${format} image is incomplete or has an invalid header. Export or copy the original image again.`);
}

function uint32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0);
}

function pngDimensions(bytes: Uint8Array): Dimensions {
  let offset = 8;
  let dimensions: Dimensions | undefined;
  let hasData = false;
  while (offset + 12 <= bytes.length) {
    const length = uint32(bytes, offset);
    if (length > bytes.length - offset - 12) invalidImage('PNG');
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (offset === 8 && type !== 'IHDR') invalidImage('PNG');
    if (type === 'IHDR') {
      if (dimensions || length !== 13) invalidImage('PNG');
      const width = uint32(bytes, offset + 8);
      const height = uint32(bytes, offset + 12);
      const depth = bytes[offset + 16];
      const color = bytes[offset + 17];
      const validDepths: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (!width || !height || width > 0x7fffffff || height > 0x7fffffff ||
          !validDepths[color]?.includes(depth) || bytes[offset + 18] !== 0 || bytes[offset + 19] !== 0 || bytes[offset + 20] > 1) {
        invalidImage('PNG');
      }
      dimensions = { width, height };
    } else if (type === 'IDAT') {
      hasData ||= length > 0;
    } else if (type === 'IEND') {
      if (length !== 0 || !dimensions || !hasData) invalidImage('PNG');
      return dimensions;
    }
    offset += length + 12;
  }
  return invalidImage('PNG');
}

function jpegDimensions(bytes: Uint8Array): Dimensions {
  let offset = 2;
  let dimensions: Dimensions | undefined;
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
      dimensions = { width, height };
    }
    if (marker === 0xda) {
      if (!dimensions || length < 6) invalidImage('JPEG');
      // Entropy data may contain stuffed FF00 and restart markers. A real EOI
      // is still required; this checks completeness without decoding pixels.
      for (let end = offset + length; end + 1 < bytes.length; end++) {
        if (bytes[end] === 0xff && bytes[end + 1] === 0xd9) return dimensions;
      }
      invalidImage('JPEG');
    }
    offset += length;
  }
  return invalidImage('JPEG');
}

export function detectImageFormat(bytes: Uint8Array): ImageFormat {
  if (PNG_SIGNATURE.every((value, index) => bytes[index] === value)) {
    pngDimensions(bytes);
    return 'png';
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    jpegDimensions(bytes);
    return 'jpg';
  }
  throw new Error('Only JPEG and PNG images are supported. Export HEIC or Live Photos as a still JPEG or PNG, then import that file.');
}

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function newImageId(): string {
  return randomUUID();
}

function jsonSafe(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  if (ArrayBuffer.isView(value)) return Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  if (value instanceof ArrayBuffer) return Array.from(new Uint8Array(value));
  if (typeof value !== 'object') return undefined;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  const result = Array.isArray(value)
    ? value.map(item => jsonSafe(item, seen) ?? null)
    : Object.fromEntries(Object.entries(value).flatMap(([key, item]) => {
      const safe = jsonSafe(item, seen);
      return safe === undefined ? [] : [[key, safe]];
    }));
  seen.delete(value);
  return result;
}

function sourceString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function normalizeOffset(value: string | null): string | null {
  if (!value) return null;
  if (value.trim() === 'Z') return 'Z';
  const match = /^([+-])(\d{2}):?(\d{2})$/.exec(value.trim());
  if (!match || Number(match[2]) > 23 || Number(match[3]) > 59) return null;
  return `${match[1]}${match[2]}:${match[3]}`;
}

function captureTime(raw: Record<string, unknown>): Pick<ImageMetadata, 'capturedAt' | 'captureTimeRaw' | 'captureTimeOffset' | 'captureTimeStatus' | 'warning'> {
  const original = sourceString(raw.DateTimeOriginal);
  const source = original ?? sourceString(raw.CreateDate) ?? sourceString(raw.DateTimeDigitized);
  if (!source) return { capturedAt: null, captureTimeRaw: null, captureTimeOffset: null, captureTimeStatus: 'missing_from_received_file' };
  const offsetRaw = sourceString(original ? raw.OffsetTimeOriginal : raw.OffsetTimeDigitized);
  const subsecondRaw = sourceString(original ? raw.SubSecTimeOriginal : raw.SubSecTimeDigitized);
  const match = /^(\d{4})[:-](\d{2})[:-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})?$/.exec(source.trim());
  const unavailable = { capturedAt: null, captureTimeRaw: source, captureTimeOffset: offsetRaw, captureTimeStatus: 'missing_from_received_file' as const, warning: 'The source capture date could not be interpreted; its original value is preserved in metadata.' };
  if (!match) return unavailable;
  const [, year, month, day, hour, minute, second, sourceFraction, inlineOffset] = match;
  const yearNumber = Number(year);
  const monthNumber = Number(month);
  const dayNumber = Number(day);
  const leap = yearNumber % 4 === 0 && (yearNumber % 100 !== 0 || yearNumber % 400 === 0);
  const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (monthNumber < 1 || monthNumber > 12 || dayNumber < 1 || dayNumber > monthDays[monthNumber - 1] || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return unavailable;
  const offset = normalizeOffset(offsetRaw ?? inlineOffset ?? null);
  const fraction = sourceFraction ?? (subsecondRaw && /^\d+$/.test(subsecondRaw.trim()) ? subsecondRaw.trim() : null);
  return {
    capturedAt: `${year}-${month}-${day}T${hour}:${minute}:${second}${fraction ? `.${fraction}` : ''}${offset ?? ''}`,
    captureTimeRaw: source,
    captureTimeOffset: offsetRaw ?? inlineOffset ?? null,
    captureTimeStatus: offset ? 'source_offset' : 'timezone_unknown',
    ...((offsetRaw || inlineOffset) && !offset ? { warning: 'The source timezone offset could not be interpreted; capture time is kept without an assumed timezone.' } : {}),
  };
}

export async function extractMetadata(bytes: Uint8Array): Promise<ImageMetadata> {
  const format = detectImageFormat(bytes);
  const dimensions = format === 'png' ? pngDimensions(bytes) : jpegDimensions(bytes);
  let raw: Record<string, unknown> = {};
  let warning: string | undefined;
  try {
    const parsed: unknown = await exifr.parse(bytes, {
      translateKeys: true, translateValues: false, reviveValues: false,
      tiff: true, exif: true, gps: true, ifd1: false, xmp: true, iptc: true, icc: false, ihdr: true,
    });
    const safe = jsonSafe(parsed);
    if (safe && typeof safe === 'object' && !Array.isArray(safe)) raw = safe as Record<string, unknown>;
  } catch {
    warning = 'Some source metadata could not be read. The received image bytes were preserved unchanged.';
  }
  const capture = captureTime(raw);
  const orientation = typeof raw.Orientation === 'number' && Number.isInteger(raw.Orientation) && raw.Orientation >= 1 && raw.Orientation <= 8 ? raw.Orientation : null;
  return {
    ...capture, ...dimensions, orientation,
    cameraMake: sourceString(raw.Make), cameraModel: sourceString(raw.Model), raw,
    ...((warning || capture.warning) ? { warning: [warning, capture.warning].filter(Boolean).join(' ') } : {}),
  };
}
