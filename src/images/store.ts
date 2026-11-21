import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import { detectImageFormat, sha256 } from './media';
import { assertVaultPath, normalizeDescription } from './markdown';
import { isManagedPath, isSha256 } from './ids';
import { UnreadableImageError } from './identity';
import type { DescriptionCodec } from './description';
import type { ImageFormat, ManagedImage, MediaInput } from './model';
import type { StorageLayout } from '../settings';
import { operationImageId, operationPath, parseOperation, type DeletionNotes } from './operations';

export interface VaultIO {
  checkTrash(): void;
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<string | undefined>;
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
  version: 2 | 3;
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
  identity: string;
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
export const CATALOG_CACHE_PATH = '.image-ledger/catalog-cache.json';
const CATALOG_CACHE_VERSION = 1;
type CaptionEntry = {stamp: string; checksum: string; description: string; identity?: string | null};
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
  private identities = new Map<string, string[]>();
  private captions?: Map<string, CaptionEntry>;
  private cacheDirty = false;
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
    return this.exclusive(async () => {
      await this.refreshCatalog();
    });
  }

  private async readCaptionCache(): Promise<Map<string, CaptionEntry>> {
    try {
      if (await this.io.stat(CATALOG_CACHE_PATH) === undefined) return new Map();
      const {version, entries} = JSON.parse(await this.io.read(CATALOG_CACHE_PATH));
      if (version === CATALOG_CACHE_VERSION && entries && typeof entries === 'object' && !Array.isArray(entries)) {
        const captions = new Map<string, CaptionEntry>();
        for (const [path, value] of Object.entries(entries)) {
          const entry = value as Partial<CaptionEntry> | null;
          if (isManagedPath(path) && typeof entry?.stamp === 'string'
            && isSha256(entry.checksum) && typeof entry.description === 'string') {
            const identity = entry.identity === null || isSha256(entry.identity) ? entry.identity : undefined;
            captions.set(path, {stamp: entry.stamp, checksum: entry.checksum, description: entry.description, identity});
          }
        }
        return captions;
      }
    } catch {
      // A missing or unreadable cache can always be rebuilt from the images.
    }
    return new Map();
  }

  private async refreshCatalog(verify = false, paths?: Set<string>): Promise<ImageAudit['issues']> {
    const captions = this.captions ??= await this.readCaptionCache();
    paths ??= new Set(await this.io.mediaPaths());
    for (const image of this.records.values()) paths.add(image.imagePath);
    const next = new Map<string, ManagedImage>();
    const nextCaptions = new Map<string, CaptionEntry>();
    const nextIdentities = new Map<string, string[]>();
    const issues: ImageAudit['issues'] = [];
    for (const imagePath of paths) {
      if (!isManagedPath(imagePath)) continue;
      try {
        const stamp = await this.io.stat(imagePath);
        if (stamp === undefined) continue;
        const cached = captions.get(imagePath);
        let entry = cached;
        let identity = cached?.identity;
        if (verify || cached?.stamp !== stamp || identity === undefined) {
          const bytes = await this.io.readBinary(imagePath);
          const checksum = sha256(bytes);
          identity = await this.codec.identity(bytes).catch(() => null);
          let captionError: unknown;
          entry = undefined;
          try {
            const description = cached?.checksum === checksum ? cached.description : await this.codec.readDescription(bytes);
            entry = {stamp, checksum, description, identity};
          } catch (error) {
            captionError = error;
          }
          if (await this.io.stat(imagePath) !== stamp) throw new Error('The image changed while its description was being read.');
          if (!entry) {
            issues.push({path: imagePath, reason: String(captionError)});
          } else if (cached?.stamp !== stamp || cached.checksum !== checksum || cached.identity !== identity) {
            this.cacheDirty = true;
          }
        }
        if (identity) {
          const matches = nextIdentities.get(identity);
          if (matches) matches.push(imagePath);
          else nextIdentities.set(identity, [imagePath]);
        }
        if (!entry) continue;
        nextCaptions.set(imagePath, entry);
        const id = posix.parse(imagePath).name;
        if (next.has(id)) throw new Error('Multiple image paths use the same normalized ID. Resolve the duplicate files.');
        next.set(id, {id, imagePath, description: entry.description});
      } catch (error) {
        issues.push({path: imagePath, reason: String(error)});
      }
    }
    this.records = next;
    this.captions = nextCaptions;
    this.identities = nextIdentities;
    if (this.cacheDirty || nextCaptions.size !== captions.size) {
      try {
        await this.io.write(CATALOG_CACHE_PATH, JSON.stringify({
          version: CATALOG_CACHE_VERSION,
          entries: Object.fromEntries(nextCaptions),
        }));
        this.cacheDirty = false;
      } catch {
        this.cacheDirty = true;
      }
    }
    return issues;
  }

  async load(imagePath: string, expectedIdentity?: string): Promise<ManagedImage> {
    assertVaultPath(imagePath);
    if (!isManagedPath(imagePath)) throw new Error('This is not a managed image path.');
    const bytes = await this.io.readBinary(imagePath);
    if (`.${detectImageFormat(bytes)}` !== posix.extname(imagePath)) throw new Error('The image format does not match its filename.');
    const id = posix.parse(imagePath).name;
    let description: string;
    if (expectedIdentity) {
      const inspected = await this.codec.inspect(bytes).catch(error => {
        if (error instanceof UnreadableImageError) {
          throw new Error(`Can’t read the existing image’s embedded metadata. Check ${imagePath}.`, {cause: error});
        }
        throw error;
      });
      if (inspected.id !== expectedIdentity) throw new Error('The existing image has a different identity.');
      description = inspected.description;
    } else {
      description = await this.codec.readDescription(bytes);
    }
    return {id, imagePath, description, checksum: sha256(bytes)};
  }

  async stage(input: MediaInput, sourcePath: string): Promise<PendingCapture> {
    assertVaultPath(sourcePath);
    const format = detectImageFormat(input.bytes);
    const id = randomUUID();
    const pending: PendingCapture = {
      version: 3, id, format, sourcePath,
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
      const {id: identity, description} = await this.codec.inspect(bytes);
      await this.checkUnfinishedDeletion(identity);
      const pinned = pending.imagePath;
      const pinnedId = pinned ? posix.parse(pinned).name : undefined;
      const legacyDestination = pinnedId !== identity;
      const destinationError = 'The staged image destination does not match its normalized ID.';
      if (pinned && (!isManagedPath(pinned) || posix.extname(pinned) !== `.${pending.format}`)) {
        throw new Error(destinationError);
      }
      const prefix = pending.storageFolder ? `${pending.storageFolder}/` : '';
      const destination = pinned && !legacyDestination ? pinned : `${prefix}images/${identity}.${pending.format}`;
      const candidates = new Set(await this.io.mediaPaths());
      const cached = this.records.get(identity);
      if (cached) candidates.add(cached.imagePath);
      candidates.add(destination);
      if (pinned) candidates.add(pinned);
      await this.refreshCatalog(false, candidates);
      const existing: string[] = [];
      for (const candidate of candidates) {
        if (!isManagedPath(candidate)) continue;
        const {name, ext} = posix.parse(candidate);
        if (name === identity && await this.io.exists(candidate)) {
          existing.push(candidate);
        } else if (ext === `.${pending.format}` && this.identities.get(identity)?.includes(candidate)) {
          existing.push(candidate);
        }
      }
      if (pinned && legacyDestination && !existing.includes(pinned)) {
        const exists = await this.io.exists(pinned);
        if (pending.savedChecksum && !exists) {
          throw new Error('Restore the missing legacy image to its original path before recovering this saved capture.');
        }
        if (pending.version !== 2 || exists) throw new Error(destinationError);
      }
      if (existing.length > 1) throw new Error('Multiple image paths use the same normalized ID. Resolve the duplicate files.');
      const imagePath = existing[0] ?? destination;
      let match: ManagedImage | undefined;
      if (existing.length) {
        const entry = this.captions?.get(imagePath);
        if (entry?.identity === identity && posix.extname(imagePath) === `.${pending.format}`) {
          match = {id: posix.parse(imagePath).name, imagePath, description: entry.description, checksum: entry.checksum};
        } else {
          match = await this.load(imagePath, identity);
        }
      }
      pending.imagePath = imagePath;
      await this.io.write(pending.transactionPath, JSON.stringify(pending));
      if (match) return {pending, record: match, identity, duplicate: true};
      return {pending, record: {id: identity, description, imagePath}, identity, duplicate: false, preview: bytes};
    });
  }

  private async checkUnfinishedDeletion(identity: string): Promise<void> {
    const interrupted = 'This image has an unfinished deletion. Resolve it before importing the image again.';
    if (await this.io.exists(operationPath(identity))) throw new Error(interrupted);
    for (const file of await this.io.operationPaths()) {
      if (!isSha256(operationImageId(file))) continue;
      const {image} = parseOperation(await this.io.read(file), file);
      const bytes = await this.io.exists(image.imagePath) ? await this.io.readBinary(image.imagePath) : undefined;
      if (!bytes || sha256(bytes) !== image.checksum) {
        throw new Error('Resolve the unfinished deletion of a missing or changed legacy image before importing.');
      }
      const legacyIdentity = await this.codec.identity(bytes).catch(error => {
        if (error instanceof UnreadableImageError) {
          throw new Error('Resolve the unfinished deletion of an unreadable legacy image before importing.', {cause: error});
        }
        throw error;
      });
      if (legacyIdentity === identity) throw new Error(interrupted);
    }
  }

  describe(prepared: PreparedCapture, description: string | null): Promise<ManagedImage> {
    return this.exclusive(async () => {
      const {pending, record, identity} = prepared;
      await this.checkUnfinishedDeletion(identity);
      let bytes = await this.stagedBytes(pending);
      const caption = description === null ? record.description : normalizeDescription(description);
      if (await this.io.exists(record.imagePath)) {
        const current = await this.load(record.imagePath, identity);
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
    if (`.${detectImageFormat(before)}` !== posix.extname(image.imagePath)) {
      throw new Error('Image identity changed.');
    }
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
        if ((pending.version !== 2 && pending.version !== 3) || !/^[a-f0-9-]{36}$/.test(pending.id)
          || !['jpg', 'png'].includes(pending.format)
          || pending.transactionPath !== file || file !== `${STATE_DIR}/${pending.id}.json`
          || pending.dataPath !== `${STATE_DIR}/${pending.id}.${pending.format}`
          || !/^(?:\d{4})?$/.test(pending.storageFolder)
          || !isSha256(pending.byteHash)
          || (pending.lastModified !== undefined && !Number.isFinite(pending.lastModified))) throw new Error('Invalid capture receipt');
        assertVaultPath(pending.sourcePath);
        if (!pending.sourcePath.endsWith('.md')) throw new Error('Invalid source note');
        if (pending.imagePath !== undefined) {
          assertVaultPath(pending.imagePath);
          if (!isManagedPath(pending.imagePath) || posix.extname(pending.imagePath) !== `.${pending.format}`) {
            throw new Error('Invalid image destination');
          }
        }
        if (pending.savedChecksum !== undefined && !isSha256(pending.savedChecksum)) throw new Error('Invalid saved checksum');
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
      const bytes = await this.io.exists(image.imagePath) ? await this.io.readBinary(image.imagePath) : undefined;
      if (!bytes || sha256(bytes) !== image.checksum) {
        throw new Error('The image changed during deletion preview. Open a fresh preview.');
      }
      const captures = await this.pendingCaptures();
      const identity = captures.length ? await this.codec.identity(bytes).catch(() => undefined) : undefined;
      for (const pending of captures) {
        if (pending.imagePath === image.imagePath || pending.byteHash === image.checksum
          || (identity && await this.codec.identity(await this.stagedBytes(pending)).catch(() => undefined) === identity)) {
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

  audit(): Promise<ImageAudit> {
    return this.exclusive(async () => {
      const issues = await this.refreshCatalog(true);
      const captures = await this.pendingCaptures((path, reason) => issues.push({path, reason}));
      for (const pending of captures) issues.push({path: pending.transactionPath, reason: 'Interrupted capture. Run Recover interrupted image captures.'});
      for (const path of await this.io.operationPaths()) issues.push({path, reason: 'Unfinished deletion. Keep this receipt for recovery.'});
      return {images: this.records.size, pending: this.allRecords().filter(image => !image.description).length, interrupted: captures.length, issues};
    });
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.serial.then(operation, operation);
    this.serial = result.catch(() => {});
    return result;
  }
}
