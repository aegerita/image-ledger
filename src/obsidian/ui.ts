import { Modal, PluginSettingTab, Setting, TFile, type App } from 'obsidian';
import type ImageLedgerPlugin from '../main';
import { normalizeDescription } from '../images/markdown';
import { isStorageLayout } from '../settings';
import type { DeletePreview } from './notes';
import type { ImageAudit } from '../images/store';
import type { ManagedImage } from '../images/model';

export class DescriptionModal extends Modal {
  private submitted = false;
  private previewUrl?: string;

  constructor(app: App, private record: ManagedImage, private resolve: (value: string | null) => void,
    private preview?: Uint8Array) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText('Describe this image');
    this.contentEl.addClass('image-ledger-description');
    const image = this.app.vault.getAbstractFileByPath(this.record.imagePath);
    let src = image instanceof TFile ? this.app.vault.getResourcePath(image) : undefined;
    if (this.preview) {
      const type = this.record.imagePath.endsWith('.png') ? 'image/png' : 'image/jpeg';
      this.previewUrl = URL.createObjectURL(new Blob([Uint8Array.from(this.preview)], {type}));
      src = this.previewUrl;
    }
    if (src) this.contentEl.createEl('img', {attr: {src, alt: 'Image preview'}});
    this.contentEl.createEl('p', {
      text: 'The description is saved inside the image and travels with exported copies.',
    });
    const input = this.contentEl.createEl('input', {
      type: 'text',
      attr: {
        'aria-label': 'Image description',
        placeholder: 'What is happening in this image?',
        maxlength: '500',
      },
    });
    input.value = this.record.description;
    const error = this.contentEl.createEl('div', {
      cls: 'image-ledger-validation',
      attr: {'aria-live': 'polite'},
    });
    const submit = () => {
      try {
        const value = normalizeDescription(input.value);
        this.submitted = true;
        this.resolve(value);
        this.close();
      } catch {
        error.setText('Enter a short description, or choose Describe later.');
        input.focus();
      }
    };
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        event.preventDefault();
        submit();
      }
    });
    new Setting(this.contentEl)
      .addButton(button => button.setButtonText('Describe later').onClick(() => this.close()))
      .addButton(button => button.setButtonText('Save description').setCta().onClick(submit));
    input.focus();
  }

  onClose(): void {
    if (this.previewUrl) URL.revokeObjectURL(this.previewUrl);
    if (!this.submitted) this.resolve(null);
    this.contentEl.empty();
  }
}

export class ImagePicker extends Modal {
  constructor(app: App, private records: ManagedImage[], private choose: (record: ManagedImage) => void) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText('Choose an image');
    const input = this.contentEl.createEl('input', {
      type: 'search',
      attr: {placeholder: 'Search descriptions, image IDs or paths', 'aria-label': 'Search images'},
    });
    const count = this.contentEl.createEl('p', {attr: {'aria-live': 'polite'}});
    const results = this.contentEl.createDiv({cls: 'image-ledger-picker'});
    const created = (record: ManagedImage) => {
      const file = this.app.vault.getAbstractFileByPath(record.imagePath);
      return file instanceof TFile ? file.stat?.ctime ?? 0 : 0;
    };
    const records = [...this.records].sort((left, right) => created(right) - created(left));
    const render = () => {
      results.empty();
      const search = input.value.toLocaleLowerCase();
      const matches = records.filter(record =>
        `${record.description} ${record.id} ${record.imagePath}`.toLocaleLowerCase().includes(search));
      count.setText(`Showing ${Math.min(matches.length, 100)} of ${matches.length}`);
      for (const record of matches.slice(0, 100)) {
        const button = results.createEl('button');
        const image = this.app.vault.getAbstractFileByPath(record.imagePath);
        if (image instanceof TFile) {
          button.createEl('img', {attr: {src: this.app.vault.getResourcePath(image), alt: '', loading: 'lazy'}});
        }
        const label = button.createSpan();
        label.createSpan({text: record.description || 'Description pending', cls: 'image-ledger-picker-description'});
        label.createEl('small', {text: record.imagePath});
        button.addEventListener('click', () => {
          this.close();
          this.choose(record);
        });
      }
    };
    input.addEventListener('input', render);
    render();
    input.focus();
  }
}

export class DeleteImageModal extends Modal {
  private confirmed = false;

  constructor(
    app: App,
    private record: ManagedImage,
    private preview: DeletePreview,
    private resolve: (confirmed: boolean) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText('Delete image everywhere?');
    this.contentEl.addClass('image-ledger-description');
    const image = this.app.vault.getAbstractFileByPath(this.record.imagePath);
    if (image instanceof TFile) {
      this.contentEl.createEl('img', {
        attr: {src: this.app.vault.getResourcePath(image), alt: this.record.description},
      });
    }
    this.contentEl.createEl('p', {text: this.record.description});
    this.contentEl.createEl('p', {text: 'Remove these image embeds and move the image to recoverable Trash.'});
    const notes = this.contentEl.createEl('ul');
    for (const [path, plan] of Object.entries(this.preview.notes)) {
      const count = plan.beforeRanges.length;
      notes.createEl('li', {text: `${path}: ${count} embeds`});
    }
    if (!Object.keys(this.preview.notes).length) notes.createEl('li', {text: 'No supported references found.'});
    this.contentEl.createEl('p', {text: 'Delete these managed files using Obsidian’s Deleted files setting:'});
    const files = this.contentEl.createEl('ul');
    files.createEl('li', {text: this.record.imagePath});
    for (const reason of this.preview.blocked) {
      this.contentEl.createEl('p', {text: `Resolve before deleting: ${reason}`, cls: 'image-ledger-validation'});
    }
    let cancel!: HTMLButtonElement;
    new Setting(this.contentEl)
      .addButton(button => {
        cancel = button.buttonEl;
        button.setButtonText('Cancel').onClick(() => this.close());
      })
      .addButton(button => button.setButtonText('Delete image everywhere').setWarning()
        .setDisabled(this.preview.blocked.length > 0)
        .onClick(() => {
          this.confirmed = true;
          this.close();
        }));
    cancel.focus();
  }

  onClose(): void {
    this.resolve(this.confirmed);
    this.contentEl.empty();
  }
}

export class MediaSettings extends PluginSettingTab {
  constructor(app: App, private plugin: ImageLedgerPlugin) {
    super(app, plugin);
  }

  display(): void {
    const {containerEl} = this;
    containerEl.empty();
    containerEl.createEl('h2', {text: 'Image Ledger'});
    containerEl.createEl('p', {
      text: 'Descriptions are embedded in JPEG/PNG metadata. Normalized SHA-256 filenames stay stable when descriptions change.',
    });
    new Setting(containerEl)
      .setName('Handle image paste')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.interceptPaste)
        .onChange(async value => {
          this.plugin.settings.interceptPaste = value;
          await this.plugin.saveSettings();
        }));
    new Setting(containerEl)
      .setName('Handle image drop')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.interceptDrop)
        .onChange(async value => {
          this.plugin.settings.interceptDrop = value;
          await this.plugin.saveSettings();
        }));
    new Setting(containerEl)
      .setName('ExifTool executable')
      .setDesc('Requires ExifTool 13.58 or 13.63. Enter its absolute path, or exiftool if available on PATH. Reload the plugin after changing it.')
      .addText(text => text
        .setPlaceholder('/absolute/path/to/exiftool')
        .setValue(this.plugin.settings.exiftoolPath)
        .onChange(async value => {
          this.plugin.settings.exiftoolPath = value.trim() || 'exiftool';
          await this.plugin.saveSettings();
        }));
    new Setting(containerEl)
      .setName('Image storage')
      .setDesc('Choose one folder, the import year, or a year from the note name or folder. Existing images stay in place.')
      .addDropdown(dropdown => dropdown
        .addOptions({'flat': 'Single folder', 'import-year': 'Import year', 'note-year': 'Note year'})
        .setValue(this.plugin.settings.storageLayout)
        .onChange(async value => {
          if (!isStorageLayout(value)) return;
          this.plugin.settings.storageLayout = value;
          await this.plugin.saveSettings();
        }));
    containerEl.createEl('p', {
      text: 'Use Image Ledger: Open image library to browse image files. New embeds keep their insertion-time alt text when a description changes.',
    });
  }
}

export class ImageAuditModal extends Modal {
  constructor(app: App, private report: ImageAudit) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText('Managed image check');
    this.contentEl.addClass('image-ledger-audit');
    const report = this.report;
    this.contentEl.createEl('p', {
      text: `${report.images} managed images · ${report.pending} descriptions pending · ${report.interrupted} interrupted captures`,
    });
    this.contentEl.createEl('p', {text: 'This check does not change files or attempt recovery.'});
    if (!report.issues.length) {
      this.contentEl.createEl('p', {text: 'No issues found.'});
    }
    for (const issue of report.issues) {
      const row = this.contentEl.createDiv();
      row.createEl('code', {text: issue.path});
      row.createEl('p', {text: issue.reason});
    }
  }
}
