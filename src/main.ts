import { Plugin, Notice, type Editor, type MarkdownFileInfo } from 'obsidian';
import { CaptureWorkflow } from './captures';
import { MediaStore } from './images/store';
import type { ImageRecord, MediaInput } from './images/model';
import { RecordLibrary } from './obsidian/library';
import { NoteImages } from './obsidian/notes';
import { DescriptionModal, MediaSettings } from './obsidian/ui';
import { createVaultIO } from './obsidian/vault-io';
import { DEFAULTS, settingsFromData, type Settings } from './settings';

export default class ImageLedgerPlugin extends Plugin {
  settings: Settings = {...DEFAULTS};
  notes!: NoteImages;
  library!: RecordLibrary;
  captures!: CaptureWorkflow;

  async onload(): Promise<void> {
    this.settings = settingsFromData(await this.loadData());
    const store = new MediaStore(createVaultIO(this.app.vault), this.settings);
    this.notes = new NoteImages(this.app, this.settings);
    this.library = new RecordLibrary(this.app, store, this.notes, error => this.report(error));
    this.captures = new CaptureWorkflow(store, this.library, this.notes, {
      describe: record => this.askDescription(record),
      notify: message => { new Notice(message); },
      report: error => this.report(error),
    });

    this.registerEditorExtension(this.notes.editorExtension());
    this.registerCaptureEvents();
    this.registerCommands();
    this.addSettingTab(new MediaSettings(this.app, this));
    this.registerEvent(this.app.vault.on('modify', file => this.library.onModify(file)));
    this.registerEvent(this.app.vault.on('rename', (file, previousPath) => {
      if (/\.(?:jpg|png)\.[0-9a-f-]{36}\.tmp$/.test(previousPath)) return;
      this.captures.enqueue(() => this.library.rename(file, previousPath));
    }));
    this.app.workspace.onLayoutReady(() => {
      void this.library.ready().then(async () => {
        await this.library.reconcileAll();
        const pending = await store.pendingCaptures();
        if (pending.length) {
          new Notice(`${pending.length} image capture(s) can be recovered. Run Image Ledger: Recover interrupted image captures.`, 12000);
        }
      }).catch(error => this.report(error));
    });
  }

  onunload(): void {
    this.library?.dispose();
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  private registerCaptureEvents(): void {
    this.registerEvent(this.app.workspace.on('editor-paste', (event, editor, info) => {
      if (!this.settings.interceptPaste || event.defaultPrevented || !info.file) return;
      const files = Array.from(event.clipboardData?.files ?? []);
      if (!files.length) {
        for (const item of Array.from(event.clipboardData?.items ?? [])) {
          const file = item.kind === 'file' ? item.getAsFile() : null;
          if (file) files.push(file);
        }
      }
      this.handleFiles(event, files, editor, info, 'clipboard');
    }));
    this.registerEvent(this.app.workspace.on('editor-drop', (event, editor, info) => {
      if (!this.settings.interceptDrop || event.defaultPrevented || !info.file) return;
      this.handleFiles(event, Array.from(event.dataTransfer?.files ?? []), editor, info, 'drop');
    }));
  }

  private registerCommands(): void {
    this.addCommand({
      id: 'import-image', name: 'Import JPEG or PNG',
      editorCallback: (editor, info) => {
        if (!info.file) return;
        const target = this.notes.captureTarget(editor, info.file);
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/jpeg,image/png,.jpg,.jpeg,.png';
        input.multiple = true;
        input.addEventListener('change', () => {
          if (!input.files?.length) return target.release();
          this.captures.capture(Array.from(input.files), target, 'file');
        });
        input.addEventListener('cancel', () => target.release());
        input.click();
      },
    });
    this.addCommand({
      id: 'open-image-library', name: 'Open image library',
      callback: async () => {
        await this.library.ready();
        await this.app.workspace.openLinkText('image-library.base', '', true);
      },
    });
    this.addCommand({
      id: 'edit-image-description', name: 'Edit image description',
      callback: () => this.library.editDescription(record => this.askDescription(record)),
    });
    this.addCommand({
      id: 'recover-captures', name: 'Recover interrupted image captures',
      callback: () => this.captures.recover(),
    });
    this.addCommand({
      id: 'audit-images', name: 'Check image records',
      callback: () => void this.library.audit(),
    });
  }

  private handleFiles(event: Event, files: File[], editor: Editor, info: MarkdownFileInfo, method: MediaInput['method']): void {
    const images = files.filter(file => file.type.startsWith('image/') || /\.(?:jpe?g|png|heic|heif)$/i.test(file.name));
    if (!images.length || !info.file) return;
    // Claim the event before awaiting anything so native attachment / another plugin cannot race us.
    event.preventDefault();
    const position = event instanceof DragEvent ? this.notes.dropPosition(editor, event) : undefined;
    this.captures.capture(images, this.notes.captureTarget(editor, info.file, position), method);
  }

  private askDescription(record: ImageRecord): Promise<string | null> {
    return new Promise(resolve => new DescriptionModal(this.app, record, resolve).open());
  }

  private report(error: unknown): void {
    console.error('Image Ledger:', error);
    new Notice(`Image Ledger: ${error instanceof Error ? error.message : String(error)}`, 12000);
  }
}
