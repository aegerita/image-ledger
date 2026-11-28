export const MPF = Buffer.from('MPF\0');

export function* jpegHeaders(bytes: Buffer) {
  for (let offset = 2; offset < bytes.length;) {
    const start = offset;
    if (bytes[offset++] !== 0xff) throw new Error('Invalid JPEG marker.');
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    const standalone = marker === 1 || (marker >= 0xd0 && marker <= 0xd7);
    const length = standalone ? 0 : bytes.readUInt16BE(offset);
    if (!standalone && (length < 2 || offset + length > bytes.length)) throw new Error('Invalid JPEG segment.');
    const end = offset + length;
    const payloadStart = standalone ? offset : offset + 2;
    yield {start, marker, end, payloadStart};
    if (marker === 0xda) return;
    offset = end;
  }
}

export function jpegFrameEnd(bytes: Buffer, offset: number): number {
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

function readIndex(tiff: Buffer) {
  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  const order = tiff.toString('ascii', 0, 2);
  if (tiff.length < 8 || (order !== 'II' && order !== 'MM')) return;
  const little = order === 'II';
  if (view.getUint16(2, little) !== 42) return;
  const ifd = view.getUint32(4, little);
  if (ifd < 8 || ifd + 2 > tiff.length) return;
  const ifdEnd = ifd + 2 + view.getUint16(ifd, little) * 12;
  if (ifdEnd + 4 > tiff.length) return;
  let imageCount: number | undefined;
  let index: {list: number; count: number} | undefined;
  let ambiguous = false;
  for (let field = ifd + 2; field < ifdEnd; field += 12) {
    const tag = view.getUint16(field, little);
    if (tag === 0xb001) {
      if (imageCount !== undefined) ambiguous = true;
      imageCount = view.getUint16(field + 2, little) === 4 && view.getUint32(field + 4, little) === 1
        ? view.getUint32(field + 8, little) : -1;
    }
    if (tag !== 0xb002) continue;
    if (index) {
      ambiguous = true;
      continue;
    }
    if (view.getUint16(field + 2, little) !== 7) return;
    const length = view.getUint32(field + 4, little);
    const list = view.getUint32(field + 8, little);
    if (!length || length % 16 || list < ifdEnd + 4 || list + length > tiff.length) return;
    if (view.getUint32(list + 8, little) !== 0) return;
    index = {list, count: length / 16};
  }
  if (!index) return imageCount === undefined ? null : undefined; // An attribute-only MPF has no index.
  return {...index, view, little, validCount: !ambiguous && imageCount === index.count};
}

export function normalizeMpf(segment: Buffer, payloadOffset: number, base: number, bytes: Buffer, frameEnd: number): Buffer {
  const copy = Buffer.from(segment);
  const index = readIndex(copy.subarray(payloadOffset + MPF.length));
  if (!index) return segment;
  const {view, little, list, count} = index;
  view.setUint32(list + 4, 0, little);
  for (let i = 1; i < count; i++) {
    const entry = list + 16 * i;
    const relative = view.getUint32(entry + 8, little);
    const start = base + relative;
    const end = start + view.getUint32(entry + 4, little);
    if (!relative || start < frameEnd || end < start + 4 || end > bytes.length
      || bytes[start] !== 0xff || bytes[start + 1] !== 0xd8) return segment;
    view.setUint32(entry + 8, start - frameEnd, little);
  }
  return copy;
}

function primaryIndex(bytes: Buffer) {
  let table;
  for (const {marker, payloadStart, end} of jpegHeaders(bytes)) {
    if (marker === 0xda && table) return {...table, frameEnd: jpegFrameEnd(bytes, end)};
    if (marker !== 0xe2 || !bytes.subarray(payloadStart, payloadStart + MPF.length).equals(MPF)) continue;
    const base = payloadStart + MPF.length;
    const index = readIndex(bytes.subarray(base, end));
    if (index === null) continue;
    if (!index?.validCount || table) return null;
    table = {...index, base};
  }
}

// Secondary entries are TIFF-relative, but the trailer moves with the primary EOI during a caption edit.
export function repairMpfIndex(original: Buffer, saved: Buffer): Buffer | undefined {
  const target = primaryIndex(saved);
  if (target === null) return;
  if (!target) return saved; // The identity check also detects a removed index.
  const source = original === saved ? target : primaryIndex(original);
  if (!source || source.count !== target.count || target.frameEnd > 0xffffffff
    || !original.subarray(source.frameEnd).equals(saved.subarray(target.frameEnd))) return;
  let output = saved;
  const {view, little, base} = target;
  function update(field: number, value: number) {
    if (view.getUint32(field, little) === value) return;
    if (output === saved) output = Buffer.from(saved);
    if (little) output.writeUInt32LE(value, base + field);
    else output.writeUInt32BE(value, base + field);
  }
  update(target.list + 4, target.frameEnd);
  for (let i = 1; i < source.count; i++) {
    const from = source.list + 16 * i;
    const to = target.list + 16 * i;
    const start = source.base + source.view.getUint32(from + 8, source.little);
    const size = source.view.getUint32(from + 4, source.little);
    const end = start + size;
    if (start < source.frameEnd || size < 4 || end > original.length
      || original.readUInt16BE(start) !== 0xffd8 || original.readUInt16BE(end - 2) !== 0xffd9
      || target.view.getUint32(to + 4, target.little) !== size) return;
    const relative = target.frameEnd + (start - source.frameEnd) - target.base;
    if (relative <= 0 || relative > 0xffffffff) return;
    update(to + 8, relative);
  }
  return output;
}
