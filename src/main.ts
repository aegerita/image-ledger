import { Plugin, Notice, type Editor, type MarkdownFileInfo } from 'obsidian';
import { CaptureWorkflow, type CaptureMethod } from './captures';
import { MediaStore } from './images/store';
import { createDescriptionCodec } from './images/description';
import { UnreadableImageError } from './images/identity';
import type { ManagedImage } from './images/model';
import { ImageLibrary } from './obsidian/library';
import { NoteImages } from './obsidian/notes';
import { DescriptionModal, MediaSettings } from './obsidian/ui';
import { createVaultIO } from './obsidian/vault-io';
import { DEFAULTS, settingsFromData, type Settings } from './settings';

export default class ImageLedgerPlugin extends Plugin {
  settings: Settings = {...DEFAULTS};
  notes!: NoteImages;
  library!: ImageLibrary;
  captures!: CaptureWorkflow;

  async onload(): Promise<void> {
    this.settings = settingsFromData(await this.loadData());
    const codec = createDescriptionCodec(this.settings.exiftoolPath);
    const store = new MediaStore(createVaultIO(this.app.vault, this.app.fileManager), this.settings, codec);
    this.notes = new NoteImages(this.app);
    this.library = new ImageLibrary(this.app, store, this.notes, error => this.report(error),
      action => this.captures.enqueue(action));
    this.captures = new CaptureWorkflow(store, this.notes, {
      describe: (image, preview) => this.askDescription(image, preview),
      notify: message => { new Notice(message); },
      report: error => this.report(error),
    });

    this.registerEditorExtension(this.notes.editorExtension());
    this.registerCaptureEvents();
    this.registerCommands();
    this.registerEvent(this.app.workspace.on('editor-menu', (menu, editor, info) => {
      this.library.addEditorMenu(menu, editor, info, image => this.askDescription(image));
    }));
    this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => {
      this.library.addFileMenu(menu, file, image => this.askDescription(image));
    }));
    this.addSettingTab(new MediaSettings(this.app, this));
    this.registerEvent(this.app.vault.on('rename', (file, previousPath) => {
      this.captures.enqueue(() => store.rename(previousPath, file.path));
    }));
    this.app.workspace.onLayoutReady(() => {
      void this.library.ready().then(async () => {
        const pending = await store.pendingCaptures();
        if (pending.length) {
          new Notice(`${pending.length} image capture(s) can be recovered. Run Image Ledger: Recover interrupted image captures.`, 12000);
        }
      }).catch(error => this.report(error));
    });
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
      callback: () => this.library.openLibrary(image => this.askDescription(image)),
    });
    this.addCommand({
      id: 'edit-image-description', name: 'Edit image description',
      callback: () => this.library.editDescription(image => this.askDescription(image)),
    });
    this.addCommand({
      id: 'delete-image-everywhere', name: 'Delete image everywhere...',
      callback: () => this.library.deleteImage(),
    });
    this.addCommand({
      id: 'recover-captures', name: 'Recover interrupted image captures',
      callback: () => this.captures.recover(),
    });
    this.addCommand({
      id: 'audit-images', name: 'Check managed images',
      callback: () => void this.library.audit(),
    });
  }

  private handleFiles(event: Event, files: File[], editor: Editor, info: MarkdownFileInfo, method: CaptureMethod): void {
    const images = files.filter(file => file.type.startsWith('image/') || /\.(?:jpe?g|png|heic|heif)$/i.test(file.name));
    if (!images.length || !info.file) return;
    // Claim the event before awaiting anything so native attachment / another plugin cannot race us.
    event.preventDefault();
    const position = event instanceof DragEvent ? this.notes.dropPosition(editor, event) : undefined;
    this.captures.capture(images, this.notes.captureTarget(editor, info.file, position), method);
  }

  private askDescription(image: ManagedImage, preview?: Uint8Array): Promise<string | null> {
    return new Promise(resolve => new DescriptionModal(this.app, image, resolve, preview).open());
  }

  private report(error: unknown): void {
    console.error('Image Ledger:', error);
    const message = error instanceof Error ? error.message : String(error);
    new Notice(error instanceof UnreadableImageError ? message : `Image Ledger: ${message}`, 12000);
  }
}
