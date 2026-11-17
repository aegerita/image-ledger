import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import { detectImageFormat, sha256 } from './media';
import { assertVaultPath, normalizeDescription } from './markdown';
import { isImageId, isManagedPath } from './ids';
import type { DescriptionCodec } from './description';
import type { ImageFormat, ManagedImage, MediaInput } from './model';
import type { StorageLayout } from '../settings';
import { operationPath, parseOperation, type DeletionNotes } from './operations';

export interface VaultIO {
  checkTrash(): void;
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  write(path: string, text: string): Promise<void>;
  readBinary(path: string): Promise<Uint8Array>;
  writeBinary(path: string, bytes: Uint8Array, mtime?: number): Promise<void>;
  replaceBinary(path: string, checksum: string, bytes: Uint8Array): Promise<void>;
  remove(path: string): Promise<void>;
  trash(path: string): Promise<void>;
  mediaPaths(): Promise<string[]>;
  pendingPaths(): Promise<string[]>;
  operationPaths(): Promise<string[]>;
}

export interface PendingCapture {
  version: 2;
  id: string;
  dataPath: string;
  transactionPath: string;
  sourcePath: string;
  storageFolder: string;
  format: ImageFormat;
  byteHash: string;
  lastModified?: number;
  imagePath?: string;
  savedChecksum?: string;
}

export interface PreparedCapture {
  pending: PendingCapture;
  record: ManagedImage;
  duplicate: boolean;
  preview?: Uint8Array;
}

export interface ImageAudit {
  images: number;
  pending: number;
  interrupted: number;
  issues: {path: string; reason: string}[];
}

const STATE_DIR = '.image-ledger/staging';
type RemoveEmbeds = (image: ManagedImage, notes: DeletionNotes) => Promise<void>;

export function storageFolder(sourcePath: string, importedAt: Date, layout: StorageLayout): string {
  if (layout === 'flat') return '';
  if (layout === 'import-year') return String(importedAt.getFullYear());
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(posix.basename(sourcePath, '.md'));
  if (match && Number(match[2]) >= 1 && Number(match[2]) <= 12
    && Number(match[3]) >= 1 && Number(match[3]) <= 31) return match[1];
  return /^(\d{4})\//.exec(sourcePath)?.[1] ?? String(importedAt.getFullYear());
}

export class MediaStore {
  private records = new Map<string, ManagedImage>();
  private issues: ImageAudit['issues'] = [];
  private serial: Promise<unknown> = Promise.resolve();

  constructor(
    private io: VaultIO,
    private settings: {storageLayout: StorageLayout},
    private codec: DescriptionCodec,
  ) {}

  allRecords(): ManagedImage[] {
    return [...this.records.values()];
  }

  refresh(): Promise<void> {
    return this.exclusive(() => this.refreshCatalog());
  }

  private async refreshCatalog(): Promise<void> {
    // shortcut: rescan images until a persistent caption cache can be invalidated safely.
    // https://linear.app/obsidian-image-backup-plugin/issue/OBS-61/avoid-rereading-every-image-when-refreshing-the-catalog
    const paths = new Set(await this.io.mediaPaths());
    for (const image of this.records.values()) paths.add(image.imagePath);
    const next = new Map<string, ManagedImage>();
    const issues: ImageAudit['issues'] = [];
    for (const imagePath of paths) {
      if (!isManagedPath(imagePath)) continue;
      try {
        if (!await this.io.exists(imagePath)) continue;
        const id = posix.parse(imagePath).name;
        const bytes = await this.io.readBinary(imagePath);
        const checksum = sha256(bytes);
        const cached = this.records.get(id);
        if (next.has(id)) throw new Error('Multiple image paths use the same normalized ID. Resolve the duplicate files.');
        const description = cached?.checksum === checksum
          ? cached.description : await this.codec.readDescription(bytes);
        next.set(id, {id, imagePath, description, checksum});
      } catch (error) {
        issues.push({path: imagePath, reason: String(error)});
      }
    }
    this.records = next;
    this.issues = issues;
  }

  async load(imagePath: string): Promise<ManagedImage> {
    assertVaultPath(imagePath);
    if (!isManagedPath(imagePath)) throw new Error('This is not a managed image path.');
    const bytes = await this.io.readBinary(imagePath);
    if (`.${detectImageFormat(bytes)}` !== posix.extname(imagePath)) throw new Error('The image format does not match its filename.');
    const image = await this.codec.inspect(bytes);
    if (image.id !== posix.parse(imagePath).name) {
      throw new Error('The image content no longer matches its normalized filename.');
    }
    return {...image, imagePath, checksum: sha256(bytes)};
  }

  async stage(input: MediaInput, sourcePath: string): Promise<PendingCapture> {
    assertVaultPath(sourcePath);
    const format = detectImageFormat(input.bytes);
    const id = randomUUID();
    const pending: PendingCapture = {
      version: 2, id, format, sourcePath,
      dataPath: `${STATE_DIR}/${id}.${format}`, transactionPath: `${STATE_DIR}/${id}.json`,
      storageFolder: storageFolder(sourcePath, new Date(), this.settings.storageLayout),
      byteHash: sha256(input.bytes),
      ...(input.lastModified !== undefined ? {lastModified: input.lastModified} : {}),
    };
    await this.io.write(pending.transactionPath, JSON.stringify(pending));
    await this.io.writeBinary(pending.dataPath, input.bytes);
    return pending;
  }

  async retarget(pending: PendingCapture, sourcePath: string): Promise<void> {
    assertVaultPath(sourcePath);
    pending.sourcePath = sourcePath;
    await this.io.write(pending.transactionPath, JSON.stringify(pending));
  }

  prepare(pending: PendingCapture): Promise<PreparedCapture> {
    return this.exclusive(async () => {
      const bytes = await this.stagedBytes(pending);
      const inspected = await this.codec.inspect(bytes);
      if (await this.io.exists(operationPath(inspected.id))) {
        throw new Error('This image has an unfinished deletion. Resolve it before importing the image again.');
      }
      if (pending.imagePath && posix.parse(pending.imagePath).name !== inspected.id) {
        throw new Error('The staged image destination does not match its normalized ID.');
      }
      const prefix = pending.storageFolder ? `${pending.storageFolder}/` : '';
      const destination = pending.imagePath ?? `${prefix}images/${inspected.id}.${pending.format}`;
      const candidates = new Set(await this.io.mediaPaths());
      const cached = this.records.get(inspected.id);
      if (cached) candidates.add(cached.imagePath);
      candidates.add(destination);
      const existing: string[] = [];
      for (const candidate of candidates) {
        if (isManagedPath(candidate) && posix.parse(candidate).name === inspected.id && await this.io.exists(candidate)) {
          existing.push(candidate);
        }
      }
      if (existing.length > 1) throw new Error('Multiple image paths use the same normalized ID. Resolve the duplicate files.');
      const imagePath = existing[0] ?? destination;
      pending.imagePath = imagePath;
      await this.io.write(pending.transactionPath, JSON.stringify(pending));
      if (await this.io.exists(imagePath)) {
        const record = await this.load(imagePath);
        if (record.id !== inspected.id) throw new Error('The existing image has a different identity.');
        return {pending, record, duplicate: true};
      }
      return {pending, record: {...inspected, imagePath}, duplicate: false, preview: bytes};
    });
  }

  describe(prepared: PreparedCapture, description: string | null): Promise<ManagedImage> {
    return this.exclusive(async () => {
      const {pending, record} = prepared;
      if (await this.io.exists(operationPath(record.id))) throw new Error('This image has an unfinished deletion.');
      let bytes = await this.stagedBytes(pending);
      const caption = description === null ? record.description : normalizeDescription(description);
      if (await this.io.exists(record.imagePath)) {
        const current = await this.load(record.imagePath);
        if (!prepared.duplicate) return this.checkpointCapture(pending, current);
        if (current.checksum !== record.checksum) throw new Error('The image changed while its description dialog was open.');
        if (description === null || caption === current.description) return this.checkpointCapture(pending, current);
        return this.checkpointCapture(pending, await this.saveDescription(current, caption));
      }
      if (prepared.duplicate) throw new Error('The existing image was removed during capture. Its staged input was retained.');
      if (caption !== record.description) bytes = await this.codec.describe(bytes, caption);
      await this.io.writeBinary(record.imagePath, bytes, pending.lastModified);
      const saved = {...record, description: caption, checksum: sha256(bytes)};
      return this.checkpointCapture(pending, saved);
    });
  }

  private async checkpointCapture(pending: PendingCapture, image: ManagedImage): Promise<ManagedImage> {
    this.records.set(image.id, image);
    pending.savedChecksum = image.checksum;
    await this.io.write(pending.transactionPath, JSON.stringify(pending));
    return image;
  }

  setDescription(image: ManagedImage, description: string): Promise<ManagedImage> {
    return this.exclusive(() => this.saveDescription(image, normalizeDescription(description)));
  }

  private async saveDescription(image: ManagedImage, description: string): Promise<ManagedImage> {
    if (!isManagedPath(image.imagePath) || posix.parse(image.imagePath).name !== image.id) {
      throw new Error('This is not a managed image path.');
    }
    if (await this.io.exists(operationPath(image.id))) throw new Error('This image has an unfinished deletion.');
    if (!image.checksum) throw new Error('Reload the image before editing its description.');
    const before = await this.io.readBinary(image.imagePath);
    if (sha256(before) !== image.checksum) throw new Error('The image changed. Open its description again.');
    if ((await this.codec.inspect(before)).id !== image.id) throw new Error('Image identity changed.');
    const bytes = await this.codec.describe(before, description);
    await this.io.replaceBinary(image.imagePath, image.checksum, bytes);
    const saved = {...image, description, checksum: sha256(bytes)};
    this.records.set(image.id, saved);
    return saved;
  }

  async complete(pending: PendingCapture): Promise<void> {
    await this.io.remove(pending.dataPath);
    await this.io.remove(pending.transactionPath);
  }

  async pendingCaptures(rejected?: (file: string, reason: string) => void): Promise<PendingCapture[]> {
    const captures: PendingCapture[] = [];
    for (const file of await this.io.pendingPaths()) {
      if (!file.endsWith('.json')) continue;
      try {
        const pending = JSON.parse(await this.io.read(file)) as PendingCapture;
        if (pending.version !== 2 || !/^[a-f0-9-]{36}$/.test(pending.id)
          || !['jpg', 'png'].includes(pending.format)
          || pending.transactionPath !== file || file !== `${STATE_DIR}/${pending.id}.json`
          || pending.dataPath !== `${STATE_DIR}/${pending.id}.${pending.format}`
          || !/^(?:\d{4})?$/.test(pending.storageFolder)
          || !isImageId(pending.byteHash)
          || (pending.lastModified !== undefined && !Number.isFinite(pending.lastModified))) throw new Error('Invalid capture receipt');
        assertVaultPath(pending.sourcePath);
        if (!pending.sourcePath.endsWith('.md')) throw new Error('Invalid source note');
        if (pending.imagePath !== undefined) {
          assertVaultPath(pending.imagePath);
          if (!isManagedPath(pending.imagePath) || posix.extname(pending.imagePath) !== `.${pending.format}`) {
            throw new Error('Invalid image destination');
          }
        }
        if (pending.savedChecksum !== undefined && !isImageId(pending.savedChecksum)) throw new Error('Invalid saved checksum');
        await this.stagedBytes(pending);
        captures.push(pending);
      } catch (error) {
        rejected?.(file, `${String(error)}. Capture files were retained.`);
      }
    }
    return captures;
  }

  private async stagedBytes(pending: PendingCapture): Promise<Uint8Array> {
    if (!await this.io.exists(pending.dataPath) && pending.imagePath && pending.savedChecksum) {
      const saved = await this.io.readBinary(pending.imagePath);
      if (sha256(saved) !== pending.savedChecksum) throw new Error('The saved capture changed during cleanup recovery.');
      return saved;
    }
    const bytes = await this.io.readBinary(pending.dataPath);
    if (sha256(bytes) !== pending.byteHash || detectImageFormat(bytes) !== pending.format) {
      throw new Error('Staged image verification failed. Keep its receipt and payload.');
    }
    return bytes;
  }

  rename(from: string, to: string): Promise<void> {
    return this.exclusive(async () => {
      assertVaultPath(to);
      for (const pending of await this.pendingCaptures()) {
        if (pending.sourcePath === from || pending.sourcePath.startsWith(from + '/')) {
          await this.retarget(pending, to + pending.sourcePath.slice(from.length));
        }
      }
      await this.refreshCatalog();
    });
  }

  deleteImage(image: ManagedImage, notes: DeletionNotes, remove: RemoveEmbeds): Promise<void> {
    return this.exclusive(async () => {
      this.io.checkTrash();
      if (!image.checksum) throw new Error('Reload the image before deleting it.');
      if (!await this.io.exists(image.imagePath) || sha256(await this.io.readBinary(image.imagePath)) !== image.checksum) {
        throw new Error('The image changed during deletion preview. Open a fresh preview.');
      }
      for (const pending of await this.pendingCaptures()) {
        const bytes = await this.stagedBytes(pending);
        if ((await this.codec.inspect(bytes)).id === image.id) {
          throw new Error('Finish or recover this image’s pending captures before deleting it.');
        }
      }
      const file = operationPath(image.id);
      if (await this.io.exists(file)) throw new Error('This image already has an unfinished deletion.');
      const snapshots = Object.fromEntries(Object.entries(notes).map(([source, {before, after}]) => [source, {before, after}]));
      const receipt = JSON.stringify({version: 2, image, notes: snapshots});
      parseOperation(receipt, file);
      await this.io.write(file, receipt);
      await this.resumeDeletion(file, remove);
    });
  }

  async recoverDeletions(remove: RemoveEmbeds): Promise<void> {
    await this.exclusive(async () => {
      const errors: string[] = [];
      for (const file of await this.io.operationPaths()) {
        try { await this.resumeDeletion(file, remove); }
        catch (error) { errors.push(String(error)); }
      }
      if (errors.length) throw new Error(errors.join('\n'));
    });
  }

  private async resumeDeletion(file: string, remove: RemoveEmbeds): Promise<void> {
    const operation = parseOperation(await this.io.read(file), file);
    const {image} = operation;
    const verify = async () => {
      if (await this.io.exists(image.imagePath)
        && sha256(await this.io.readBinary(image.imagePath)) !== image.checksum) {
        throw new Error('The image changed during deletion. Its files and receipt were retained.');
      }
    };
    this.io.checkTrash();
    await verify();
    await remove(image, operation.notes);
    await verify();
    if (await this.io.exists(image.imagePath)) await this.io.trash(image.imagePath);
    await this.io.remove(file);
    this.records.delete(image.id);
  }

  async audit(): Promise<ImageAudit> {
    await this.refresh();
    const issues = [...this.issues];
    const captures = await this.pendingCaptures((path, reason) => issues.push({path, reason}));
    for (const pending of captures) issues.push({path: pending.transactionPath, reason: 'Interrupted capture. Run Recover interrupted image captures.'});
    for (const path of await this.io.operationPaths()) issues.push({path, reason: 'Unfinished deletion. Keep this receipt for recovery.'});
    return {images: this.records.size, pending: this.allRecords().filter(image => !image.description).length, interrupted: captures.length, issues};
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.serial.then(operation, operation);
    this.serial = result.catch(() => {});
    return result;
  }
}
