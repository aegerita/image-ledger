import { Notice, TFile, type App } from 'obsidian';
import type { ImageRecord } from '../images/model';
import { parseRecord, parseRecordSnapshot } from '../images/records';
import { MediaStore, type PendingCapture, type PreparedCapture } from '../images/store';
import { NoteImages } from './notes';
import { RecordPicker } from './ui';

export class RecordLibrary {
  private initialized?: Promise<void>;
  private recordTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private app: App,
    readonly store: MediaStore,
    private notes: NoteImages,
    private report: (error: unknown) => void,
  ) {}

  ready(): Promise<void> {
    return this.initialized ??= this.store.initialize().catch(error => {
      this.initialized = undefined;
      throw error;
    });
  }

  dispose(): void {
    for (const timer of this.recordTimers.values()) clearTimeout(timer);
  }

  async openRecord(record: ImageRecord): Promise<void> {
    await this.app.workspace.openLinkText(record.recordPath, '', true);
  }

  onModify(file: {path: string}): void {
    const recordPath = file.path;
    if (!/(?:^|\/)image-records\/[^/]+\.md$/.test(recordPath)) return;
    const existing = this.recordTimers.get(recordPath);
    if (existing) clearTimeout(existing);
    this.recordTimers.set(recordPath, setTimeout(() => {
      this.recordTimers.delete(recordPath);
      void this.reconcileRecord(file.path).catch(this.report);
    }, 500));
  }

  async reconcileAll(): Promise<void> {
    await this.store.refresh((record, content) => this.reconcile(record, content));
  }

  prepare(pending: PendingCapture): Promise<PreparedCapture> {
    return this.store.prepare(pending, (record, content) => this.reconcile(record, content));
  }

  async rename(file: {path: string}, previousPath: string): Promise<void> {
    const rewrite = (value: string) => {
      if (value === previousPath) return file.path;
      if (value.startsWith(previousPath + '/')) return file.path + value.slice(previousPath.length);
      return value;
    };
    for (const record of this.store.allRecords()) {
      const next = {
        ...record,
        imagePath: rewrite(record.imagePath),
        recordPath: rewrite(record.recordPath),
        sidecarPath: rewrite(record.sidecarPath),
        sourceNotes: record.sourceNotes.map(rewrite),
      };
      if (JSON.stringify(next) !== JSON.stringify(record)) await this.store.persist(next);
    }
  }

  async editDescription(describe: (record: ImageRecord) => Promise<string | null>): Promise<void> {
    await this.selectRecord(async record => {
      const description = await describe(record);
      if (description === null) return;
      await this.reconcileAll();
      const current = this.store.allRecords().find(item => item.id === record.id);
      if (!current) throw new Error('The image record was removed or cannot be read. Its description was not changed.');
      const next: ImageRecord = {...current, description, captionStatus: 'confirmed'};
      await this.updateDescription(current, next);
      new Notice('Image description updated.');
    });
  }

  async audit(): Promise<void> {
    try {
      await this.ready();
      await this.store.refresh();
      const records = this.store.allRecords();
      let missing = 0;
      for (const record of records) {
        if (!await this.app.vault.adapter.exists(record.imagePath)) missing++;
      }
      const pending = records.filter(record => record.captionStatus === 'pending').length;
      const interrupted = (await this.store.pendingCaptures()).length;
      new Notice(`${records.length} image records · ${pending} descriptions pending · ${missing} missing files · ${interrupted} interrupted captures`, 12000);
    } catch (error) {
      this.report(error);
    }
  }

  private async selectRecord(action: (record: ImageRecord) => Promise<void>): Promise<void> {
    try {
      await this.ready();
      await this.store.refresh();
      const active = this.app.workspace.getActiveFile();
      if (active) {
        const record = this.store.allRecords().find(record => record.recordPath === active.path || record.imagePath === active.path);
        if (record) return await action(record);
      }
      const records = this.store.allRecords();
      if (!records.length) {
        new Notice('No images yet. Paste a JPEG or PNG into a note.');
        return;
      }
      new RecordPicker(this.app, records, record => void action(record).catch(this.report)).open();
    } catch (error) {
      this.report(error);
    }
  }

  private async updateDescription(previous: ImageRecord, next: ImageRecord): Promise<void> {
    await this.notes.updateEmbeds(previous, next);
    await this.store.persist(next);
  }

  private async reconcileRecord(recordPath: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(recordPath);
    if (!(file instanceof TFile)) return;
    const content = await this.app.vault.read(file);
    const next = parseRecord(content);
    if (!next) return;
    await this.reconcile(next, content);
  }

  private async reconcile(next: ImageRecord, content: string): Promise<void> {
    const previous = parseRecordSnapshot(content) ?? this.store.allRecords().find(record => record.id === next.id);
    if (previous && (previous.description !== next.description || previous.captionStatus !== next.captionStatus)) {
      await this.updateDescription(previous, next);
    }
  }
}
