import type { ImageRecord, MediaInput } from './images/model';
import { MediaStore, type PendingCapture } from './images/store';
import type { RecordLibrary } from './obsidian/library';
import type { CaptureTarget, NoteImages } from './obsidian/notes';

interface CaptureUI {
  describe(record: ImageRecord): Promise<string | null>;
  notify(message: string): void;
  report(error: unknown): void;
}

export class CaptureWorkflow {
  private processing: Promise<unknown> = Promise.resolve();

  constructor(
    private store: MediaStore,
    private library: Pick<RecordLibrary, 'ready' | 'prepare' | 'openRecord'>,
    private notes: Pick<NoteImages, 'updateEmbeds' | 'recover' | 'sourceNote'>,
    private ui: CaptureUI,
  ) {}

  capture(files: File[], target: CaptureTarget, method: MediaInput['method']): void {
    // Stage every received image immediately. Caption dialogs run in sequence afterward.
    const staged = Promise.allSettled(files.map(async file => this.store.stage({
      bytes: new Uint8Array(await file.arrayBuffer()),
      name: file.name || undefined,
      lastModified: method === 'clipboard' ? undefined : file.lastModified,
      method,
    }, target.path)));

    this.enqueue(() => this.finishBatch(staged, target), () => target.release());
  }

  recover(): void {
    this.enqueue(async () => {
      await this.library.ready();
      const captures = await this.store.pendingCaptures();
      if (!captures.length) {
        this.ui.notify('No interrupted captures to recover.');
        return;
      }

      for (const pending of captures) {
        const source = this.notes.sourceNote(pending.sourcePath);
        const prepared = await this.library.prepare(pending);
        const description = await this.ui.describe(prepared.record);
        const record = await this.store.describe(prepared, description, source?.path ?? pending.sourcePath,
          (previous, next, journal) => this.notes.updateEmbeds(previous, next, journal));
        await this.notes.recover(record, pending.sourcePath);
        await this.store.complete(pending);
        await this.library.openRecord(record);
      }
      this.ui.notify('Interrupted images recovered.');
    });
  }

  // Renames share this queue so record paths cannot change halfway through a capture.
  enqueue(operation: () => Promise<void>, cleanup?: () => void): void {
    this.processing = this.processing.then(operation, operation).catch(error => {
      cleanup?.();
      this.ui.report(error);
    });
  }

  private async finishBatch(staged: Promise<PromiseSettledResult<PendingCapture>[]>, target: CaptureTarget): Promise<void> {
    await this.library.ready();
    const records: ImageRecord[] = [];
    const completed: PendingCapture[] = [];

    for (const outcome of await staged) {
      if (outcome.status === 'rejected') {
        this.ui.report(outcome.reason);
        continue;
      }
      try {
        records.push(await this.describeCapture(outcome.value, target));
        completed.push(outcome.value);
      } catch (error) {
        this.ui.report(error);
      }
    }

    if (records.length) {
      await target.insert(latestBatchRecords(records, this.store.allRecords()));
      for (const pending of completed) await this.store.complete(pending);
    }
    target.release();
  }

  private async describeCapture(pending: PendingCapture, target: CaptureTarget): Promise<ImageRecord> {
    if (pending.sourcePath !== target.path) await this.store.retarget(pending, target.path);
    const prepared = await this.library.prepare(pending);
    const description = await this.ui.describe(prepared.record);
    return this.store.describe(prepared, description, target.path,
      (previous, next, journal) => this.notes.updateEmbeds(previous, next, journal));
  }
}

/** Repeated images in a batch share the final description and retain their first position. */
export function latestBatchRecords(records: ImageRecord[], latest: ImageRecord[]): ImageRecord[] {
  const current = new Map(latest.map(record => [record.id, record]));
  const seen = new Set<string>();
  return records.flatMap(record => {
    if (seen.has(record.id)) return [];
    seen.add(record.id);
    return [current.get(record.id) ?? record];
  });
}
