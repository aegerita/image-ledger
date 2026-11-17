import { MarkdownView, Notice, TFile, editorInfoField, type App, type Editor } from 'obsidian';
import { ViewPlugin, type EditorView } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import { randomUUID } from 'node:crypto';
import { addAnchor, insertionAnchors, removeAnchor } from './anchors';
import { assertVaultPath, markdownAltText, markdownEmbed } from '../images/markdown';
import { deletionBlockers, deletionProjection, managedImageEmbeds } from '../images/embeds';
import type { ManagedImage } from '../images/model';
import type { DeletionNotes, NoteProjection } from '../images/operations';

export interface CaptureTarget {
  readonly path: string;
  insert(records: ManagedImage[]): Promise<void>;
  release(): void;
}

export interface DeletePreview {
  notes: DeletionNotes;
  blocked: string[];
}

export class NoteImages {
  private editors = new WeakMap<Editor, EditorView>();

  constructor(private app: App) {}

  editorExtension(): Extension {
    const editors = this.editors;
    return [insertionAnchors, ViewPlugin.fromClass(class {
      constructor(public view: EditorView) {
        this.track();
      }

      update() {
        this.track();
      }

      track() {
        const info = this.view.state.field(editorInfoField, false);
        if (info?.editor) editors.set(info.editor, this.view);
      }
    })];
  }

  hasEditor(editor: Editor): boolean {
    return this.editors.has(editor);
  }

  dropPosition(editor: Editor, event: DragEvent): number | undefined {
    return this.editors.get(editor)?.posAtCoords({x: event.clientX, y: event.clientY}) ?? undefined;
  }

  captureTarget(editor: Editor, file: TFile, dropPosition?: number): CaptureTarget {
    const view = this.editors.get(editor);
    const anchorId = randomUUID();
    if (view && view.state.field(insertionAnchors, false)) {
      const from = dropPosition ?? editor.posToOffset(editor.getCursor('from'));
      const to = dropPosition ?? editor.posToOffset(editor.getCursor('to'));
      const selected = dropPosition === undefined
        ? editor.getRange(editor.getCursor('from'), editor.getCursor('to'))
        : '';
      view.dispatch({effects: addAnchor.of({id: anchorId, from, to, selected})});
    }

    return {
      get path() {
        return file.path;
      },
      insert: records => {
        const markdown = records.map(record => markdownEmbed(record, file.path)).join('\n\n');
        return this.insertAtAnchor(file, view, anchorId, markdown);
      },
      release: () => {
        try {
          view?.dispatch({effects: removeAnchor.of(anchorId)});
        } catch { /* Closed editor. */ }
      },
    };
  }

  private noteView(sourcePath: string): MarkdownView | undefined {
    const views = this.app.workspace.getLeavesOfType('markdown').map(leaf => leaf.view as MarkdownView);
    return views.find(view => view.file?.path === sourcePath);
  }

  async syncDescription(previous: ManagedImage, next: ManagedImage): Promise<{updated: number; skipped: number; conflicts: string[]}> {
    const report = {updated: 0, skipped: 0, conflicts: [] as string[]};
    const oldAlt = markdownAltText(previous.description);
    const newAlt = markdownAltText(next.description);
    if (oldAlt === newAlt) return report;

    // Read notes rather than relying on the link index, which can lag behind copied embeds.
    for (const file of this.app.vault.getMarkdownFiles()) {
      const sourcePath = file.path;
      try {
        const before = await this.app.vault.read(file);
        const views = this.app.workspace.getLeavesOfType('markdown')
          .map(leaf => leaf.view as MarkdownView).filter(view => view.file === file);
        const beforeRanges = [];
        for (const {alt} of managedImageEmbeds(before, sourcePath, [previous], true)) {
          const text = alt && before.slice(alt.from, alt.to);
          if (alt && text === oldAlt) {
            beforeRanges.push(alt);
          } else if (text !== newAlt) {
            report.skipped++;
          }
        }
        if (views.some(view => {
          const text = view.editor.getValue();
          return text !== before && (beforeRanges.length > 0 || managedImageEmbeds(text, sourcePath, [previous]).length > 0);
        })) {
          report.conflicts.push(sourcePath);
          continue;
        }
        if (!beforeRanges.length) continue;
        assertVaultPath(sourcePath);
        let cursor = 0;
        let after = '';
        for (const range of beforeRanges) {
          after += before.slice(cursor, range.from) + newAlt;
          cursor = range.to;
        }
        after += before.slice(cursor);
        await this.applyNoteProjection(sourcePath, {before, after, beforeRanges}, newAlt);
        report.updated += beforeRanges.length;
      } catch {
        report.conflicts.push(sourcePath);
      }
    }
    return report;
  }

  async deletionPreview(record: ManagedImage): Promise<DeletePreview> {
    const preview: DeletePreview = {notes: Object.create(null), blocked: []};
    // Scan saved Markdown and live editors; the link index can lag behind a copied embed.
    for (const file of this.app.vault.getMarkdownFiles()) {
      const saved = await this.app.vault.read(file);
      const text = this.noteView(file.path)?.editor.getValue() ?? saved;
      const plan = deletionProjection(text, file.path, record);
      const resolve = (link: string) => this.app.metadataCache.getFirstLinkpathDest(link, file.path)?.path;
      const blockers = deletionBlockers(text, file.path, record, resolve);
      if (text !== saved && (plan.beforeRanges.length || blockers.length
        || deletionProjection(saved, file.path, record).beforeRanges.length
        || deletionBlockers(saved, file.path, record, resolve).length)) {
        preview.blocked.push(`${file.path}: unsaved or conflicting edits; save or reload the note before deleting`);
      }
      if (plan.beforeRanges.length) {
        try {
          assertVaultPath(file.path);
          preview.notes[file.path] = plan;
        } catch {
          preview.blocked.push(`${file.path}: unsupported note path`);
        }
      }
      for (const reference of blockers) {
        preview.blocked.push(`${file.path}: unsupported reference ${reference}`);
      }
      for (const link of this.app.metadataCache.getFileCache(file)?.frontmatterLinks ?? []) {
        const target = this.app.metadataCache.getFirstLinkpathDest(link.link, file.path)?.path;
        if (target === record.imagePath) {
          preview.blocked.push(`${file.path}: property link ${link.original}`);
        }
      }
    }
    for (const [source, targets] of Object.entries(this.app.metadataCache.resolvedLinks)) {
      if (!source.endsWith('.md') && targets[record.imagePath]) {
        preview.blocked.push(`${source}: unsupported reference outside Markdown`);
      }
    }
    return preview;
  }

  async removeEmbeds(record: ManagedImage, notes: DeletionNotes): Promise<void> {
    const current = await this.deletionPreview(record);
    if (current.blocked.length) throw new Error(current.blocked.join('\n'));
    for (const [source, plan] of Object.entries(current.notes)) {
      if (!Object.hasOwn(notes, source) || notes[source].before !== plan.before) {
        throw new Error(`Image references changed in ${source}. The deletion receipt was retained.`);
      }
    }
    // Check every baseline before applying any more changes during recovery.
    for (const [source, plan] of Object.entries(notes)) {
      const file = this.sourceNote(source);
      const content = file && await this.app.vault.read(file);
      if (content !== plan.before && content !== plan.after) throw noteProjectionConflict(source);
      const editor = this.noteView(source)?.editor.getValue();
      if (editor !== undefined && editor !== plan.before && editor !== plan.after) throw noteProjectionConflict(source);
    }
    for (const [source, plan] of Object.entries(notes)) {
      await this.applyNoteProjection(source, plan);
    }
  }

  private async applyNoteProjection(sourcePath: string, plan: NoteProjection, replacement = ''): Promise<void> {
    const file = this.sourceNote(sourcePath);
    if (!file) throw noteProjectionConflict(sourcePath);
    const view = this.noteView(sourcePath);
    if (!view) {
      await this.app.vault.process(file, content => {
        if (this.sourceNote(sourcePath) !== file || this.noteView(sourcePath)
          || (content !== plan.before && content !== plan.after)) throw noteProjectionConflict(sourcePath);
        return plan.after;
      });
      return;
    }

    const saved = await this.app.vault.read(file);
    const content = view.editor.getValue();
    if (this.sourceNote(sourcePath) !== file || this.noteView(sourcePath) !== view
      || (saved !== plan.before && saved !== plan.after)
      || (content !== plan.before && content !== plan.after)) throw noteProjectionConflict(sourcePath);
    if (content === plan.before) {
      const changes = plan.beforeRanges.map(range => ({
        from: view.editor.offsetToPos(range.from),
        to: view.editor.offsetToPos(range.to),
        text: replacement,
      }));
      if (changes.length) view.editor.transaction({changes});
    }
    if (view.editor.getValue() !== plan.after) throw noteProjectionConflict(sourcePath);
    // An interrupted save can leave the editor updated while disk still has the old text.
    await view.save();
    if (await this.app.vault.read(file) !== plan.after || view.editor.getValue() !== plan.after) {
      throw noteProjectionConflict(sourcePath);
    }
  }

  async recover(record: ManagedImage, sourcePath: string): Promise<void> {
    const file = this.sourceNote(sourcePath);
    if (!file) throw new Error('The original note no longer exists. Restore the note before recovering its capture.');
    await this.saveOpenFile(sourcePath);
    const view = this.noteView(sourcePath);
    if (view && view.editor.getValue() !== await this.app.vault.read(file)) throw noteProjectionConflict(sourcePath);
    await this.app.vault.process(file, content => {
      if (managedImageEmbeds(content, file.path, [record], true).length) return content;
      return `${content.trimEnd()}\n\n${markdownEmbed(record, file.path)}\n`;
    });
  }

  sourceNote(sourcePath: string): TFile | undefined {
    const file = this.app.vault.getAbstractFileByPath(sourcePath);
    return file instanceof TFile ? file : undefined;
  }

  private async insertAtAnchor(file: TFile, view: EditorView | undefined, anchorId: string, markdown: string): Promise<void> {
    const info = view?.state.field(editorInfoField, false);
    const anchor = view?.state.field(insertionAnchors, false)?.get(anchorId);
    const live = view && this.app.workspace.getLeavesOfType('markdown')
      .some(leaf => {
        const markdown = leaf.view as MarkdownView;
        return markdown.file === file && this.editors.get(markdown.editor) === view;
      });
    if (live && anchor && info?.file === file) {
      const to = view.state.doc.sliceString(anchor.from, anchor.to) === anchor.selected ? anchor.to : anchor.from;
      view.dispatch({
        changes: {from: anchor.from, to, insert: markdown},
        effects: removeAnchor.of(anchorId),
        selection: {anchor: anchor.from + markdown.length},
      });
      await this.saveOpenFile(file.path);
      return;
    }

    // If the original editor closed, append to its captured file rather than a different active note.
    const original = this.app.vault.getAbstractFileByPath(file.path);
    if (!(original instanceof TFile)) {
      throw new Error('The original note no longer exists. The saved image is available through interrupted capture recovery.');
    }
    const leaf = this.app.workspace.getLeavesOfType('markdown').find(leaf => (leaf.view as MarkdownView).file === original);
    const editor = (leaf?.view as MarkdownView | undefined)?.editor;
    if (editor) {
      const end = {line: editor.lastLine(), ch: editor.getLine(editor.lastLine()).length};
      editor.replaceRange(`\n\n${markdown}\n`, end);
      await this.saveOpenFile(original.path);
    } else {
      await this.app.vault.process(original, text => `${text.trimEnd()}\n\n${markdown}\n`);
    }
    new Notice('Image added at the end of the original note because its editor changed.');
  }

  private async saveOpenFile(sourcePath: string): Promise<void> {
    const views = this.app.workspace.getLeavesOfType('markdown').map(leaf => leaf.view as MarkdownView);
    for (const view of views) {
      if (view.file?.path === sourcePath) await view.save();
    }
  }
}

function noteProjectionConflict(sourcePath: string): Error {
  return new Error(`A source note changed during the image operation or no longer exists: ${sourcePath}. Its text and the unfinished save receipt were preserved.`);
}
