// Tiny, fully encoded 2 × 3 RGB fixtures generated with Pillow. These contain
// no personal photographs and need no image utility at test or runtime.
export const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAADAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDGooor7U+RP//Z', 'base64');
export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAAFElEQVR4nGOUq7jEwMDAxMDAgKAAGlgBbuw7gIkAAAAASUVORK5CYII=', 'base64');

function exifTiff(options: { date?: string; offset?: string; subsecond?: string; digitized?: boolean; gps?: boolean } = {}): Buffer {
  const buffer = Buffer.alloc(4096);
  buffer.write('II', 0);
  buffer.writeUInt16LE(42, 2);
  buffer.writeUInt32LE(8, 4);
  const fields: [number, string][] = [[options.digitized ? 0x9004 : 0x9003, options.date ?? '2026:10:17 12:34:56']];
  if (options.offset !== undefined) fields.push([options.digitized ? 0x9012 : 0x9011, options.offset]);
  if (options.subsecond !== undefined) fields.push([options.digitized ? 0x9292 : 0x9291, options.subsecond]);
  const ifdCount = options.gps ? 5 : 4;
  const exifStart = 8 + 2 + ifdCount * 12 + 4;
  const gpsStart = exifStart + 2 + fields.length * 12 + 4;
  let dataOffset = gpsStart + (options.gps ? 2 + 6 * 12 + 4 : 0);
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
  buffer.writeUInt16LE(ifdCount, 8);
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
  if (options.gps) {
    buffer.writeUInt16LE(0x8825, 58);
    buffer.writeUInt16LE(4, 60);
    buffer.writeUInt32LE(1, 62);
    buffer.writeUInt32LE(gpsStart, 66);
    buffer.writeUInt16LE(6, gpsStart);
    ascii(gpsStart + 2, 1, 'S');
    ascii(gpsStart + 26, 3, 'W');
    const altitudeRef = gpsStart + 50;
    buffer.writeUInt16LE(5, altitudeRef);
    buffer.writeUInt16LE(1, altitudeRef + 2);
    buffer.writeUInt32LE(1, altitudeRef + 4);
    buffer.writeUInt8(1, altitudeRef + 8);
    for (const [index, tag, values] of [[1, 2, [12, 30, 0]], [3, 4, [45, 15, 0]], [5, 6, [25]]] as const) {
      const entry = gpsStart + 2 + index * 12;
      buffer.writeUInt16LE(tag, entry);
      buffer.writeUInt16LE(5, entry + 2);
      buffer.writeUInt32LE(values.length, entry + 4);
      buffer.writeUInt32LE(dataOffset, entry + 8);
      for (const value of values) {
        buffer.writeUInt32LE(value, dataOffset);
        buffer.writeUInt32LE(1, dataOffset + 4);
        dataOffset += 8;
      }
    }
  }
  return buffer.subarray(0, dataOffset);
}

export function jpegWithExif(options: Parameters<typeof exifTiff>[0] = {}): Buffer {
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'ascii'), exifTiff(options)]);
  const header = Buffer.from([0xff, 0xe1, 0, 0]);
  header.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([JPEG.subarray(0, 2), header, payload, JPEG.subarray(2)]);
}

export function pngWithExif(options: Parameters<typeof exifTiff>[0] = {}): Buffer {
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
