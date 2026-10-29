import path from 'node:path';
import { createImageId, isImageId } from './ids';
import { detectImageFormat, extractMetadata, sha256 } from './media';
import { BASE_CONTENT, normalizeDescription, parseRecord, parseRecordSnapshot, serializeRecord, serializeSidecar } from './records';
import type { ImageRecord, MediaInput } from './model';
import type { StorageLayout } from '../settings';
import { OPERATION_DIR, operationPath, parseOperation, type ProjectionJournal, type RecordIntent, type RecordOperation } from './operations';

export interface VaultIO {
  reserveId(id: string): Promise<boolean>;
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  write(path: string, text: string): Promise<void>;
  process(path: string, update: (content: string) => string): Promise<void>;
  readBinary(path: string): Promise<Uint8Array>;
  writeBinary(path: string, bytes: Uint8Array, mtime?: number): Promise<void>;
  mkdir(path: string): Promise<void>;
  remove(path: string): Promise<void>;
  recordPaths(): Promise<string[]>;
  pendingPaths(): Promise<string[]>;
  operationPaths(): Promise<string[]>;
}

export interface PendingCapture {
  version: 1;
  id: string;
  dataPath: string;
  transactionPath: string;
  sourcePath: string;
  storageFolder: string;
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

type SynchronizeRecord = (previous: ImageRecord, next: ImageRecord, journal: ProjectionJournal) => Promise<void>;

const STATE_DIR = '.image-ledger/staging';

function applyIntent(current: ImageRecord, intent: RecordIntent): ImageRecord {
  if (intent.kind === 'description') {
    const next: ImageRecord = intent.description === null ? current
      : {...current, description: normalizeDescription(intent.description), captionStatus: 'confirmed'};
    if (!intent.source) return next;
    const source = intent.source;
    const sourceNotes = [...next.sourceNotes, source.from].map(value => value === source.from ? source.to : value);
    return {...next, sourceNotes: [...new Set(sourceNotes)]};
  }
  if (intent.kind === 'rename') {
    const rewrite = (value: string) => rewritePath(value, intent.from, intent.to);
    return {
      ...current,
      imagePath: rewrite(current.imagePath),
      recordPath: rewrite(current.recordPath),
      sidecarPath: rewrite(current.sidecarPath),
      sourceNotes: current.sourceNotes.map(rewrite),
    };
  }
  return current;
}

function rewritePath(value: string, from: string, to: string): string {
  if (value === from) return to;
  if (value.startsWith(from + '/')) return to + value.slice(from.length);
  return value;
}

export function storageFolder(sourcePath: string, importedAt: Date, layout: StorageLayout): string {
  if (layout === 'flat') return '';
  if (layout === 'import-year') return String(importedAt.getFullYear());

  const filename = path.posix.basename(sourcePath, '.md');
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(filename);
  if (match
    && Number(match[2]) >= 1 && Number(match[2]) <= 12
    && Number(match[3]) >= 1 && Number(match[3]) <= 31) {
    return match[1];
  }
  return /^(\d{4})\//.exec(sourcePath)?.[1] ?? String(importedAt.getFullYear());
}

export class MediaStore {
  private records = new Map<string, ImageRecord>();
  private byHash = new Map<string, ImageRecord>();
  private serial: Promise<unknown> = Promise.resolve();

  constructor(
    private io: VaultIO,
    private settings: {storageLayout: StorageLayout} = {storageLayout: 'flat'},
    private newId: () => string = createImageId,
  ) {}

  async initialize(synchronize?: SynchronizeRecord): Promise<void> {
    await this.io.mkdir(STATE_DIR);
    await this.io.mkdir(OPERATION_DIR);
    await this.refresh(synchronize);
    if (!await this.io.exists('image-library.base')) {
      await this.io.write('image-library.base', BASE_CONTENT);
    }
  }

  refresh(synchronize?: SynchronizeRecord): Promise<void> {
    return this.exclusive(() => this.refreshRecords(synchronize));
  }

  private async refreshRecords(synchronize?: SynchronizeRecord): Promise<void> {
    const saved = new Map<string, {content: string; record: ImageRecord | null}>();
    const identities = new Map<string, string>();
    // Detect conflicting imports before recovery or reconciliation can write anything.
    for (const file of await this.io.recordPaths()) {
      const content = await this.io.read(file);
      const record = parseRecord(content);
      if (record) {
        const hash = identities.get(record.id);
        if (hash && hash !== record.sha256) {
          throw new Error(`Image ID conflict: ${record.id} belongs to different image hashes. Both records were preserved.`);
        }
        identities.set(record.id, record.sha256);
      }
      saved.set(file, {content, record});
    }
    if (synchronize) {
      for (const file of await this.io.operationPaths()) {
        const record = await this.resumeOperation(file, synchronize);
        const content = await this.io.read(record.recordPath);
        saved.set(record.recordPath, {content, record: parseRecord(content)});
      }
    }
    const records = new Map<string, ImageRecord>();
    const hashes = new Map<string, ImageRecord>();
    for (const [file, entry] of saved) {
      let {content, record} = entry;
      if (record && record.recordPath !== file && synchronize && !await this.io.exists(record.recordPath)) {
        if (await this.findMovedRecord(record) === file) {
          await this.mutate(file, record.id, {kind: 'reconcile'}, synchronize);
          content = await this.io.read(file);
          record = parseRecord(content);
        }
      }
      if (record && record.recordPath === file) {
        if (synchronize) {
          record = await this.reconcileRecord(record, content, synchronize);
        }
        records.set(record.id, record);
        hashes.set(record.sha256, record);
      }
    }
    this.records = records;
    this.byHash = hashes;
  }

  allRecords(): ImageRecord[] {
    return [...this.records.values()];
  }

  async retarget(pending: PendingCapture, sourcePath: string): Promise<void> {
    pending.sourcePath = sourcePath;
    await this.io.write(pending.transactionPath, JSON.stringify(pending, null, 2));
  }

  async stage(input: MediaInput, sourcePath: string): Promise<PendingCapture> {
    const format = detectImageFormat(input.bytes);
    const now = new Date();
    const folder = storageFolder(sourcePath, now, this.settings.storageLayout);
    const id = await this.reserveId(folder);
    const pending: PendingCapture = {
      version: 1,
      id,
      dataPath: `${STATE_DIR}/${id}.${format}`,
      transactionPath: `${STATE_DIR}/${id}.json`,
      sourcePath,
      storageFolder: folder,
      importedAt: now.toISOString(),
      name: input.name ?? null,
      lastModified: input.lastModified && input.lastModified > 0 ? input.lastModified : null,
      method: input.method,
      format,
    };

    await this.io.mkdir(STATE_DIR);
    // Receipt first: a process interruption can leave recoverable bytes, never an untracked staging file.
    await this.io.write(pending.transactionPath, JSON.stringify(pending, null, 2));
    await this.io.writeBinary(pending.dataPath, input.bytes);
    if (sha256(await this.io.readBinary(pending.dataPath)) !== sha256(input.bytes)) {
      throw new Error('Image staging verification failed. The original clipboard image has not been inserted.');
    }
    return pending;
  }

  private async reserveId(folder: string): Promise<string> {
    const prefix = folder ? `${folder}/` : '';
    for (let attempt = 0; attempt < 100; attempt++) {
      const id = this.newId();
      if (!isImageId(id) || id.length !== 12) throw new Error('Invalid generated image ID.');
      if (this.records.has(id)) continue;
      const destinations = [
        `${prefix}images/${id}.jpg`,
        `${prefix}images/${id}.png`,
        `${prefix}images/${id}.xmp`,
        `${prefix}image-records/${id}.md`,
      ];
      let occupied = false;
      for (const destination of destinations) {
        if (await this.io.exists(destination)) {
          occupied = true;
          break;
        }
      }
      if (!occupied && await this.io.reserveId(id)) return id;
    }
    throw new Error('Could not reserve a unique image ID after 100 attempts. No existing files were replaced.');
  }

  prepare(pending: PendingCapture, synchronize?: SynchronizeRecord): Promise<PreparedCapture> {
    return this.exclusive(async () => {
      const bytes = await this.io.readBinary(pending.dataPath);
      const hash = sha256(bytes);
      // Re-read records so edits made through Bases remain authoritative.
      await this.refreshRecords(synchronize);
      const known = this.byHash.get(hash);

      if (known) {
        if (await this.io.exists(known.imagePath)) {
          if (sha256(await this.io.readBinary(known.imagePath)) !== hash) {
            throw new Error('The existing image differs from its recorded hash. Your new capture remains staged; resolve the modified file before reusing it.');
          }
        } else {
          await this.io.mkdir(path.posix.dirname(known.imagePath));
          await this.io.writeBinary(known.imagePath, bytes, pending.lastModified ?? undefined);
        }
        return {
          pending,
          record: {
            ...known,
            sourceNotes: [...new Set([...known.sourceNotes, pending.sourcePath])],
          },
          duplicate: true,
        };
      }

      const folder = pending.storageFolder;
      const prefix = folder ? `${folder}/` : '';
      const imagePath = `${prefix}images/${pending.id}.${pending.format}`;
      const recordPath = `${prefix}image-records/${pending.id}.md`;
      const record: ImageRecord = {
        schemaVersion: 2,
        id: pending.id,
        description: 'Description pending',
        captionStatus: 'pending',
        imagePath,
        recordPath,
        sidecarPath: `${prefix}images/${pending.id}.xmp`,
        sourceName: pending.name,
        sourceLastModified: pending.lastModified,
        ingestMethod: pending.method,
        importedAt: pending.importedAt,
        sourceNotes: [pending.sourcePath],
        sha256: hash,
        bytes: bytes.byteLength,
        format: pending.format,
        metadata: await extractMetadata(bytes),
      };

      await this.io.mkdir(path.posix.dirname(imagePath));
      if (!await this.io.exists(imagePath)) {
        await this.io.writeBinary(imagePath, bytes, pending.lastModified ?? undefined);
      }
      if (sha256(await this.io.readBinary(imagePath)) !== hash) {
        throw new Error('Saved image hash verification failed. The capture is still staged for recovery.');
      }
      await this.persist(record);
      return {pending, record, duplicate: false};
    });
  }

  describe(
    prepared: PreparedCapture,
    description: string | null,
    sourcePath = prepared.pending.sourcePath,
    synchronize?: SynchronizeRecord,
  ): Promise<ImageRecord> {
    const originalSource = prepared.pending.sourcePath;
    return this.exclusive(async () => {
      const recordPath = this.records.get(prepared.record.id)?.recordPath ?? prepared.record.recordPath;
      if (sourcePath !== originalSource) await this.retarget(prepared.pending, sourcePath);
      const record = await this.mutate(recordPath, prepared.record.id, {
        kind: 'description', description, source: {from: originalSource, to: sourcePath},
      }, synchronize);
      prepared.record = record;
      return record;
    });
  }

  setDescription(record: ImageRecord, description: string, synchronize: SynchronizeRecord): Promise<ImageRecord> {
    return this.exclusive(() => {
      const recordPath = this.records.get(record.id)?.recordPath ?? record.recordPath;
      return this.mutate(recordPath, record.id, {kind: 'description', description}, synchronize);
    });
  }

  rename(previousPath: string, renamedPath: string, synchronize: SynchronizeRecord): Promise<void> {
    const intent: RecordIntent = {kind: 'rename', from: previousPath, to: renamedPath};
    return this.exclusive(async () => {
      // Relocate every affected receipt before a projection failure can stop this rename.
      for (const file of await this.io.operationPaths()) {
        const operation = parseOperation(await this.io.read(file), file);
        if (rewritePath(operation.recordPath, previousPath, renamedPath) !== operation.recordPath) {
          await this.retargetOperation(operation);
        }
      }
      for (const cached of this.records.values()) {
        const recordPath = rewritePath(cached.recordPath, previousPath, renamedPath);
        if (!await this.io.exists(recordPath)) continue;
        const content = await this.io.read(recordPath);
        const current = parseRecord(content);
        if (!current || current.id !== cached.id) continue;
        if (JSON.stringify(applyIntent(current, intent)) !== JSON.stringify(current)) {
          await this.mutate(recordPath, current.id, intent, synchronize);
        }
      }
    });
  }

  reconcile(recordPath: string, synchronize: SynchronizeRecord): Promise<void> {
    return this.exclusive(async () => {
      if (!await this.io.exists(recordPath)) return;
      const content = await this.io.read(recordPath);
      const current = parseRecord(content);
      if (current && current.recordPath === recordPath) {
        await this.reconcileRecord(current, content, synchronize);
      }
    });
  }

  private async reconcileRecord(record: ImageRecord, content: string, synchronize: SynchronizeRecord): Promise<ImageRecord> {
    const pending = operationPath(record.id);
    if (await this.io.exists(pending)) return this.resumeOperation(pending, synchronize);
    const previous = parseRecordSnapshot(content)!;
    if (previous.description === record.description && previous.captionStatus === record.captionStatus) return record;
    return this.mutate(record.recordPath, record.id, {kind: 'reconcile'}, synchronize);
  }

  private async mutate(
    recordPath: string,
    id: string,
    intent: RecordIntent,
    synchronize?: SynchronizeRecord,
  ): Promise<ImageRecord> {
    if (intent.kind === 'description' && intent.description !== null) {
      intent = {...intent, description: normalizeDescription(intent.description)};
    }
    const receipt = operationPath(id);
    if (await this.io.exists(receipt)) {
      recordPath = (await this.resumeOperation(receipt, synchronize)).recordPath;
    }
    const baseline = parseRecord(await this.io.read(recordPath));
    if (!baseline || baseline.id !== id) {
      throw new Error('The image record changed or cannot be read. Newer saved content was not replaced.');
    }
    const operation: RecordOperation = {
      version: 1, recordPath, baseline, intent, synchronize: !!synchronize, notes: {},
    };
    await this.checkpoint(operation);
    return this.finishOperation(operation, synchronize);
  }

  private async resumeOperation(file: string, synchronize?: SynchronizeRecord): Promise<ImageRecord> {
    const operation = parseOperation(await this.io.read(file), file);
    await this.retargetOperation(operation);
    return this.finishOperation(operation, synchronize);
  }

  private async retargetOperation(operation: RecordOperation): Promise<void> {
    if (await this.io.exists(operation.recordPath)) return;
    operation.recordPath = await this.findMovedRecord(operation.baseline);
    await this.checkpoint(operation);
  }

  private async findMovedRecord(record: ImageRecord): Promise<string> {
    const matches: string[] = [];
    for (const file of await this.io.recordPaths()) {
      if (path.posix.basename(file) !== `${record.id}.md`) continue;
      const candidate = parseRecord(await this.io.read(file));
      if (candidate?.id === record.id && candidate.sha256 === record.sha256) matches.push(file);
    }
    if (matches.length !== 1) {
      throw new Error(matches.length
        ? 'Multiple matching image records make recovery ambiguous. The unfinished save was retained.'
        : 'The image record is missing. The unfinished save was retained.');
    }
    return matches[0];
  }

  private async checkpoint(operation: RecordOperation): Promise<void> {
    const file = operationPath(operation.baseline.id);
    const content = JSON.stringify(operation, null, 2);
    parseOperation(content, file);
    await this.io.mkdir(OPERATION_DIR);
    await this.io.write(file, content);
  }

  private async finishOperation(operation: RecordOperation, synchronize?: SynchronizeRecord): Promise<ImageRecord> {
    if (operation.synchronize && !synchronize) {
      throw new Error('This image has an unfinished save. Recover its note updates before making another change.');
    }
    const journal: ProjectionJournal = {
      notes: operation.notes,
      checkpoint: () => this.checkpoint(operation),
    };
    for (;;) {
      const content = await this.io.read(operation.recordPath);
      const current = parseRecord(content);
      if (!current || current.id !== operation.baseline.id || current.sha256 !== operation.baseline.sha256) {
        throw new Error('The image record changed or cannot be read. Newer saved content was not replaced.');
      }
      const snapshot = parseRecordSnapshot(content)!;
      // The snapshot proves a prior commit even if receipt cleanup never completed.
      if (operation.target && JSON.stringify(snapshot) === JSON.stringify(operation.target)) {
        operation.intent = {kind: 'reconcile'};
      } else if (operation.intent.kind === 'description'
        && (current.description !== operation.baseline.description
          || current.captionStatus !== operation.baseline.captionStatus)) {
        operation.intent = {...operation.intent, description: null};
      }
      const next = {...applyIntent(current, operation.intent), recordPath: operation.recordPath};
      if (next.id !== current.id) {
        throw new Error('The image record changed or cannot be read. Newer saved content was not replaced.');
      }
      operation.target = next;
      await this.checkpoint(operation);
      if (operation.synchronize && synchronize) {
        for (const sourcePath of next.sourceNotes) {
          await synchronize(snapshot, {...next, sourceNotes: [sourcePath]}, journal);
        }
      }
      if (await this.persist(next, content)) {
        await this.io.remove(operationPath(operation.baseline.id));
        return next;
      }
      // Keep durable occurrence plans while rebasing the intent on newer record fields.
    }
  }

  private async persist(record: ImageRecord, expectedContent?: string): Promise<boolean> {
    if (expectedContent === undefined && await this.io.exists(record.recordPath)) {
      throw new Error('Refusing to overwrite an existing image record. The capture remains staged for recovery.');
    }
    await this.io.mkdir(path.posix.dirname(record.recordPath));
    const content = serializeRecord(record);
    await this.io.write(record.sidecarPath, serializeSidecar(record));
    if (expectedContent === undefined) {
      await this.io.write(record.recordPath, content);
    } else {
      let saved = false;
      await this.io.process(record.recordPath, current => {
        if (current !== expectedContent) return current;
        saved = true;
        return content;
      });
      if (!saved) return false;
    }
    this.records.set(record.id, record);
    this.byHash.set(record.sha256, record);
    return true;
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
        if (item.version === 1
          && isImageId(item.id)
          && ['jpg', 'png'].includes(item.format)
          && item.transactionPath === `${STATE_DIR}/${item.id}.json`
          && item.dataPath === `${STATE_DIR}/${item.id}.${item.format}`
          && item.transactionPath === file
          && typeof item.sourcePath === 'string'
          && typeof item.importedAt === 'string'
          && Number.isFinite(Date.parse(item.importedAt))
          && typeof item.storageFolder === 'string'
          && /^(?:\d{4})?$/.test(item.storageFolder)
          && await this.io.exists(item.dataPath)) {
          captures.push(item);
        }
      } catch {
        /* A partial receipt is retained for manual inspection, never treated as a valid image. */
      }
    }
    return captures;
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.serial.then(operation, operation);
    this.serial = next.catch(() => {});
    return next;
  }
}
