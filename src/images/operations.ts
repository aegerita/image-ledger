import type { ManagedImage } from './model';
import { assertVaultPath } from './markdown';
import { deletionProjection } from './embeds';
import { posix } from 'node:path';
import { isManagedPath, isSha256 } from './ids';

export interface EmbedRange {
  from: number;
  to: number;
}

export interface NoteProjection {
  before: string;
  after: string;
  beforeRanges: EmbedRange[];
}

export type DeletionNotes = Record<string, NoteProjection>;

export interface DeletionOperation {
  version: 2;
  image: ManagedImage;
  notes: DeletionNotes;
}

export function operationPath(id: string): string {
  return `.image-ledger/operations/${id}.json`;
}

export function operationImageId(file: string): string | undefined {
  const id = posix.basename(file, '.json');
  if (isSha256(id) && operationPath(id) === file) return id;
}

/** Recompute approved edits before trusting a writable recovery receipt. */
export function parseOperation(text: string, file: string): DeletionOperation {
  try {
    const operation = JSON.parse(text) as DeletionOperation;
    const image = operation.image;
    if (operation.version !== 2 || !image || !isManagedPath(image.imagePath)
      || image.id !== posix.parse(image.imagePath).name
      || !isSha256(image.checksum)
      || typeof image.description !== 'string'
      || file !== operationPath(image.id)) throw new Error();
    assertVaultPath(image.imagePath);
    if (!operation.notes || typeof operation.notes !== 'object' || Array.isArray(operation.notes)) throw new Error();
    const notes: DeletionNotes = Object.create(null);
    for (const [source, plan] of Object.entries(operation.notes)) {
      assertVaultPath(source);
      if (!source.endsWith('.md') || !plan || typeof plan.before !== 'string') throw new Error();
      const expected = deletionProjection(plan.before, source, image);
      if (plan.after !== expected.after) throw new Error();
      notes[source] = expected;
    }
    return {...operation, notes};
  } catch {
    throw new Error(`Invalid image deletion receipt: ${file}. Keep it for inspection.`);
  }
}
