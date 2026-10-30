import { Modal, PluginSettingTab, Setting, TFile, type App } from 'obsidian';
import type ImageLedgerPlugin from '../main';
import { normalizeDescription } from '../images/records';
import { isStorageLayout } from '../settings';
import type { ImageRecord } from '../images/model';

export class DescriptionModal extends Modal {
  private submitted = false;

  constructor(app: App, private record: ImageRecord, private resolve: (value: string | null) => void) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText('Describe this image');
    this.contentEl.addClass('image-ledger-description');
    const image = this.app.vault.getAbstractFileByPath(this.record.imagePath);
    if (image instanceof TFile) {
      this.contentEl.createEl('img', {
        attr: {src: this.app.vault.getResourcePath(image), alt: 'Image being added'},
      });
    }
    this.contentEl.createEl('p', {
      text: 'A short sentence becomes the image description and its searchable record.',
    });
    const input = this.contentEl.createEl('input', {
      type: 'text',
      attr: {
        'aria-label': 'Image description',
        placeholder: 'What is happening in this image?',
        maxlength: '500',
      },
    });
    input.value = this.record.captionStatus === 'confirmed' ? this.record.description : '';
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
    if (!this.submitted) this.resolve(null);
    this.contentEl.empty();
  }
}

export class RecordPicker extends Modal {
  constructor(app: App, private records: ImageRecord[], private choose: (record: ImageRecord) => void) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText('Choose an image');
    const input = this.contentEl.createEl('input', {
      type: 'search',
      attr: {placeholder: 'Search descriptions, image IDs or notes', 'aria-label': 'Search images'},
    });
    const count = this.contentEl.createEl('p', {attr: {'aria-live': 'polite'}});
    const results = this.contentEl.createDiv({cls: 'image-ledger-picker'});
    const records = [...this.records].sort((left, right) => Date.parse(right.importedAt) - Date.parse(left.importedAt));
    const render = () => {
      results.empty();
      const search = input.value.toLocaleLowerCase();
      const matches = records.filter(record =>
        `${record.description} ${record.id} ${record.sourceNotes.join(' ')}`.toLocaleLowerCase().includes(search));
      count.setText(`Showing ${Math.min(matches.length, 100)} of ${matches.length}`);
      for (const record of matches.slice(0, 100)) {
        const button = results.createEl('button');
        const image = this.app.vault.getAbstractFileByPath(record.imagePath);
        if (image instanceof TFile) {
          button.createEl('img', {attr: {src: this.app.vault.getResourcePath(image), alt: '', loading: 'lazy'}});
        }
        const label = button.createSpan();
        label.createSpan({text: record.description, cls: 'image-ledger-picker-description'});
        label.createEl('small', {text: `${record.sourceNotes.join(', ') || 'No source note'} · ${record.id}`});
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

export class MediaSettings extends PluginSettingTab {
  constructor(app: App, private plugin: ImageLedgerPlugin) {
    super(app, plugin);
  }

  display(): void {
    const {containerEl} = this;
    containerEl.empty();
    containerEl.createEl('h2', {text: 'Image Ledger'});
    containerEl.createEl('p', {
      text: 'JPEG/PNG files stay unchanged. Images and records use the selected storage layout. No upload or backup runs in this version.',
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
      .setName('Link image details in notes')
      .setDesc('Add a small link to the image record underneath each new image.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.showRecordLink)
        .onChange(async value => {
          this.plugin.settings.showRecordLink = value;
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
      text: 'Use Image Ledger: Open image library to browse images in Bases. Disable another image-paste uploader before using this plugin.',
    });
  }
}
