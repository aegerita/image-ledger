import type { ManagedImage } from './images/model';
import { MediaStore, type PendingCapture } from './images/store';
import type { CaptureTarget, NoteImages } from './obsidian/notes';

export type CaptureMethod = 'clipboard' | 'drop' | 'file';

interface CaptureUI {
  describe(image: ManagedImage, preview?: Uint8Array): Promise<string | null>;
  notify(message: string): void;
  report(error: unknown): void;
}

export class CaptureWorkflow {
  private processing: Promise<void> = Promise.resolve();

  constructor(
    private store: MediaStore,
    private notes: Pick<NoteImages, 'recover' | 'sourceNote' | 'syncDescription'>,
    private ui: CaptureUI,
  ) {}

  capture(files: File[], target: CaptureTarget, method: CaptureMethod): void {
    const staged = Promise.allSettled(files.map(async file => this.store.stage({
      bytes: new Uint8Array(await file.arrayBuffer()),
      lastModified: method === 'clipboard' ? undefined : file.lastModified,
    }, target.path)));
    void this.enqueue(async () => {
      const images = new Map<string, ManagedImage>();
      const completed: PendingCapture[] = [];
      for (const result of await staged) {
        if (result.status === 'rejected') {
          this.ui.report(result.reason);
          continue;
        }
        try {
          if (result.value.sourcePath !== target.path) await this.store.retarget(result.value, target.path);
          const image = await this.describeCapture(result.value);
          images.set(image.id, image);
          completed.push(result.value);
        } catch (error) {
          this.ui.report(error);
        }
      }
      if (images.size) {
        await target.insert([...images.values()]);
        for (const pending of completed) await this.store.complete(pending);
      }
    }, () => target.release());
  }

  recover(): void {
    void this.enqueue(async () => {
      const pending = await this.store.pendingCaptures();
      let recovered = 0;
      for (const capture of pending) {
        try {
          if (!this.notes.sourceNote(capture.sourcePath)) throw new Error('Restore the original note before recovering its image.');
          const image = await this.describeCapture(capture);
          await this.notes.recover(image, capture.sourcePath);
          await this.store.complete(capture);
          recovered++;
        } catch (error) {
          this.ui.report(error);
        }
      }
      this.ui.notify(`Recovered ${recovered} of ${pending.length} interrupted image captures.`);
    });
  }

  enqueue(operation: () => Promise<void>, cleanup?: () => void): Promise<void> {
    this.processing = this.processing.then(operation, operation).catch(error => this.ui.report(error)).finally(cleanup);
    return this.processing;
  }

  private async describeCapture(pending: PendingCapture): Promise<ManagedImage> {
    const prepared = await this.store.prepare(pending);
    const description = prepared.duplicate && prepared.record.description
      ? null : await this.ui.describe(prepared.record, prepared.preview);
    const image = await this.store.describe(prepared, description);
    if (prepared.duplicate && image.description !== prepared.record.description) {
      try {
        const {skipped, conflicts} = await this.notes.syncDescription(prepared.record, image);
        if (skipped || conflicts.length) {
          this.ui.notify(`Description saved. Skipped ${skipped} embed label(s) and ${conflicts.length} note(s) that could not be updated.`);
        }
      } catch (error) {
        this.ui.report(error);
      }
    }
    return image;
  }
}
