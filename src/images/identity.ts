import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { detectImageFormat } from './media';
import { canonicalXmp } from './xmp';

const XMP_PNG = Buffer.from('XML:com.adobe.xmp\0');
const XMP_JPEG = Buffer.from('http://ns.adobe.com/xap/1.0/\0');
const XMP_EXTENDED = Buffer.from('http://ns.adobe.com/xmp/extension/\0');
const MPF = Buffer.from('MPF\0');
const PNG_TEXT = new Set(['iTXt', 'tEXt', 'zTXt']);

function invalidXmp(): never {
  throw new Error('The image contains an invalid or incomplete XMP packet. Export the original image again.');
}

function inflateXmp(bytes: Buffer): Buffer {
  try {
    return inflateSync(bytes, {maxOutputLength: 32 * 1024 * 1024});
  } catch {
    return invalidXmp();
  }
}

function pngXmp(type: string, data: Buffer): Buffer {
  const header = XMP_PNG.length;
  if (type === 'tEXt') return data.subarray(header);
  if (type === 'zTXt') {
    if (data[header] !== 0) invalidXmp();
    return inflateXmp(data.subarray(header + 1));
  }
  const compressed = data[header];
  if ((compressed !== 0 && compressed !== 1) || data[header + 1] !== 0) invalidXmp();
  const language = data.indexOf(0, header + 2);
  const translated = language === -1 ? -1 : data.indexOf(0, language + 1);
  if (translated === -1) invalidXmp();
  const text = data.subarray(translated + 1);
  return compressed === 1 ? inflateXmp(text) : text;
}

async function pngIdentity(bytes: Buffer): Promise<string> {
  const chunks = [bytes.subarray(0, 8)];
  const metadata: Buffer[] = [];
  const packets: Buffer[] = [];
  for (let offset = 8; offset < bytes.length;) {
    const type = bytes.toString('latin1', offset + 4, offset + 8);
    const end = offset + bytes.readUInt32BE(offset) + 12;
    const chunk = bytes.subarray(offset, end);
    if (PNG_TEXT.has(type) && chunk.subarray(8, 8 + XMP_PNG.length).equals(XMP_PNG)) {
      packets.push(pngXmp(type, chunk.subarray(8, -4)));
    } else if (PNG_TEXT.has(type) || type === 'eXIf') {
      // ExifTool moves text and EXIF before IDAT when writing PNG metadata.
      metadata.push(chunk);
    } else {
      chunks.push(chunk);
    }
    if (type === 'IEND') {
      chunks.push(bytes.subarray(end));
      break;
    }
    offset = end;
  }
  if (packets.length > 1) invalidXmp();
  return identity(chunks, metadata, await canonicalXmp(packets));
}

interface ExtendedChunk {
  guid: string;
  length: number;
  offset: number;
  data: Buffer;
}

function extendedChunk(bytes: Buffer): ExtendedChunk {
  if (bytes.length <= 40) invalidXmp();
  const guid = bytes.toString('latin1', 0, 32).toUpperCase();
  if (!/^[0-9A-F]{32}$/.test(guid)) invalidXmp();
  return {guid, length: bytes.readUInt32BE(32), offset: bytes.readUInt32BE(36), data: bytes.subarray(40)};
}

function extendedPacket(chunks: ExtendedChunk[]): Buffer {
  const {guid, length} = chunks[0];
  let end = 0;
  for (const chunk of chunks.sort((a, b) => a.offset - b.offset)) {
    if (chunk.guid !== guid || chunk.length !== length || chunk.offset !== end) invalidXmp();
    end += chunk.data.length;
  }
  if (end !== length) invalidXmp();
  const packet = Buffer.concat(chunks.map(chunk => chunk.data), length);
  if (createHash('md5').update(packet).digest('hex').toUpperCase() !== guid) invalidXmp();
  return packet;
}

function jpegFrameEnd(bytes: Buffer, offset: number): number {
  while (offset < bytes.length) {
    const start = bytes.indexOf(0xff, offset);
    if (start === -1) break;
    offset = start + 1;
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xd9) return offset;
    if (marker === 0xd8) break;
    if (marker === 0 || marker === 1 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) break;
    const length = bytes.readUInt16BE(offset);
    if (length < 2) break;
    offset += length;
  }
  throw new Error('The JPEG frame is incomplete. Export the original image again.');
}

function normalizeMpf(segment: Buffer, payloadOffset: number, absoluteBase: number, bytes: Buffer, frameEnd: number): Buffer {
  const copy = Buffer.from(segment);
  const tiff = copy.subarray(payloadOffset + MPF.length);
  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  const order = tiff.toString('ascii', 0, 2);
  if (tiff.length < 8 || (order !== 'II' && order !== 'MM')) return segment;
  const little = order === 'II';
  if (view.getUint16(2, little) !== 42) return segment;
  const ifd = view.getUint32(4, little);
  if (ifd < 8 || ifd + 2 > tiff.length) return segment;
  const ifdEnd = ifd + 2 + view.getUint16(ifd, little) * 12;
  if (ifdEnd + 4 > tiff.length) return segment;
  for (let field = ifd + 2; field < ifdEnd; field += 12) {
    if (view.getUint16(field, little) !== 0xb002) continue;
    if (view.getUint16(field + 2, little) !== 7) return segment;
    const length = view.getUint32(field + 4, little);
    const list = view.getUint32(field + 8, little);
    if (!length || length % 16 || list < ifdEnd + 4 || list + length > tiff.length) return segment;
    if (view.getUint32(list + 8, little) !== 0) return segment;
    // The first size and later offsets move when the primary JPEG's XMP changes.
    view.setUint32(list + 4, 0, little);
    for (let entry = list + 16; entry < list + length; entry += 16) {
      const relative = view.getUint32(entry + 8, little);
      const start = absoluteBase + relative;
      const end = start + view.getUint32(entry + 4, little);
      if (!relative || start < frameEnd || end < start + 4 || end > bytes.length
        || bytes[start] !== 0xff || bytes[start + 1] !== 0xd8) return segment;
      view.setUint32(entry + 8, start - frameEnd, little);
    }
    return copy;
  }
  return segment;
}

async function jpegIdentity(bytes: Buffer): Promise<string> {
  const chunks = [bytes.subarray(0, 2)];
  const packets: Buffer[] = [];
  const extended: ExtendedChunk[] = [];
  const mpf: {index: number; payloadOffset: number; absoluteBase: number}[] = [];
  for (let offset = 2; offset < bytes.length;) {
    const start = offset;
    offset++;
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 1 || (marker >= 0xd0 && marker <= 0xd7)) {
      chunks.push(bytes.subarray(start, offset));
      continue;
    }
    const end = offset + bytes.readUInt16BE(offset);
    if (marker === 0xda) {
      if (mpf.length) {
        const frameEnd = jpegFrameEnd(bytes, end);
        for (const {index, payloadOffset, absoluteBase} of mpf) {
          chunks[index] = normalizeMpf(chunks[index], payloadOffset, absoluteBase, bytes, frameEnd);
        }
      }
      chunks.push(bytes.subarray(start));
      break;
    }
    const payload = bytes.subarray(offset + 2, end);
    if (marker === 0xe1 && payload.subarray(0, XMP_JPEG.length).equals(XMP_JPEG)) {
      packets.push(payload.subarray(XMP_JPEG.length));
    } else if (marker === 0xe1 && payload.subarray(0, XMP_EXTENDED.length).equals(XMP_EXTENDED)) {
      extended.push(extendedChunk(payload.subarray(XMP_EXTENDED.length)));
    } else {
      if (marker === 0xe2 && payload.subarray(0, MPF.length).equals(MPF)) {
        mpf.push({index: chunks.length, payloadOffset: offset + 2 - start, absoluteBase: offset + 2 + MPF.length});
      }
      chunks.push(bytes.subarray(start, end));
    }
    offset = end;
  }
  if (packets.length > 1 || (extended.length && packets.length !== 1)) invalidXmp();
  if (extended.length) packets.push(extendedPacket(extended));
  return identity(chunks, [], await canonicalXmp(packets, extended[0]?.guid));
}

function identity(chunks: Buffer[], movableMetadata: Buffer[], xmp: string): string {
  const metadataSize = movableMetadata.reduce((size, chunk) => size + chunk.length, 0);
  const hash = createHash('sha256').update(`Image Ledger image identity v2\0${JSON.stringify([xmp, metadataSize])}\0`);
  for (const chunk of movableMetadata) hash.update(chunk);
  for (const chunk of chunks) hash.update(chunk);
  return `v2-${hash.digest('hex')}`;
}

export async function imageIdentity(bytes: Uint8Array): Promise<string> {
  const format = detectImageFormat(bytes);
  const contents = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return format === 'png' ? pngIdentity(contents) : jpegIdentity(contents);
}
