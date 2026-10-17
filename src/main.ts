import { Plugin, PluginSettingTab, Setting, Modal, Notice, TFile, MarkdownView, editorInfoField, type App, type Editor, type MarkdownFileInfo } from 'obsidian';
import { ViewPlugin, type EditorView } from '@codemirror/view';
import { randomUUID } from 'node:crypto';
import { addAnchor, insertionAnchors, removeAnchor } from './anchors';
import { createVaultIO } from './vault-io';
import { MediaStore, type PendingCapture } from './store';
import { markdownEmbed, normalizeDescription, parseRecord, parseRecordSnapshot } from './records';
import type { ImageRecord, MediaInput } from './types';
import { latestBatchRecords, settledCaptures } from './capture-batch';

interface Settings { interceptPaste: boolean; interceptDrop: boolean; showRecordLink: boolean }
const DEFAULTS: Settings = {interceptPaste: true, interceptDrop: true, showRecordLink: true};
interface CaptureContext { file: TFile; editor: Editor; view?: EditorView; anchorId: string }

export default class JournalMediaPlugin extends Plugin {
  settings: Settings = {...DEFAULTS};
  store!: MediaStore;
  private editors = new WeakMap<Editor, EditorView>();
  private processing: Promise<unknown> = Promise.resolve();
  private recordTimers = new Map<string, ReturnType<typeof setTimeout>>();

  async onload(): Promise<void> {
    this.settings = {...DEFAULTS, ...await this.loadData()};
    this.store = new MediaStore(createVaultIO(this.app.vault));
    const plugin = this;
    this.registerEditorExtension([insertionAnchors, ViewPlugin.fromClass(class {
      constructor(public view: EditorView) { this.track(); }
      update() { this.track(); }
      track() {
        const info = this.view.state.field(editorInfoField, false);
        if (info?.editor) plugin.editors.set(info.editor, this.view);
      }
    })]);
    this.registerEvent(this.app.workspace.on('editor-paste', (event, editor, info) => {
      if (!this.settings.interceptPaste || event.defaultPrevented || !info.file) return;
      const files = Array.from(event.clipboardData?.files ?? []);
      if (!files.length) for (const item of Array.from(event.clipboardData?.items ?? [])) {
        const file = item.kind === 'file' ? item.getAsFile() : null;
        if (file) files.push(file);
      }
      this.handleFiles(event, files, editor, info, 'clipboard');
    }));
    this.registerEvent(this.app.workspace.on('editor-drop', (event, editor, info) => {
      if (!this.settings.interceptDrop || event.defaultPrevented || !info.file) return;
      this.handleFiles(event, Array.from(event.dataTransfer?.files ?? []), editor, info, 'drop');
    }));
    this.addCommand({id: 'import-image', name: 'Import JPEG or PNG', editorCallback: (editor, info) => {
      if (!info.file) return;
      const context = this.captureContext(editor, info.file);
      const input = document.createElement('input');
      input.type = 'file'; input.accept = 'image/jpeg,image/png,.jpg,.jpeg,.png'; input.multiple = true;
      input.addEventListener('change', () => {
        if (!input.files?.length) return this.releaseAnchor(context);
        this.captureFiles(Array.from(input.files), context, 'file');
      });
      input.addEventListener('cancel', () => this.releaseAnchor(context));
      input.click();
    }});
    this.addCommand({id: 'open-image-library', name: 'Open image library', callback: async () => {
      await this.ensureInitialized();
      await this.app.workspace.openLinkText('journal-images.base', '', true);
    }});
    this.addCommand({id: 'edit-image-description', name: 'Edit image description', callback: () => this.selectRecord(async record => {
      const description = await this.askDescription(record);
      if (description === null) return;
      const next: ImageRecord = {...record, description, captionStatus: 'confirmed'};
      await this.updateDescription(record, next);
      new Notice('Image description updated.');
    })});
    this.addCommand({id: 'recover-captures', name: 'Recover interrupted image captures', callback: () => void this.recoverCaptures()});
    this.addCommand({id: 'audit-images', name: 'Check image records', callback: () => void this.audit()});
    this.addSettingTab(new MediaSettings(this.app, this));
    this.registerEvent(this.app.vault.on('modify', file => {
      if (!/(?:^|\/)image-records\/[^/]+\.md$/.test(file.path)) return;
      const existing = this.recordTimers.get(file.path);
      if (existing) clearTimeout(existing);
      this.recordTimers.set(file.path, setTimeout(() => {
        this.recordTimers.delete(file.path);
        void this.reconcileRecord(file.path).catch(error => this.report(error));
      }, 500));
    }));
    this.registerEvent(this.app.vault.on('rename', (file, previousPath) => {
      const rewrite = (value: string) => value === previousPath ? file.path : value.startsWith(previousPath + '/') ? file.path + value.slice(previousPath.length) : value;
      this.enqueue(async () => {
        for (const record of this.store.allRecords()) {
          const next = {...record, imagePath: rewrite(record.imagePath), recordPath: rewrite(record.recordPath), sidecarPath: rewrite(record.sidecarPath), journalEntries: record.journalEntries.map(rewrite)};
          if (JSON.stringify(next) !== JSON.stringify(record)) {
            await this.store.persist(next);
          }
        }
      });
    }));
    this.app.workspace.onLayoutReady(() => {
      void this.ensureInitialized().then(async () => {
        for (const record of this.store.allRecords()) await this.reconcileRecord(record.recordPath);
        const pending = await this.store.pendingCaptures();
        if (pending.length) new Notice(`${pending.length} image capture(s) can be recovered. Run Journal Media: Recover interrupted image captures.`, 12000);
      }).catch(error => this.report(error));
    });
  }

  onunload(): void {
    for (const timer of this.recordTimers.values()) clearTimeout(timer);
  }
  private initialized?: Promise<void>;
  private ensureInitialized(): Promise<void> { return this.initialized ??= this.store.initialize(); }
  async saveSettings(): Promise<void> { await this.saveData(this.settings); }

  private handleFiles(event: Event, files: File[], editor: Editor, info: MarkdownFileInfo, method: MediaInput['method']): void {
    const images = files.filter(file => file.type.startsWith('image/') || /\.(?:jpe?g|png|heic|heif)$/i.test(file.name));
    if (!images.length || !info.file) return;
    // Claim the event before awaiting anything so native attachment / another plugin cannot race us.
    event.preventDefault();
    const view = this.editors.get(editor);
    const position = event instanceof DragEvent ? view?.posAtCoords({x: event.clientX, y: event.clientY}) ?? undefined : undefined;
    this.captureFiles(images, this.captureContext(editor, info.file, position), method);
  }

  private captureContext(editor: Editor, file: TFile, dropPosition?: number): CaptureContext {
    const view = this.editors.get(editor);
    const anchorId = randomUUID();
    if (view && view.state.field(insertionAnchors, false)) {
      const from = dropPosition ?? editor.posToOffset(editor.getCursor('from'));
      const to = dropPosition ?? editor.posToOffset(editor.getCursor('to'));
      view.dispatch({effects: addAnchor.of({id: anchorId, from, to, selected: dropPosition === undefined ? editor.getRange(editor.getCursor('from'), editor.getCursor('to')) : ''})});
    }
    return {file, editor, view, anchorId};
  }

  private releaseAnchor(context: CaptureContext): void {
    try { context.view?.dispatch({effects: removeAnchor.of(context.anchorId)}); } catch { /* Closed editor. */ }
  }

  private captureFiles(files: File[], context: CaptureContext, method: MediaInput['method']): void {
    // Stage every received image immediately. Caption dialogs run in sequence afterward.
    const staged = settledCaptures(files.map(async file => this.store.stage({bytes: new Uint8Array(await file.arrayBuffer()), name: file.name || undefined, lastModified: method === 'clipboard' ? undefined : file.lastModified, method}, context.file.path)));
    const operation = async () => {
      await this.ensureInitialized();
      const settled = await staged;
      const records: ImageRecord[] = [];
      const completed: PendingCapture[] = [];
      for (const outcome of settled) {
        if (outcome.status === 'rejected') { this.report(outcome.reason); continue; }
        const pending = outcome.value;
        try {
          for (const record of this.store.allRecords()) await this.reconcileRecord(record.recordPath);
          if (pending.sourcePath !== context.file.path) await this.store.retarget(pending, context.file.path);
          const prepared = await this.store.prepare(pending);
          const old = prepared.duplicate ? this.store.allRecords().find(record => record.id === prepared.record.id) : undefined;
          const description = await this.askDescription(prepared.record);
          if (pending.sourcePath !== context.file.path) {
            prepared.record.journalEntries = prepared.record.journalEntries.map(value => value === pending.sourcePath ? context.file.path : value);
            await this.store.retarget(pending, context.file.path);
          }
          const record = await this.store.describe(prepared, description);
          if (old && old.description !== record.description) await this.updateEmbeds(old, record);
          records.push(record);
          completed.push(pending);
        } catch (error) { this.report(error); }
      }
      if (records.length) {
        const finalRecords = latestBatchRecords(records, this.store.allRecords());
        await this.insertAtAnchor(context, finalRecords.map(record => this.embedWithDetails(record, context.file.path)).join('\n\n'));
        for (const pending of completed) await this.store.complete(pending);
      }
      this.releaseAnchor(context);
    };
    this.enqueue(operation, () => this.releaseAnchor(context));
  }

  private enqueue(operation: () => Promise<void>, cleanup?: () => void): void {
    this.processing = this.processing.then(operation, operation).catch(error => { cleanup?.(); this.report(error); });
  }

  private embedWithDetails(record: ImageRecord, sourcePath: string): string {
    const image = markdownEmbed(record, sourcePath);
    if (!this.settings.showRecordLink) return image;
    const imageRelative = markdownEmbed({...record, imagePath: record.recordPath}, sourcePath).match(/\]\((.*)\)$/)?.[1];
    return `${image}\n\n[Image details](${imageRelative})`;
  }

  private async insertAtAnchor(context: CaptureContext, markdown: string): Promise<void> {
    const view = context.view;
    const info = view?.state.field(editorInfoField, false);
    const anchor = view?.state.field(insertionAnchors, false)?.get(context.anchorId);
    if (view && anchor && info?.file === context.file) {
      const to = view.state.doc.sliceString(anchor.from, anchor.to) === anchor.selected ? anchor.to : anchor.from;
      view.dispatch({changes: {from: anchor.from, to, insert: markdown}, effects: removeAnchor.of(context.anchorId), selection: {anchor: anchor.from + markdown.length}});
      await this.saveOpenFile(context.file.path);
      return;
    }
    // If the original editor closed, append to its captured file rather than a different active note.
    const file = this.app.vault.getAbstractFileByPath(context.file.path);
    if (!(file instanceof TFile)) throw new Error('The original note no longer exists. The saved image is available through interrupted capture recovery.');
    const leaf = this.app.workspace.getLeavesOfType('markdown').find(leaf => (leaf.view as MarkdownView).file === file);
    const editor = (leaf?.view as MarkdownView | undefined)?.editor;
    if (editor) {
      editor.replaceRange(`\n\n${markdown}\n`, {line: editor.lastLine(), ch: editor.getLine(editor.lastLine()).length});
      await this.saveOpenFile(file.path);
    }
    else await this.app.vault.process(file, text => `${text.trimEnd()}\n\n${markdown}\n`);
    new Notice('Image added at the end of the original note because its editor changed.');
  }

  private askDescription(record: ImageRecord): Promise<string | null> {
    return new Promise(resolve => new DescriptionModal(this.app, record, resolve).open());
  }

  private async saveOpenFile(sourcePath: string): Promise<void> {
    const views = this.app.workspace.getLeavesOfType('markdown').map(leaf => leaf.view as MarkdownView);
    for (const view of views) if (view.file?.path === sourcePath) await view.save();
  }

  private async selectRecord(action: (record: ImageRecord) => Promise<void>): Promise<void> {
    try {
      await this.ensureInitialized(); await this.store.refresh();
      const active = this.app.workspace.getActiveFile();
      if (active) {
        const record = this.store.allRecords().find(record => record.recordPath === active.path || record.imagePath === active.path);
        if (record) return await action(record);
      }
      const records = this.store.allRecords();
      if (!records.length) return void new Notice('No journal images yet. Paste a JPEG or PNG into a note.');
      new RecordPicker(this.app, records, record => void action(record).catch(error => this.report(error))).open();
    } catch (error) { this.report(error); }
  }

  private async updateDescription(previous: ImageRecord, next: ImageRecord): Promise<void> {
    await this.updateEmbeds(previous, next);
    await this.store.persist(next);
  }

  private async updateEmbeds(previous: ImageRecord, next: ImageRecord): Promise<void> {
    for (const sourcePath of next.journalEntries) {
      const file = this.app.vault.getAbstractFileByPath(sourcePath);
      if (!(file instanceof TFile)) continue;
      const before = markdownEmbed(previous, sourcePath);
      const after = markdownEmbed(next, sourcePath);
      if (before === after) continue;
      const views = this.app.workspace.getLeavesOfType('markdown').map(leaf => leaf.view as MarkdownView);
      const editor = views.find(view => view.file?.path === sourcePath)?.editor;
      if (editor) {
        const content = editor.getValue();
        const changes = [...content.matchAll(new RegExp(before.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))].map(match => ({from: editor.offsetToPos(match.index!), to: editor.offsetToPos(match.index! + before.length), text: after}));
        if (changes.length) { editor.transaction({changes}); await this.saveOpenFile(sourcePath); }
      } else await this.app.vault.process(file, content => content.split(before).join(after));
    }
  }

  private async reconcileRecord(recordPath: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(recordPath);
    if (!(file instanceof TFile)) return;
    const content = await this.app.vault.read(file);
    const next = parseRecord(content);
    if (!next) return;
    const previous = parseRecordSnapshot(content) ?? this.store.allRecords().find(record => record.id === next.id);
    if (previous && (previous.description !== next.description || previous.captionStatus !== next.captionStatus)) await this.updateDescription(previous, next);
  }

  private recoverCaptures(): void { this.enqueue(() => this.runRecovery()); }

  private async runRecovery(): Promise<void> {
    try {
      await this.ensureInitialized();
      const captures = await this.store.pendingCaptures();
      if (!captures.length) return void new Notice('No interrupted captures to recover.');
      for (const pending of captures) {
        const prepared = await this.store.prepare(pending);
        const previous = {...prepared.record};
        const description = await this.askDescription(prepared.record);
        const record = await this.store.describe(prepared, description);
        if (previous.description !== record.description) await this.updateEmbeds(previous, record);
        const file = this.app.vault.getAbstractFileByPath(pending.sourcePath);
        if (file instanceof TFile) {
          const text = await this.app.vault.read(file);
          const imageTarget = markdownEmbed(record, file.path).match(/\]\((.*)\)$/)?.[1] ?? '';
          const escapedTarget = imageTarget.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          if (!new RegExp(`!\\[[^\\n]*\\]\\(${escapedTarget}\\)`).test(text)) {
            await this.app.vault.process(file, content => `${content.trimEnd()}\n\n${this.embedWithDetails(record, file.path)}\n`);
          }
        }
        await this.store.complete(pending);
        await this.app.workspace.openLinkText(record.recordPath, '', true);
      }
      new Notice('Interrupted images recovered.');
    } catch (error) { this.report(error); }
  }

  private async audit(): Promise<void> {
    try {
      await this.ensureInitialized(); await this.store.refresh();
      const records = this.store.allRecords();
      let missing = 0;
      for (const record of records) if (!await this.app.vault.adapter.exists(record.imagePath)) missing++;
      const pending = records.filter(record => record.captionStatus === 'pending').length;
      const interrupted = (await this.store.pendingCaptures()).length;
      new Notice(`${records.length} image records · ${pending} descriptions pending · ${missing} missing files · ${interrupted} interrupted captures`, 12000);
    } catch (error) { this.report(error); }
  }

  private report(error: unknown): void {
    console.error('Journal Media:', error);
    new Notice(`Journal Media: ${error instanceof Error ? error.message : String(error)}`, 12000);
  }
}

class DescriptionModal extends Modal {
  private submitted = false;
  constructor(app: App, private record: ImageRecord, private resolve: (value: string | null) => void) { super(app); }
  onOpen(): void {
    this.titleEl.setText('Describe this image');
    this.contentEl.addClass('journal-media-description');
    const image = this.app.vault.getAbstractFileByPath(this.record.imagePath);
    if (image instanceof TFile) this.contentEl.createEl('img', {attr: {src: this.app.vault.getResourcePath(image), alt: 'Image being added'}});
    this.contentEl.createEl('p', {text: 'A short sentence becomes the image description and its searchable record.'});
    const input = this.contentEl.createEl('input', {type: 'text', attr: {'aria-label': 'Image description', placeholder: 'What is happening in this image?', maxlength: '500'}});
    input.value = this.record.captionStatus === 'confirmed' ? this.record.description : '';
    const error = this.contentEl.createEl('div', {cls: 'journal-media-validation', attr: {'aria-live': 'polite'}});
    const submit = () => {
      try { const value = normalizeDescription(input.value); this.submitted = true; this.resolve(value); this.close(); }
      catch { error.setText('Enter a short description, or choose Describe later.'); input.focus(); }
    };
    input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); submit(); } });
    new Setting(this.contentEl)
      .addButton(button => button.setButtonText('Describe later').onClick(() => this.close()))
      .addButton(button => button.setButtonText('Save description').setCta().onClick(submit));
    input.focus();
  }
  onClose(): void { if (!this.submitted) this.resolve(null); this.contentEl.empty(); }
}

class RecordPicker extends Modal {
  constructor(app: App, private records: ImageRecord[], private choose: (record: ImageRecord) => void) { super(app); }
  onOpen(): void {
    this.titleEl.setText('Choose an image');
    const input = this.contentEl.createEl('input', {type: 'search', attr: {placeholder: 'Search descriptions or UUIDs', 'aria-label': 'Search images'}});
    const results = this.contentEl.createDiv({cls: 'journal-media-picker'});
    const render = () => {
      results.empty();
      const search = input.value.toLocaleLowerCase();
      for (const record of this.records.filter(record => `${record.description} ${record.id}`.toLocaleLowerCase().includes(search)).slice(0, 100)) {
        const button = results.createEl('button', {text: record.description});
        button.addEventListener('click', () => { this.close(); this.choose(record); });
      }
    };
    input.addEventListener('input', render); render(); input.focus();
  }
}

class MediaSettings extends PluginSettingTab {
  constructor(app: App, private plugin: JournalMediaPlugin) { super(app, plugin); }
  display(): void {
    const {containerEl} = this; containerEl.empty();
    containerEl.createEl('h2', {text: 'Journal Media'});
    containerEl.createEl('p', {text: 'JPEG/PNG files stay unchanged in the journal year’s images folder. Records and descriptions live in image-records. No upload or backup runs in this version.'});
    new Setting(containerEl).setName('Handle image paste').addToggle(toggle => toggle.setValue(this.plugin.settings.interceptPaste).onChange(async value => {this.plugin.settings.interceptPaste = value; await this.plugin.saveSettings();}));
    new Setting(containerEl).setName('Handle image drop').addToggle(toggle => toggle.setValue(this.plugin.settings.interceptDrop).onChange(async value => {this.plugin.settings.interceptDrop = value; await this.plugin.saveSettings();}));
    new Setting(containerEl).setName('Link image details in the journal').setDesc('Add a small link to the image record underneath each new image.').addToggle(toggle => toggle.setValue(this.plugin.settings.showRecordLink).onChange(async value => {this.plugin.settings.showRecordLink = value; await this.plugin.saveSettings();}));
    containerEl.createEl('p', {text: 'Use Journal Media: Open image library to browse images in Bases. Disable another image-paste uploader before using this plugin.'});
  }
}
