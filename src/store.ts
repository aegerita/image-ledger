import path from 'node:path';
import { detectImageFormat, extractMetadata, newImageId, sha256 } from './media';
import { BASE_CONTENT, normalizeDescription, parseRecord, serializeRecord, serializeSidecar } from './records';
import type { ImageRecord, MediaInput } from './types';

export interface VaultIO {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  write(path: string, text: string): Promise<void>;
  readBinary(path: string): Promise<Uint8Array>;
  writeBinary(path: string, bytes: Uint8Array, mtime?: number): Promise<void>;
  mkdir(path: string): Promise<void>;
  remove(path: string): Promise<void>;
  recordPaths(): Promise<string[]>;
  pendingPaths(): Promise<string[]>;
}
export interface PendingCapture {
  version: 1;
  id: string;
  dataPath: string;
  transactionPath: string;
  sourcePath: string;
  journalDate: string;
  importedAt: string;
  name: string | null;
  lastModified: number | null;
  method: MediaInput['method'];
  format: 'jpg' | 'png';
}
export interface PreparedCapture {
  pending: PendingCapture;
  record: ImageRecord;
  duplicate: boolean;
}
const STATE_DIR = '.journal-media/staging';

export function journalLocation(sourcePath: string, now = new Date()): { year: string; date: string } {
  const filename = path.posix.basename(sourcePath, '.md');
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(filename);
  if (match && Number(match[2]) >= 1 && Number(match[2]) <= 12 && Number(match[3]) >= 1 && Number(match[3]) <= 31) {
    return {year: match[1], date: filename};
  }
  const year = /^(\d{4})\//.exec(sourcePath)?.[1] ?? String(now.getFullYear());
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return {year, date: today};
}

export class MediaStore {
  private records = new Map<string, ImageRecord>();
  private byHash = new Map<string, ImageRecord>();
  private serial: Promise<unknown> = Promise.resolve();
  constructor(private io: VaultIO) {}

  async initialize(): Promise<void> {
    await this.io.mkdir(STATE_DIR);
    await this.refresh();
    if (!await this.io.exists('journal-images.base')) await this.io.write('journal-images.base', BASE_CONTENT);
  }

  async refresh(): Promise<void> {
    const records = new Map<string, ImageRecord>();
    const hashes = new Map<string, ImageRecord>();
    for (const file of await this.io.recordPaths()) {
      const record = parseRecord(await this.io.read(file));
      if (record && record.recordPath === file) {
        records.set(record.id, record);
        hashes.set(record.sha256, record);
      }
    }
    this.records = records;
    this.byHash = hashes;
  }

  allRecords(): ImageRecord[] { return [...this.records.values()]; }

  async retarget(pending: PendingCapture, sourcePath: string): Promise<void> {
    pending.sourcePath = sourcePath;
    await this.io.write(pending.transactionPath, JSON.stringify(pending, null, 2));
  }

  async stage(input: MediaInput, sourcePath: string): Promise<PendingCapture> {
    const format = detectImageFormat(input.bytes);
    const id = newImageId();
    const location = journalLocation(sourcePath);
    const pending: PendingCapture = {
      version: 1, id, dataPath: `${STATE_DIR}/${id}.${format}`, transactionPath: `${STATE_DIR}/${id}.json`,
      sourcePath, journalDate: location.date, importedAt: new Date().toISOString(),
      name: input.name ?? null, lastModified: input.lastModified && input.lastModified > 0 ? input.lastModified : null,
      method: input.method, format,
    };
    await this.io.mkdir(STATE_DIR);
    // Receipt first: a process interruption can leave recoverable bytes, never an untracked staging file.
    await this.io.write(pending.transactionPath, JSON.stringify(pending, null, 2));
    await this.io.writeBinary(pending.dataPath, input.bytes);
    if (sha256(await this.io.readBinary(pending.dataPath)) !== sha256(input.bytes)) throw new Error('Image staging verification failed. The original clipboard image has not been inserted.');
    return pending;
  }

  prepare(pending: PendingCapture): Promise<PreparedCapture> {
    return this.exclusive(async () => {
      const bytes = await this.io.readBinary(pending.dataPath);
      const hash = sha256(bytes);
      // Re-read records so edits made through Bases remain authoritative.
      await this.refresh();
      const known = this.byHash.get(hash);
      if (known) {
        if (await this.io.exists(known.imagePath)) {
          if (sha256(await this.io.readBinary(known.imagePath)) !== hash) throw new Error('The existing image differs from its recorded hash. Your new capture remains staged; resolve the modified file before reusing it.');
        } else {
          await this.io.mkdir(path.posix.dirname(known.imagePath));
          await this.io.writeBinary(known.imagePath, bytes, pending.lastModified ?? undefined);
        }
        return {pending, record: {...known, journalEntries: [...new Set([...known.journalEntries, pending.sourcePath])]}, duplicate: true};
      }
      const year = journalLocation(pending.sourcePath).year;
      const imagePath = `${year}/images/${pending.id}.${pending.format}`;
      const recordPath = `${year}/image-records/${pending.id}.md`;
      const record: ImageRecord = {
        schemaVersion: 1, id: pending.id, description: 'Description pending', captionStatus: 'pending',
        imagePath, recordPath, sidecarPath: `${year}/images/${pending.id}.xmp`,
        sourceName: pending.name, sourceLastModified: pending.lastModified,
        ingestMethod: pending.method, importedAt: pending.importedAt, journalDate: pending.journalDate,
        journalEntries: [pending.sourcePath], sha256: hash, bytes: bytes.byteLength, format: pending.format,
        metadata: await extractMetadata(bytes),
      };
      await this.io.mkdir(path.posix.dirname(imagePath));
      if (!await this.io.exists(imagePath)) await this.io.writeBinary(imagePath, bytes, pending.lastModified ?? undefined);
      if (sha256(await this.io.readBinary(imagePath)) !== hash) throw new Error('Saved image hash verification failed. The capture is still staged for recovery.');
      await this.persist(record);
      return {pending, record, duplicate: false};
    });
  }

  async describe(prepared: PreparedCapture, description: string | null): Promise<ImageRecord> {
    const record: ImageRecord = {
      ...prepared.record,
      description: description === null ? prepared.record.description : normalizeDescription(description),
      captionStatus: description === null ? prepared.record.captionStatus : 'confirmed',
    };
    await this.persist(record);
    prepared.record = record;
    return record;
  }

  async persist(record: ImageRecord): Promise<void> {
    await this.io.mkdir(path.posix.dirname(record.recordPath));
    await this.io.write(record.recordPath, serializeRecord(record));
    await this.io.write(record.sidecarPath, serializeSidecar(record));
    this.records.set(record.id, record);
    this.byHash.set(record.sha256, record);
  }

  async complete(pending: PendingCapture): Promise<void> {
    // Remove the receipt last. If interrupted, recovery can safely reuse an already saved asset.
    await this.io.remove(pending.dataPath);
    await this.io.remove(pending.transactionPath);
  }

  async pendingCaptures(): Promise<PendingCapture[]> {
    const captures: PendingCapture[] = [];
    for (const file of await this.io.pendingPaths()) {
      if (!file.endsWith('.json')) continue;
      try {
        const item = JSON.parse(await this.io.read(file)) as PendingCapture;
        if (item.version === 1 && /^[0-9a-f-]{36}$/.test(item.id) && item.transactionPath === `${STATE_DIR}/${item.id}.json` && item.dataPath === `${STATE_DIR}/${item.id}.${item.format}` && ['jpg', 'png'].includes(item.format) && await this.io.exists(item.dataPath)) captures.push(item);
      } catch { /* A partial receipt is retained for manual inspection, never treated as a valid image. */ }
    }
    return captures;
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.serial.then(operation, operation);
    this.serial = next.catch(() => {});
    return next;
  }
}
