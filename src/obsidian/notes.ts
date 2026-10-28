import { MarkdownView, Notice, TFile, editorInfoField, type App, type Editor } from 'obsidian';
import { ViewPlugin, type EditorView } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import { randomUUID } from 'node:crypto';
import { addAnchor, insertionAnchors, removeAnchor } from './anchors';
import { markdownEmbed } from '../images/records';
import type { ImageRecord } from '../images/model';
import type { NoteProjection, ProjectionJournal } from '../images/operations';
import type { Settings } from '../settings';

export interface CaptureTarget {
  readonly path: string;
  insert(records: ImageRecord[]): Promise<void>;
  release(): void;
}

export class NoteImages {
  private editors = new WeakMap<Editor, EditorView>();

  constructor(private app: App, private settings: Settings) {}

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
        const markdown = records.map(record => this.embedWithDetails(record, file.path)).join('\n\n');
        return this.insertAtAnchor(file, view, anchorId, markdown);
      },
      release: () => {
        try {
          view?.dispatch({effects: removeAnchor.of(anchorId)});
        } catch { /* Closed editor. */ }
      },
    };
  }

  async updateEmbeds(previous: ImageRecord, next: ImageRecord, journal?: ProjectionJournal): Promise<void> {
    const plans: Record<string, NoteProjection> = journal?.notes ?? Object.create(null);
    for (const sourcePath of next.sourceNotes) {
      const existing = Object.hasOwn(plans, sourcePath) ? plans[sourcePath] : undefined;
      const file = this.sourceNote(sourcePath);
      if (!file) {
        if (existing) throw noteProjectionConflict(sourcePath);
        continue;
      }

      let before: string;
      let beforeRanges: NoteProjection['beforeRanges'];
      if (existing) {
        await this.applyNoteProjection(sourcePath, existing);
        before = existing.after;
        beforeRanges = existing.ranges;
      } else {
        // Flush user edits before recording a durable projection baseline.
        await this.saveOpenFile(sourcePath);
        before = await this.app.vault.read(file);
        const view = this.noteView(sourcePath);
        if (this.sourceNote(sourcePath) !== file || (view && view.editor.getValue() !== before)) {
          throw noteProjectionConflict(sourcePath);
        }
        const embed = markdownEmbed(previous, sourcePath);
        const prefix = embed.slice(0, embed.lastIndexOf('](') + 2);
        const pattern = new RegExp(escapePattern(prefix) + imageTargetPattern(embed) + '\\)', 'g');
        beforeRanges = [...before.matchAll(pattern)].map(match => ({
          from: match.index!, to: match.index! + match[0].length,
        }));
      }

      const embed = markdownEmbed(next, sourcePath);
      const plan: NoteProjection = {before, after: '', beforeRanges, ranges: []};
      let cursor = 0;
      for (const range of beforeRanges) {
        plan.after += before.slice(cursor, range.from);
        const from = plan.after.length;
        plan.after += embed;
        plan.ranges.push({from, to: plan.after.length});
        cursor = range.to;
      }
      plan.after += before.slice(cursor);
      Object.defineProperty(plans, sourcePath, {value: plan, configurable: true, enumerable: true, writable: true});
      await journal?.checkpoint();
      await this.applyNoteProjection(sourcePath, plan);
    }
  }

  private noteView(sourcePath: string): MarkdownView | undefined {
    const views = this.app.workspace.getLeavesOfType('markdown').map(leaf => leaf.view as MarkdownView);
    return views.find(view => view.file?.path === sourcePath);
  }

  private async applyNoteProjection(sourcePath: string, plan: NoteProjection): Promise<void> {
    const file = this.sourceNote(sourcePath);
    if (!file) throw noteProjectionConflict(sourcePath);
    const view = this.noteView(sourcePath);
    if (!view) {
      await this.app.vault.process(file, content => {
        if (content !== plan.before && content !== plan.after) throw noteProjectionConflict(sourcePath);
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
      const changes = plan.beforeRanges.flatMap((range, index) => {
        const after = plan.ranges[index];
        const text = plan.after.slice(after.from, after.to);
        if (plan.before.slice(range.from, range.to) === text) return [];
        return [{
          from: view.editor.offsetToPos(range.from),
          to: view.editor.offsetToPos(range.to),
          text,
        }];
      });
      if (changes.length) view.editor.transaction({changes});
    }
    if (view.editor.getValue() !== plan.after) throw noteProjectionConflict(sourcePath);
    // An interrupted save can leave the editor updated while disk still has the old text.
    await view.save();
    if (await this.app.vault.read(file) !== plan.after || view.editor.getValue() !== plan.after) {
      throw noteProjectionConflict(sourcePath);
    }
  }

  async recover(record: ImageRecord, sourcePath: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(sourcePath);
    if (!(file instanceof TFile)) return;
    const text = await this.app.vault.read(file);
    const target = imageTargetPattern(markdownEmbed(record, file.path));
    if (!new RegExp(`!\\[[^\\n]*\\]\\(${target}\\)`).test(text)) {
      await this.app.vault.process(file, content => `${content.trimEnd()}\n\n${this.embedWithDetails(record, file.path)}\n`);
    }
  }

  sourceNote(sourcePath: string): TFile | undefined {
    const file = this.app.vault.getAbstractFileByPath(sourcePath);
    return file instanceof TFile ? file : undefined;
  }

  private embedWithDetails(record: ImageRecord, sourcePath: string): string {
    const image = markdownEmbed(record, sourcePath);
    if (!this.settings.showRecordLink) return image;
    const imageRelative = markdownEmbed({...record, imagePath: record.recordPath}, sourcePath).match(/\]\((.*)\)$/)?.[1];
    return `${image}\n\n[Image details](${imageRelative})`;
  }

  private async insertAtAnchor(file: TFile, view: EditorView | undefined, anchorId: string, markdown: string): Promise<void> {
    const info = view?.state.field(editorInfoField, false);
    const anchor = view?.state.field(insertionAnchors, false)?.get(anchorId);
    if (view && anchor && info?.file === file) {
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
  return new Error(`A source note changed during the description save or no longer exists: ${sourcePath}. Its text and the unfinished save receipt were preserved.`);
}

function escapePattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function imageTargetPattern(embed: string): string {
  const target = embed.slice(embed.lastIndexOf('](') + 2, -1);
  // Existing generated destinations can contain literal parentheses; alt text must stay exact.
  return escapePattern(target)
    .replace(/%28/g, '(?:%28|\\()')
    .replace(/%29/g, '(?:%29|\\))');
}
