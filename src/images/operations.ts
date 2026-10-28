import type { ImageRecord } from './model';
import { assertVaultPath, isImageRecord } from './records';

export interface EmbedRange {
  from: number;
  to: number;
}

export interface NoteProjection {
  before: string;
  after: string;
  beforeRanges: EmbedRange[];
  ranges: EmbedRange[];
}

export interface ProjectionJournal {
  notes: Record<string, NoteProjection>;
  checkpoint(): Promise<void>;
}

export type RecordIntent =
  | {kind: 'description'; description: string | null; source?: {from: string; to: string}}
  | {kind: 'rename'; from: string; to: string}
  | {kind: 'reconcile'};

export interface RecordOperation {
  version: 1;
  recordPath: string;
  baseline: ImageRecord;
  target?: ImageRecord;
  intent: RecordIntent;
  synchronize: boolean;
  notes: Record<string, NoteProjection>;
}

export const OPERATION_DIR = '.image-ledger/operations';

export function operationPath(id: string): string {
  return `${OPERATION_DIR}/${id}.json`;
}

/** Receipts are writable vault data: refuse malformed plans without discarding them. */
export function parseOperation(text: string, file: string): RecordOperation {
  try {
    const operation = JSON.parse(text) as RecordOperation;
    if (operation.version !== 1 || !isImageRecord(operation.baseline)
      || file !== operationPath(operation.baseline.id)
      || typeof operation.synchronize !== 'boolean') throw new Error();
    assertVaultPath(operation.recordPath);
    if (!operation.recordPath.endsWith(`/image-records/${operation.baseline.id}.md`)
      && operation.recordPath !== `image-records/${operation.baseline.id}.md`) throw new Error();
    // A moved receipt still needs the historical target to recognize an earlier commit.
    if (operation.target !== undefined && (!isImageRecord(operation.target)
      || operation.target.id !== operation.baseline.id
      || operation.target.sha256 !== operation.baseline.sha256)) throw new Error();
    const intent = operation.intent;
    if (intent.kind === 'description') {
      if (intent.description !== null && (typeof intent.description !== 'string' || !intent.description.trim())) throw new Error();
      if (intent.source) {
        assertVaultPath(intent.source.from);
        assertVaultPath(intent.source.to);
        if (!intent.source.from.endsWith('.md') || !intent.source.to.endsWith('.md')) throw new Error();
      }
    } else if (intent.kind === 'rename') {
      assertVaultPath(intent.from);
      assertVaultPath(intent.to);
    } else if (intent.kind !== 'reconcile') throw new Error();
    if (!operation.notes || typeof operation.notes !== 'object' || Array.isArray(operation.notes)) throw new Error();
    if (!operation.synchronize && Object.keys(operation.notes).length) throw new Error();
    for (const [source, plan] of Object.entries(operation.notes)) {
      assertVaultPath(source);
      if (!source.endsWith('.md') || !validProjection(plan)) throw new Error();
    }
    return operation;
  } catch {
    throw new Error(`Invalid image save recovery receipt: ${file}. It was retained for inspection.`);
  }
}

function validRanges(ranges: EmbedRange[], content: string): boolean {
  if (!Array.isArray(ranges)) return false;
  let end = 0;
  for (const range of ranges) {
    if (!range || !Number.isSafeInteger(range.from) || !Number.isSafeInteger(range.to)
      || range.from < end || range.to <= range.from || range.to > content.length) return false;
    end = range.to;
  }
  return true;
}

function validProjection(plan: NoteProjection): boolean {
  if (!plan || typeof plan.before !== 'string' || typeof plan.after !== 'string'
    || !validRanges(plan.beforeRanges, plan.before) || !validRanges(plan.ranges, plan.after)
    || plan.beforeRanges.length !== plan.ranges.length) return false;
  let beforeEnd = 0;
  let afterEnd = 0;
  for (let index = 0; index < plan.ranges.length; index++) {
    const before = plan.beforeRanges[index];
    const after = plan.ranges[index];
    if (plan.before.slice(beforeEnd, before.from) !== plan.after.slice(afterEnd, after.from)) return false;
    for (const embed of [plan.before.slice(before.from, before.to), plan.after.slice(after.from, after.to)]) {
      if (!/^!\[[^\n]*\]\([^\n]+\)$/.test(embed)) return false;
    }
    beforeEnd = before.to;
    afterEnd = after.to;
  }
  return plan.before.slice(beforeEnd) === plan.after.slice(afterEnd);
}
