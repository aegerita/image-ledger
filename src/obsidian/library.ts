import { Notice, type App } from 'obsidian';
import type { ImageRecord } from '../images/model';
import { findManagedImage, managedImageEmbeds } from '../images/embeds';
import { MediaStore, type PendingCapture, type PreparedCapture } from '../images/store';
import type { ProjectionJournal } from '../images/operations';
import { NoteImages } from './notes';
import { RecordPicker } from './ui';

export class RecordLibrary {
  private initialized?: Promise<void>;
  private recordTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private synchronize = (previous: ImageRecord, next: ImageRecord, journal: ProjectionJournal) => this.notes.updateEmbeds(previous, next, journal);

  constructor(
    private app: App,
    readonly store: MediaStore,
    private notes: NoteImages,
    private report: (error: unknown) => void,
  ) {}

  ready(): Promise<void> {
    return this.initialized ??= this.store.initialize(this.synchronize).catch(error => {
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
      void this.store.reconcile(file.path, this.synchronize).catch(this.report);
    }, 500));
  }

  reconcileAll(): Promise<void> {
    return this.store.refresh(this.synchronize);
  }

  prepare(pending: PendingCapture): Promise<PreparedCapture> {
    return this.store.prepare(pending, this.synchronize);
  }

  rename(file: {path: string}, previousPath: string): Promise<void> {
    return this.store.rename(previousPath, file.path, this.synchronize);
  }

  async editDescription(describe: (record: ImageRecord) => Promise<string | null>): Promise<void> {
    await this.selectRecord(async record => {
      const description = await describe(record);
      if (description === null) return;
      await this.store.setDescription(record, description, this.synchronize);
      new Notice('Image description updated.');
    });
  }

  async audit(): Promise<void> {
    try {
      await this.ready();
      await this.store.refresh(this.synchronize);
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
      const active = this.app.workspace.getActiveFile();
      const info = this.app.workspace.activeEditor;
      const editor = info?.file === active ? info?.editor : undefined;
      const text = editor?.getValue();
      const selection = editor ? {
        from: editor.posToOffset(editor.getCursor('from')),
        to: editor.posToOffset(editor.getCursor('to')),
      } : undefined;
      await this.ready();
      await this.store.refresh(this.synchronize);
      const records = this.store.allRecords();
      if (active) {
        const record = records.find(record => record.recordPath === active.path || record.imagePath === active.path);
        if (record) return await action(record);
      }
      if (!records.length) {
        new Notice('No images yet. Paste a JPEG or PNG into a note.');
        return;
      }
      let choices = records;
      if (active?.extension === 'md') {
        const content = text ?? await this.app.vault.read(active);
        const selected = selection && findManagedImage(content, active.path, records, selection);
        if (selected) return await action(selected.record);
        const inNote = [...new Set(managedImageEmbeds(content, active.path, records).map(embed => embed.record))];
        if (inNote.length) choices = inNote;
      }
      new RecordPicker(this.app, choices, record => void action(record).catch(this.report)).open();
    } catch (error) {
      this.report(error);
    }
  }
}
