import { Notice, TFile, type App, type Editor, type MarkdownFileInfo, type MarkdownView, type Menu, type TAbstractFile } from 'obsidian';
import type { ManagedImage } from '../images/model';
import { findManagedImage, managedImageEmbeds } from '../images/embeds';
import { MediaStore } from '../images/store';
import { NoteImages } from './notes';
import { DeleteImageModal, ImageAuditModal, ImagePicker } from './ui';

export class ImageLibrary {
  private initialized?: Promise<void>;

  constructor(
    private app: App,
    readonly store: MediaStore,
    private notes: NoteImages,
    private report: (error: unknown) => void,
    private enqueue: (action: () => Promise<void>) => Promise<void>,
  ) {}

  ready(): Promise<void> {
    return this.initialized ??= this.store.refresh().then(async () => {
      try {
        await this.store.recoverDeletions((image, notes) => this.notes.removeEmbeds(image, notes));
      } catch (error) {
        this.report(error);
      }
    }).catch(error => {
      this.initialized = undefined;
      throw error;
    });
  }

  async openLibrary(describe: (image: ManagedImage) => Promise<string | null>): Promise<void> {
    try {
      await this.ready();
      await this.store.refresh();
      const images = this.store.allRecords();
      if (!images.length) return this.emptyNotice();
      new ImagePicker(this.app, images, image => {
        void this.app.workspace.openLinkText(image.imagePath, '', true).catch(this.report);
      }, image => void this.editDescription(describe, image.id)).open();
    } catch (error) {
      this.report(error);
    }
  }

  addEditorMenu(menu: Menu, editor: Editor, info: MarkdownFileInfo | MarkdownView, describe: (image: ManagedImage) => Promise<string | null>): void {
    if (!info.file || ('getMode' in info && info.getMode() === 'preview')) return;
    const selected = findManagedImage(editor.getValue(), info.file.path, this.store.allRecords(), {
      from: editor.posToOffset(editor.getCursor('from')),
      to: editor.posToOffset(editor.getCursor('to')),
    });
    if (selected) this.addImageMenu(menu, selected.record, describe);
  }

  addFileMenu(menu: Menu, file: TAbstractFile, describe: (image: ManagedImage) => Promise<string | null>): void {
    if (!(file instanceof TFile)) return;
    const image = this.store.allRecords().find(image => image.imagePath === file.path);
    if (image) this.addImageMenu(menu, image, describe);
  }

  private addImageMenu(menu: Menu, image: ManagedImage, describe: (image: ManagedImage) => Promise<string | null>): void {
    menu.addItem(item => item
      .setTitle('Image Ledger: Edit image description')
      .setIcon('pencil')
      .onClick(() => this.editDescription(describe, image.id)));
    menu.addItem(item => item
      .setTitle('Image Ledger: Delete image everywhere...')
      .setIcon('trash-2')
      .onClick(() => this.deleteImage(image.id)));
  }

  async deleteImage(imageId?: string): Promise<void> {
    await this.selectImage(selected => this.enqueue(async () => {
      const image = await this.store.load(selected.imagePath);
      const preview = await this.notes.deletionPreview(image);
      const confirmed = await new Promise<boolean>(resolve => {
        new DeleteImageModal(this.app, image, preview, resolve).open();
      });
      if (!confirmed || preview.blocked.length) return;
      const current = await this.notes.deletionPreview(image);
      if (JSON.stringify(current) !== JSON.stringify(preview)) {
        throw new Error('Image references changed. Open the deletion preview again.');
      }
      await this.store.deleteImage(image, preview.notes, (record, notes) => this.notes.removeEmbeds(record, notes));
      new Notice('Image deleted from this vault.');
    }), imageId);
  }

  async editDescription(describe: (image: ManagedImage) => Promise<string | null>, imageId?: string): Promise<void> {
    await this.selectImage(selected => this.enqueue(async () => {
      const image = await this.store.load(selected.imagePath);
      const description = await describe(image);
      if (description === null) return;
      const saved = await this.store.setDescription(image, description);
      const {updated, skipped, conflicts} = await this.notes.syncDescription(image, saved);
      let message = `Image description saved. Updated ${updated} Markdown embed(s).`;
      if (skipped) message += ` Kept ${skipped} custom or reference label(s).`;
      if (conflicts.length) {
        const examples = conflicts.slice(0, 3).join(', ');
        message += ` Could not check or update ${conflicts.length} note(s) with possible references: ${examples}.`;
      }
      new Notice(message, conflicts.length ? 12000 : undefined);
    }), imageId);
  }

  async audit(): Promise<void> {
    try {
      new ImageAuditModal(this.app, await this.store.audit()).open();
    } catch (error) {
      this.report(error);
    }
  }

  private emptyNotice(): void {
    new Notice('No managed images yet. Paste a JPEG or PNG into a note.');
  }

  private async selectImage(action: (image: ManagedImage) => Promise<void>, imageId?: string): Promise<void> {
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
      if (imageId) {
        const known = this.store.allRecords().find(image => image.id === imageId);
        if (known && this.app.vault.getAbstractFileByPath(known.imagePath) instanceof TFile) {
          return await action(known);
        }
      }
      await this.store.refresh();
      const images = this.store.allRecords();
      if (imageId) {
        const image = images.find(image => image.id === imageId);
        if (!image) throw new Error('This managed image is no longer available.');
        return await action(image);
      }
      const activeImage = images.find(image => image.imagePath === active?.path);
      if (activeImage) return await action(activeImage);
      if (!images.length) return this.emptyNotice();
      let choices = images;
      if (active?.extension === 'md') {
        const content = text ?? await this.app.vault.read(active);
        const selected = selection && findManagedImage(content, active.path, images, selection);
        if (selected) return await action(selected.record);
        const inNote = [...new Set(managedImageEmbeds(content, active.path, images).map(embed => embed.record))];
        if (inNote.length) choices = inNote;
      }
      new ImagePicker(this.app, choices, image => void action(image).catch(this.report)).open();
    } catch (error) {
      this.report(error);
    }
  }
}
