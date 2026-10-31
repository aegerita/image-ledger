import { Notice, TFile, type App, type Editor, type MarkdownFileInfo, type MarkdownView, type Menu, type TAbstractFile } from 'obsidian';
import type { ImageRecord } from '../images/model';
import { findManagedImage, managedImageEmbeds } from '../images/embeds';
import { MediaStore, type PendingCapture, type PreparedCapture, type SynchronizeRecord } from '../images/store';
import type { ProjectionJournal } from '../images/operations';
import { NoteImages, type SkippedEmbed } from './notes';
import { DescriptionSaveReview, RecordPicker } from './ui';

export class RecordLibrary {
  private initialized?: Promise<void>;
  private recordTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private synchronize = this.synchronizer();

  private synchronizer(overwrite?: SkippedEmbed): SynchronizeRecord {
    return Object.assign(
      (previous: ImageRecord, next: ImageRecord, journal: ProjectionJournal) => this.notes.updateEmbeds(previous, next, journal, overwrite),
      {
        references: (record: ImageRecord) => this.notes.references(record).paths,
        saved: (record: ImageRecord, journal: ProjectionJournal) => {
          const report = this.notes.saveReport(journal, record);
          const summary = `Updated ${report.updated} embeds in ${report.notes} notes. Skipped ${report.skipped.length}.`;
          if (!report.skipped.length || typeof document === 'undefined') {
            new Notice(summary);
            return;
          }
          const content = document.createDocumentFragment();
          content.append(summary + ' ' + report.skipped.map(item => `${item.path}: ${item.reason}`).join('; ') + ' ');
          const review = document.createElement('button');
          review.textContent = 'Review skipped embeds';
          review.addEventListener('click', () => new DescriptionSaveReview(this.app, report.skipped,
            item => this.overwriteSkipped(record, item)).open());
          content.append(review);
          new Notice(content, 12000);
        },
      },
    );
  }

  private async overwriteSkipped(record: ImageRecord, item: SkippedEmbed): Promise<SkippedEmbed[]> {
    await this.store.refresh(this.synchronize);
    const current = this.store.allRecords().find(candidate => candidate.id === record.id);
    if (!current || current.description !== record.description) {
      throw new Error('The image description changed. Save again and review the new results.');
    }
    let remaining: SkippedEmbed[] = [];
    const synchronize = this.synchronizer(item);
    synchronize.saved = (saved, journal) => {
      remaining = this.notes.saveReport(journal, saved).skipped;
    };
    await this.store.setDescription(current, current.description, synchronize, record.description);
    return remaining;
  }

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

  addEditorMenu(menu: Menu, editor: Editor, info: MarkdownFileInfo | MarkdownView, describe: (record: ImageRecord) => Promise<string | null>): void {
    if (!info.file || ('getMode' in info && info.getMode() !== 'source')) return;
    const selected = findManagedImage(editor.getValue(), info.file.path, this.store.allRecords(), {
      from: editor.posToOffset(editor.getCursor('from')),
      to: editor.posToOffset(editor.getCursor('to')),
    });
    if (selected) this.addRecordMenu(menu, selected.record, describe);
  }

  addFileMenu(menu: Menu, file: TAbstractFile, describe: (record: ImageRecord) => Promise<string | null>): void {
    if (!(file instanceof TFile)) return;
    const record = this.store.allRecords().find(record => record.imagePath === file.path || record.recordPath === file.path);
    if (record) this.addRecordMenu(menu, record, describe);
  }

  private addRecordMenu(menu: Menu, record: ImageRecord, describe: (record: ImageRecord) => Promise<string | null>): void {
    menu.addItem(item => item
      .setTitle('Edit image description')
      .setIcon('pencil')
      .onClick(() => this.editDescription(describe, record.id)));
  }

  async editDescription(describe: (record: ImageRecord) => Promise<string | null>, recordId?: string): Promise<void> {
    await this.selectRecord(async record => {
      const description = await describe(record);
      if (description === null) return;
      await this.store.setDescription(record, description, this.synchronize);
    }, recordId);
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

  private async selectRecord(action: (record: ImageRecord) => Promise<void>, recordId?: string): Promise<void> {
    try {
      const active = this.app.workspace.getActiveFile();
      const info = this.app.workspace.activeEditor as MarkdownFileInfo | MarkdownView | null;
      const reading = info && 'getMode' in info && info.getMode() === 'preview';
      const editor = !reading && info?.file === active ? info?.editor : undefined;
      const text = editor?.getValue();
      const selection = editor ? {
        from: editor.posToOffset(editor.getCursor('from')),
        to: editor.posToOffset(editor.getCursor('to')),
      } : undefined;
      await this.ready();
      await this.store.refresh(this.synchronize);
      const records = this.store.allRecords();
      if (recordId) {
        const record = records.find(record => record.id === recordId);
        if (!record) throw new Error('This image record is no longer available.');
        return await action(record);
      }
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
