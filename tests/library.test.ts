import test from 'node:test';
import assert from 'node:assert/strict';
import { loadHostModules } from './host-modules';
import { markdownEmbed } from '../src/images/markdown';
import type { ManagedImage } from '../src/images/model';
import type { App, Editor, Menu, TFile as HostFile } from 'obsidian';
import type { MediaStore } from '../src/images/store';

const host = await loadHostModules();

function fixture() {
  const image: ManagedImage = {id: 'a'.repeat(64), imagePath: `images/${'a'.repeat(64)}.jpg`, description: 'Original description'};
  const other: ManagedImage = {id: 'b'.repeat(64), imagePath: `images/${'b'.repeat(64)}.png`, description: 'Other image'};
  const note = Object.assign(new host.TFile(), {path: 'Meal.md'});
  const text = new Map([[note.path, `Before\n${markdownEmbed(image, note.path)}\nAfter`]]);
  const files = new Map<string, HostFile>([[note.path, note], [image.imagePath, Object.assign(new host.TFile(), {path: image.imagePath})]]);
  let active = note;
  let cursor = text.get(note.path)!.indexOf('![') + 2;
  const errors: unknown[] = [];
  const calls: {image: ManagedImage; description: string}[] = [];
  let catalog = [image, other];
  const editor = {
    getValue: () => text.get(note.path)!,
    getCursor: () => ({line: 0, ch: cursor}),
    posToOffset: (position: {ch: number}) => position.ch,
  } as unknown as Editor;
  const app = {
    vault: {
      getAbstractFileByPath: (path: string) => files.get(path),
      getMarkdownFiles: () => [note],
      read: async (file: HostFile) => text.get(file.path)!,
      process: async (file: HostFile, update: (value: string) => string) => text.set(file.path, update(text.get(file.path)!)),
    },
    workspace: {
      getActiveFile: () => active,
      activeEditor: {file: note, editor},
      getLeavesOfType: () => [],
      openLinkText: async () => {},
    },
    metadataCache: {
      getFirstLinkpathDest: () => undefined,
      getFileCache: () => undefined,
      resolvedLinks: {},
    },
  } as unknown as App;
  const store = {
    recoverDeletions: async () => {},
    refresh: async () => {},
    allRecords: () => catalog,
    load: async (path: string) => {
      const current = catalog.find(record => record.imagePath === path);
      if (!current) throw new Error('Image unavailable');
      return {...current, checksum: 'verified-checksum'};
    },
    setDescription: async (current: ManagedImage, description: string) => {
      calls.push({image: current, description});
      return {...current, description};
    },
  } as unknown as MediaStore;
  const notes = new host.NoteImages(app);
  const library = new host.ImageLibrary(app, store, notes, error => errors.push(error), action => action());
  return {image, other, note, text, files, app, store, notes, library, editor, errors, calls,
    activate: (file: HostFile) => { active = file; },
    cursor: (offset: number) => {cursor = offset;},
    catalog: (images: ManagedImage[]) => {catalog = images;},
  };
}

function menu() {
  const items: {title: string; callback?: () => Promise<void>}[] = [];
  const value = {
    addItem: (build: (item: unknown) => void) => {
      const item = {title: '', callback: undefined as (() => Promise<void>) | undefined,
        setTitle(value: string) {this.title = value; return this;},
        setIcon() {return this;},
        onClick(value: () => Promise<void>) {this.callback = value; return this;},
      };
      build(item);
      items.push(item);
    },
  } as unknown as Menu;
  return {value, items};
}

test('description command uses its captured cursor target and a freshly loaded image', async () => {
  const f = fixture();
  await f.library.editDescription(async image => {
    assert.equal(image.id, f.image.id);
    assert.equal(image.checksum, 'verified-checksum');
    f.activate(Object.assign(new host.TFile(), {path: f.other.imagePath}));
    return 'Updated description';
  });
  assert.deepEqual(f.errors, []);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].image.id, f.image.id);
  assert.equal(f.calls[0].description, 'Updated description');
  assert.match(f.text.get(f.note.path)!, /Original description/);
});

test('canceling a description dialog leaves image metadata unsaved', async () => {
  const f = fixture();
  await f.library.editDescription(async () => null, f.image.id);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.errors, []);
});

test('editor menus require a managed embed and exclude Reading View', () => {
  const f = fixture();
  const source = menu();
  f.library.addEditorMenu(source.value, f.editor, {file: f.note} as never, async () => null);
  assert.deepEqual(source.items.map(item => item.title), [
    'Image Ledger: Edit image description', 'Image Ledger: Delete image everywhere...',
  ]);
  const preview = menu();
  f.library.addEditorMenu(preview.value, f.editor, {file: f.note, getMode: () => 'preview'} as never, async () => null);
  assert.equal(preview.items.length, 0);
  f.cursor(0);
  const prose = menu();
  f.library.addEditorMenu(prose.value, f.editor, {file: f.note} as never, async () => null);
  assert.equal(prose.items.length, 0);
});

test('file-menu callbacks retain image identity after active-file changes', async () => {
  const f = fixture();
  const m = menu();
  f.library.addFileMenu(m.value, f.files.get(f.image.imagePath)!, async () => 'Menu caption');
  f.activate(Object.assign(new host.TFile(), {path: f.other.imagePath}));
  await m.items[0].callback!();
  assert.equal(f.calls[0].image.id, f.image.id);
  f.catalog([f.other]);
  await m.items[0].callback!();
  assert.equal(f.calls.length, 1);
  assert.match(String(f.errors[0]), /no longer available/);
});

test('recovery inserts only once, ignores examples, and refuses a missing original note', async () => {
  const f = fixture();
  const embed = markdownEmbed(f.image, f.note.path);
  f.text.set(f.note.path, `\`\`\`md\n${embed}\n\`\`\`\n<!-- ${embed} -->`);
  await f.notes.recover(f.image, f.note.path);
  const recovered = f.text.get(f.note.path)!;
  await f.notes.recover(f.image, f.note.path);
  assert.equal(f.text.get(f.note.path), recovered);
  assert.equal(recovered.split(embed).length - 1, 3);
  f.files.delete(f.note.path);
  await assert.rejects(f.notes.recover(f.image, f.note.path), /original note no longer exists/);
});

test('deletion projections resume idempotently and stop on changed notes', async () => {
  const f = fixture();
  const preview = await f.notes.deletionPreview(f.image);
  await f.notes.removeEmbeds(f.image, preview.notes);
  assert.equal(f.text.get(f.note.path), 'Before\n\nAfter');
  await f.notes.removeEmbeds(f.image, preview.notes);
  f.text.set(f.note.path, 'Independent edits');
  await assert.rejects(f.notes.removeEmbeds(f.image, preview.notes), /source note changed/);
  assert.equal(f.text.get(f.note.path), 'Independent edits');
});


test('recovery saves the original open editor before appending an image', async () => {
  const f = fixture();
  f.text.set(f.note.path, 'Saved content');
  let saved = false;
  const view = {
    file: f.note,
    editor: {getValue: () => 'Current unsaved content'},
    save: async () => {
      f.text.set(f.note.path, 'Current unsaved content');
      saved = true;
    },
  };
  f.app.workspace.getLeavesOfType = (() => [{view}]) as never;
  await f.notes.recover(f.image, f.note.path);
  assert(saved);
  assert.match(f.text.get(f.note.path)!, /^Current unsaved content\n\n!\[/);
});


test('a retained deletion conflict does not block unrelated edits', async () => {
  const f = fixture();
  f.store.recoverDeletions = async () => {throw new Error('Deletion receipt retained');};
  await f.library.editDescription(async () => 'Unrelated caption', f.other.id);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].image.id, f.other.id);
  assert.match(String(f.errors[0]), /Deletion receipt retained/);
});
