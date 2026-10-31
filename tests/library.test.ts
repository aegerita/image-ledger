import assert from 'node:assert/strict';
import test from 'node:test';
import type { App, Editor, EditorPosition, MarkdownView, Menu, MenuItem, TFile } from 'obsidian';
import type { EditorView } from '@codemirror/view';
import { CaptureWorkflow } from '../src/captures';
import type { ImageRecord } from '../src/images/model';
import type { RecordOperation } from '../src/images/operations';
import { parseRecord, parseRecordSnapshot, serializeRecord, serializeSidecar } from '../src/images/records';
import type { VaultIO } from '../src/images/store';
import { DEFAULTS } from '../src/settings';
import { JPEG, PNG } from './fixtures';
import { loadHostModules } from './host-modules';

const host = await loadHostModules();

function fakeMenu() {
  const entries: {title: string; icon: string; click: () => unknown}[] = [];
  const menu = {
    addItem(build: (item: MenuItem) => unknown) {
      const entry = {title: '', icon: '', click: (): unknown => undefined};
      const item = {
        setTitle(title: string) {
          entry.title = title;
          return this;
        },
        setIcon(icon: string) {
          entry.icon = icon;
          return this;
        },
        onClick(click: () => unknown) {
          entry.click = click;
          return this;
        },
      };
      build(item as unknown as MenuItem);
      entries.push(entry);
      return this;
    },
  } as unknown as Menu;
  return {menu, entries};
}

function fixture(persisted = {
  text: new Map<string, string>(),
  bytes: new Map<string, Uint8Array>(),
  folders: new Set<string>(),
}) {
  const {text, bytes, folders} = persisted;
  const files = new Map<string, TFile>();
  for (const path of text.keys()) {
    const file = new host.TFile();
    file.path = path;
    files.set(path, file);
  }
  const leaves: {view: unknown}[] = [];
  let activeFile: TFile | undefined;
  let recordReads = 0;
  let recordScans = 0;
  const io: VaultIO = {
    reserveId: async id => {
      const reservation = `.image-ledger/ids/${id}`;
      if (text.has(reservation)) return false;
      text.set(reservation, '');
      return true;
    },
    exists: async path => text.has(path) || bytes.has(path) || folders.has(path),
    read: async path => {
      if (/(?:^|\/)image-records\/[^/]+\.md$/.test(path)) recordReads++;
      const value = text.get(path);
      assert.notEqual(value, undefined, `Missing file: ${path}`);
      return value!;
    },
    readBinary: async path => {
      const value = bytes.get(path);
      assert.ok(value, `Missing payload: ${path}`);
      return value.slice();
    },
    write: async (path, value) => {
      text.set(path, value);
      if (!files.has(path)) {
        const file = new host.TFile();
        file.path = path;
        files.set(path, file);
      }
    },
    process: async (path, update) => {
      const content = text.get(path);
      assert.notEqual(content, undefined, `Missing file: ${path}`);
      text.set(path, update(content!));
    },
    writeBinary: async (path, value) => { bytes.set(path, value.slice()); },
    mkdir: async path => { folders.add(path); },
    remove: async path => { text.delete(path); bytes.delete(path); files.delete(path); },
    recordPaths: async () => {
      recordScans++;
      return [...text.keys()].filter(path => /(?:^|\/)image-records\/[^/]+\.md$/.test(path));
    },
    pendingPaths: async () => [...text.keys(), ...bytes.keys()].filter(path => path.startsWith('.image-ledger/staging/')),
    operationPaths: async () => [...text.keys()].filter(path => /^\.image-ledger\/operations\/[^/]+\.json$/.test(path)),
  };
  const resolvedLinks: Record<string, Record<string, number>> = {};
  const cachedEmbeds: Record<string, {original: string; link: string}[]> = {};
  const app = {
    metadataCache: {
      resolvedLinks,
      getFileCache: (file: TFile) => ({embeds: cachedEmbeds[file.path] ?? []}),
      getFirstLinkpathDest: (link: string) => ({path: link}),
    },
    vault: {
      getAbstractFileByPath: (path: string) => files.get(path),
      read: (file: TFile) => io.read(file.path),
      process: (file: TFile, update: (value: string) => string) => io.process(file.path, update),
      adapter: {exists: io.exists},
    },
    workspace: {
      getLeavesOfType: () => leaves,
      openLinkText: async () => {},
      getActiveFile: () => activeFile,
      get activeEditor() {
        return leaves.find(leaf => (leaf.view as {file: TFile}).file === activeFile)?.view;
      },
    },
  } as unknown as App;
  const errors: unknown[] = [];
  const store = new host.MediaStore(io);
  const settings = {...DEFAULTS};
  const notes = new host.NoteImages(app, settings);
  const library = new host.RecordLibrary(app, store, notes, error => { errors.push(error); });
  const workflow = (describe: (record: ImageRecord) => Promise<string | null>) => new CaptureWorkflow(store, library, notes, {
    describe, notify: () => {}, report: error => { errors.push(error); },
  });
  const drain = (captures: CaptureWorkflow) => new Promise<void>(resolve => captures.enqueue(async () => { resolve(); }));
  const openEditor = (path: string) => {
    let content = text.get(path)!;
    let cursor = {line: 0, ch: 0};
    const offset = (position: EditorPosition) => content.split('\n').slice(0, position.line)
      .reduce((total, line) => total + line.length + 1, 0) + position.ch;
    const editor = {
      getValue: () => content,
      getCursor: () => cursor,
      setCursor: (position: EditorPosition) => { cursor = position; },
      posToOffset: offset,
      offsetToPos: (index: number) => {
        const lines = content.slice(0, index).split('\n');
        return {line: lines.length - 1, ch: lines.at(-1)!.length};
      },
      transaction: ({changes}: {changes: {from: EditorPosition; to: EditorPosition; text: string}[]}) => {
        const edits = changes.map(change => ({from: offset(change.from), to: offset(change.to), text: change.text}));
        for (const edit of edits.sort((left, right) => right.from - left.from)) {
          content = content.slice(0, edit.from) + edit.text + content.slice(edit.to);
        }
      },
    };
    leaves.push({view: {file: files.get(path), editor, save: () => io.write(path, content)}});
    return editor;
  };
  return {io, text, files, leaves, store, notes, library, resolvedLinks, cachedEmbeds, settings, workflow, drain, errors, openEditor, persisted, recordReads: () => recordReads, recordScans: () => recordScans, activate: (path: string) => { activeFile = files.get(path); }};
}

test('description command resolves the live editor target and scopes its fallback picker by actual embeds', async () => {
  const f = fixture();
  await f.library.ready();
  await f.io.write('Original.md', '# Note\n');
  const png = await f.store.describe(await f.store.prepare(await f.store.stage({bytes: PNG, method: 'file'}, 'Original.md')), 'Same description');
  const jpeg = await f.store.describe(await f.store.prepare(await f.store.stage({bytes: JPEG, method: 'file'}, 'Original.md')), 'Same description');
  const editor = f.openEditor('Original.md');
  f.activate('Original.md');
  const embed = `![Custom label](images/${png.id}.png)`;
  editor.transaction({changes: [{from: {line: 1, ch: 0}, to: {line: 1, ch: 0}, text: `${embed}\n${embed}`}]});
  editor.setCursor({line: 2, ch: 4});
  let selected: ImageRecord | undefined;
  const describe = async (record: ImageRecord) => {
    selected = record;
    return null;
  };
  const open = host.RecordPicker.prototype.open;
  const choices: ImageRecord[][] = [];
  host.RecordPicker.prototype.open = function() {
    choices.push((this as unknown as {records: ImageRecord[]}).records);
  };
  try {
    await f.library.editDescription(describe);
    assert.equal(selected?.id, png.id);
    assert.equal(choices.length, 0, 'Cursor match must bypass the picker');
    assert.equal(f.text.get('Original.md'), '# Note\n', 'Lookup must use unsaved editor content');
    editor.setCursor({line: 0, ch: 0});
    await f.library.editDescription(describe);
    assert.deepEqual(choices.at(-1)?.map(record => record.id), [png.id], 'Only actual embeds, deduplicated');
    await f.io.write('Empty.md', '# No images\n');
    f.activate('Empty.md');
    await f.library.editDescription(describe);
    assert.deepEqual(new Set(choices.at(-1)?.map(record => record.id)), new Set([png.id, jpeg.id]));
    await f.io.write('Reading.md', embed);
    f.activate('Reading.md');
    await f.library.editDescription(describe);
    assert.deepEqual(choices.at(-1)?.map(record => record.id), [png.id], 'Saved notes work without an editor');
    f.activate('Original.md');
    Object.assign(f.leaves[0].view as object, {getMode: () => 'preview'});
    editor.setCursor({line: 2, ch: 4});
    await f.library.editDescription(describe);
    assert.equal(choices.at(-1)?.length, 2, 'Reading View must ignore its retained editor and use the saved note');
    assert.deepEqual(f.errors, []);
  } finally {
    host.RecordPicker.prototype.open = open;
  }
});

test('editor and file menus add only the implemented action for managed images and records', async () => {
  const f = fixture();
  await f.library.ready();
  const sample = await f.store.describe(await f.store.prepare(await f.store.stage({bytes: PNG, method: 'file'}, 'Original.md')), 'Original');
  const embed = `![Photo [draft]](./${sample.imagePath})`;
  const text = `Prose\n${embed}\n\`${embed}\`\n![Unmanaged](fixtures/sample.png)`;
  await f.io.write('Original.md', text);
  const editor = f.openEditor('Original.md');
  const info = f.leaves[0].view as MarkdownView;
  const describe = async () => null;
  editor.setCursor({line: 1, ch: 5});
  const image = new host.TFile();
  image.path = sample.imagePath;
  for (const build of [
    (menu: Menu) => f.library.addEditorMenu(menu, editor as unknown as Editor, info, describe),
    (menu: Menu) => f.library.addFileMenu(menu, image, describe),
    (menu: Menu) => f.library.addFileMenu(menu, f.files.get(sample.recordPath)!, describe),
  ]) {
    const menu = fakeMenu();
    build(menu.menu);
    assert.deepEqual(menu.entries.map(entry => [entry.title, entry.icon]), [['Edit image description', 'pencil']]);
  }
  for (const line of [0, 2, 3]) {
    editor.setCursor({line, ch: 3});
    const menu = fakeMenu();
    f.library.addEditorMenu(menu.menu, editor as unknown as Editor, info, describe);
    assert.deepEqual(menu.entries, []);
  }
  editor.setCursor({line: 1, ch: 5});
  const readingMenu = fakeMenu();
  f.library.addEditorMenu(readingMenu.menu, editor as unknown as Editor, {...info, getMode: () => 'preview'}, describe);
  assert.deepEqual(readingMenu.entries, []);
  for (const file of [f.files.get('Original.md')!, Object.assign(new host.TFile(), {path: 'unmanaged.png'}), {path: 'images'} as TFile]) {
    const menu = fakeMenu();
    f.library.addFileMenu(menu.menu, file, describe);
    assert.deepEqual(menu.entries, []);
  }
});

test('menu actions keep their image identity, refresh the description and use the shared save path', async () => {
  const f = fixture();
  await f.library.ready();
  const sample = await f.store.describe(await f.store.prepare(await f.store.stage({bytes: PNG, method: 'file'}, 'Original.md')), 'Original');
  await f.io.write('Original.md', `![Original](${sample.imagePath})`);
  const editor = f.openEditor('Original.md');
  editor.setCursor({line: 0, ch: 3});
  const menu = fakeMenu();
  f.library.addEditorMenu(menu.menu, editor as unknown as Editor, f.leaves[0].view as MarkdownView, async record => {
    assert.equal(record.id, sample.id);
    assert.equal(record.description, 'Newer description');
    return 'Menu description';
  });
  await f.store.setDescription(sample, 'Newer description', (previous, next, journal) => f.notes.updateEmbeds(previous, next, journal));
  await f.io.write('Other.md', '# Other sentinel');
  f.activate('Other.md');
  editor.setCursor({line: 0, ch: 0});
  await menu.entries[0].click();
  assert.equal(parseRecord(f.text.get(sample.recordPath)!)?.description, 'Menu description');
  assert.match(f.text.get(sample.sidecarPath)!, /Menu description/);
  assert.equal(f.text.get('Original.md'), `![Menu description](${sample.imagePath})`);
  assert.equal(f.text.get('Other.md'), '# Other sentinel');
  assert.deepEqual(f.errors, []);
});

test('menu actions report a removed record without opening a different image or a picker', async () => {
  const f = fixture();
  await f.library.ready();
  const sample = await f.store.describe(await f.store.prepare(await f.store.stage({bytes: PNG, method: 'file'}, 'Original.md')), 'Original');
  let described = false;
  const menu = fakeMenu();
  f.library.addFileMenu(menu.menu, f.files.get(sample.recordPath)!, async () => {
    described = true;
    return 'Wrong edit';
  });
  await f.io.remove(sample.recordPath);
  await menu.entries[0].click();
  assert.equal(described, false);
  assert.equal(f.errors.length, 1);
  assert.match(String(f.errors[0]), /no longer available/);
});

for (const missing of [false, true]) {
  test(`closed capture editor ${missing ? 'retains staging when its note is missing' : 'appends to its original note before clearing staging'}`, async () => {
    const f = fixture();
    await f.library.ready();
    await f.io.write('Original.md', '# Original\n');
    await f.io.write('Other.md', '# Other\n');
    const file = f.files.get('Original.md')!;
    const editor = {
      getCursor: () => ({line: 0, ch: 0}),
      posToOffset: () => 0,
      getRange: () => '',
    } as unknown as Editor;
    const anchors = new Map();
    let closed = false;
    let staleInsertions = 0;
    const view = {
      state: {
        // The host test runtime stubs editorInfoField as undefined.
        field: (field: unknown) => field === undefined ? {file, editor} : anchors,
        doc: {sliceString: () => ''},
      },
      dispatch: (transaction: {effects?: {value: {id?: string}}; changes?: unknown}) => {
        if (transaction.changes && closed) staleInsertions++;
        const anchor = transaction.effects?.value;
        if (anchor?.id) anchors.set(anchor.id, anchor);
      },
    } as unknown as EditorView;
    (f.notes as unknown as {editors: WeakMap<Editor, EditorView>}).editors.set(editor, view);
    f.leaves.push({view: {file, editor}});
    const target = f.notes.captureTarget(editor, file);
    const captures = f.workflow(async () => {
      closed = true;
      f.leaves.length = 0;
      if (missing) await f.io.remove(file.path);
      f.openEditor('Other.md');
      f.activate('Other.md');
      return 'Closed editor caption';
    });
    captures.capture([new File([PNG], 'sample.png', {type: 'image/png'})], target, 'file');
    await f.drain(captures);

    assert.equal(staleInsertions, 0);
    assert.equal(f.text.get('Other.md'), '# Other\n');
    const pending = await f.store.pendingCaptures();
    if (missing) {
      assert.equal(f.text.has('Original.md'), false);
      assert.match(String(f.errors[0]), /original note no longer exists/);
      assert.equal(pending.length, 1);
      assert.deepEqual(await f.io.readBinary(pending[0].dataPath), new Uint8Array(PNG));
    } else {
      assert.match(f.text.get('Original.md')!, /^# Original\n\n!\[Closed editor caption\]/);
      assert.deepEqual(f.errors, []);
      assert.deepEqual(pending, []);
    }
  });
}

test('initialization shares in-flight work but retries after a temporary failure', async () => {
  const f = fixture();
  let attempts = 0;
  const initialize = f.store.initialize.bind(f.store);
  f.store.initialize = async synchronize => {
    if (++attempts === 1) throw new Error('Temporary read failure');
    await initialize(synchronize);
  };
  const first = f.library.ready();
  assert.equal(f.library.ready(), first);
  await assert.rejects(first, /Temporary read failure/);
  await f.library.ready();
  await f.library.ready();
  assert.equal(attempts, 2);
});

test('recovery follows a note renamed during its description dialog before clearing staging', async () => {
  const f = fixture();
  await f.library.ready();
  await f.io.write('Original.md', '# Note\n');
  const pending = await f.store.stage({bytes: PNG, method: 'file'}, 'Original.md');
  const captures = f.workflow(async () => {
    const file = f.files.get('Original.md')!;
    const content = f.text.get('Original.md')!;
    f.files.delete('Original.md');
    f.text.delete('Original.md');
    file.path = 'Renamed.md';
    f.files.set(file.path, file);
    f.text.set(file.path, content);
    return 'Recovered after rename';
  });
  captures.recover();
  await f.drain(captures);
  const [saved] = f.store.allRecords();
  assert.match(f.text.get('Renamed.md')!, /!\[Recovered after rename\]/);
  assert.deepEqual(saved.sourceNotes, ['Renamed.md']);
  assert.equal(pending.storageFolder, '');
  assert.deepEqual(await f.store.pendingCaptures(), []);
  assert.deepEqual(f.errors, []);
});

test('capture shares one library scan with description reconciliation and duplicate lookup', async () => {
  const f = fixture();
  await f.library.ready();
  const prepared = await f.store.prepare(await f.store.stage({bytes: PNG, method: 'file'}, 'Original.md'));
  const sample = await f.store.describe(prepared, 'Original description');
  await f.store.complete(prepared.pending);
  const recordCount = 20;
  for (let index = 1; index < recordCount; index++) {
    const id = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
    const record = {
      ...sample, id,
      imagePath: `images/${id}.png`, recordPath: `image-records/${id}.md`, sidecarPath: `images/${id}.xmp`,
      sha256: index.toString(16).padStart(64, '0'),
    };
    await f.io.write(record.recordPath, serializeRecord(record));
  }
  await f.store.refresh();
  await f.io.write('Original.md', `![Original description](images/${sample.id}.png)`);
  f.text.set(sample.recordPath, f.text.get(sample.recordPath)!.replace('description: "Original description"', 'description: "Edited in Bases"'));
  const readsBefore = f.recordReads();
  const scansBefore = f.recordScans();
  let inserted: ImageRecord[] = [];
  const captures = f.workflow(async () => null);
  captures.capture([new File([PNG], 'sample.png', {type: 'image/png'})], {
    path: 'Other.md', insert: async records => { inserted = records; }, release: () => {},
  }, 'clipboard');
  await f.drain(captures);
  assert.equal(f.recordScans() - scansBefore, 1, 'Capture must share one full library scan');
  assert.ok(f.recordReads() - readsBefore <= recordCount + 4,
    'Only the captured record needs baseline and commit reads for reconciliation and description');
  assert.equal(inserted[0].description, 'Edited in Bases');
  assert.match(f.text.get('Original.md')!, /!\[Edited in Bases\]/);
  assert.deepEqual(f.errors, []);
});

test('editing a description preserves a source-note rename made while its dialog is open', async () => {
  const f = fixture();
  await f.library.ready();
  const prepared = await f.store.prepare(await f.store.stage({bytes: PNG, method: 'file'}, 'Original.md'));
  const sample = await f.store.describe(prepared, 'Original description');
  await f.io.write('Original.md', `![Original description](images/${sample.id}.png)`);
  f.activate(sample.recordPath);
  await f.library.editDescription(async () => {
    const file = f.files.get('Original.md')!;
    const content = f.text.get(file.path)!;
    f.files.delete(file.path);
    f.text.delete(file.path);
    file.path = 'Renamed.md';
    f.files.set(file.path, file);
    f.text.set(file.path, content);
    await f.library.rename(file, 'Original.md');
    return 'Chosen replacement';
  });
  const [saved] = f.store.allRecords();
  assert.deepEqual(saved.sourceNotes, ['Renamed.md']);
  assert.match(f.text.get('Renamed.md')!, /!\[Chosen replacement\]/);
  assert.deepEqual(f.errors, []);
});

for (const conflict of ['source notes', 'description', 'caption status'] as const) {
  test(`description save rebases over a concurrent ${conflict} edit`, async () => {
    const f = fixture();
    await f.library.ready();
    const prepared = await f.store.prepare(await f.store.stage({bytes: PNG, method: 'file'}, 'Original.md'));
    const sample = await f.store.describe(prepared, 'Original description');
    await f.io.write('Original.md', `![Original description](images/${sample.id}.png)`);
    f.activate(sample.recordPath);
    const process = f.io.process;
    let edited = false;
    f.io.process = async (path, update) => {
      if (path === sample.recordPath && !edited) {
        edited = true;
        const content = f.text.get(path)!;
        if (conflict === 'source notes') {
          f.text.set(path, serializeRecord({...sample, sourceNotes: ['Original.md', 'Added.md']}));
        } else if (conflict === 'description') {
          f.text.set(path, content.replace('description: "Original description"', 'description: "Newer saved description"'));
        } else {
          f.text.set(path, content.replace('caption_status: "confirmed"', 'caption_status: "pending"'));
        }
      }
      await process(path, update);
    };

    await f.library.editDescription(async () => 'Submitted description');

    assert.ok(edited, 'The conflicting edit must occur at the final record write boundary');
    const expectedDescription = conflict === 'source notes' ? 'Submitted description'
      : conflict === 'description' ? 'Newer saved description' : 'Original description';
    const saved = parseRecord(f.text.get(sample.recordPath)!)!;
    assert.equal(saved.description, expectedDescription);
    assert.equal(saved.captionStatus, conflict === 'caption status' ? 'pending' : 'confirmed');
    assert.deepEqual(saved.sourceNotes, conflict === 'source notes' ? ['Original.md', 'Added.md'] : ['Original.md']);
    assert.deepEqual(parseRecordSnapshot(f.text.get(sample.recordPath)!), saved);
    assert.match(f.text.get('Original.md')!, new RegExp(`!\\[${expectedDescription}\\]`));
    assert.match(f.text.get(sample.sidecarPath)!, new RegExp(expectedDescription));
    assert.deepEqual(f.store.allRecords(), [saved]);
    assert.deepEqual(f.errors, []);
  });
}

for (const openNote of [false, true]) {
  test(`caption retries preserve matching custom alt text in ${openNote ? 'an open editor' : 'a saved note'}`, async () => {
    const f = fixture();
    await f.library.ready();
    const prepared = await f.store.prepare(await f.store.stage({bytes: PNG, method: 'file'}, 'Original.md'));
    const sample = await f.store.describe(prepared, 'Original description');
    const target = `images/${sample.id}.png`;
    const original = [
      '# Before image sentinel',
      `![Original description](${target}) FIRST_GENERATED ![Submitted description](${target}) CUSTOM_SUBMITTED ![Original description](${target}) SECOND_GENERATED`,
      `![Newer saved description](${target}) CUSTOM_NEWER`,
      'Keep surrounding text.',
    ].join('\n');
    const added = `![Original description](${target}) ADDED_GENERATED ![Submitted description](${target}) ADDED_CUSTOM`;
    await f.io.write('Original.md', original);
    await f.io.write('Added.md', added);
    if (openNote) f.openEditor('Original.md');
    f.activate(sample.recordPath);
    const process = f.io.process;
    let edited = false;
    f.io.process = async (path, update) => {
      if (path === sample.recordPath && !edited) {
        edited = true;
        assert.equal(f.text.get('Original.md'), original.replaceAll('![Original description]', '![Submitted description]'));
        assert.equal(f.text.get('Added.md'), added);
        const content = serializeRecord({...sample, sourceNotes: ['Original.md', 'Added.md']});
        f.text.set(path, content.replace('description: "Original description"', 'description: "Newer saved description"'));
      }
      await process(path, update);
    };

    await f.library.editDescription(async () => 'Submitted description');

    assert.equal(edited, true);
    const saved = parseRecord(f.text.get(sample.recordPath)!)!;
    assert.equal(saved.description, 'Newer saved description');
    assert.deepEqual(saved.sourceNotes, ['Original.md', 'Added.md']);
    assert.equal(f.text.get('Original.md'), original.replaceAll('![Original description]', '![Newer saved description]'));
    assert.equal(f.text.get('Added.md'), added.replace('![Original description]', '![Newer saved description]'));
    assert.deepEqual(parseRecordSnapshot(f.text.get(sample.recordPath)!), saved);
    assert.match(f.text.get(sample.sidecarPath)!, /Newer saved description/);
    assert.deepEqual(f.store.allRecords(), [saved]);
    assert.deepEqual(f.errors, []);
  });
}

test('a caption retry tracks generated occurrences even when its first projection changes no text', async () => {
  const f = fixture();
  await f.library.ready();
  const prepared = await f.store.prepare(await f.store.stage({bytes: PNG, method: 'file'}, 'Original.md'));
  const sample = await f.store.describe(prepared, 'Original description');
  const original = `![Original description](images/${sample.id}.png) GENERATED\n![Newer description](images/${sample.id}.png) CUSTOM`;
  await f.io.write('Original.md', original);
  f.activate(sample.recordPath);
  const process = f.io.process;
  let edited = false;
  f.io.process = async (path, update) => {
    if (path === sample.recordPath && !edited) {
      edited = true;
      const content = f.text.get(path)!;
      f.text.set(path, content.replace('description: "Original description"', 'description: "Newer description"'));
    }
    await process(path, update);
  };

  await f.library.editDescription(async () => sample.description);

  assert.equal(edited, true);
  assert.equal(f.text.get('Original.md'), original.replace('![Original description]', '![Newer description]'));
  assert.equal(parseRecordSnapshot(f.text.get(sample.recordPath)!)!.description, 'Newer description');
  assert.deepEqual(f.errors, []);
});

test('a caption retry preserves a source note changed after its first projection', async () => {
  const f = fixture();
  await f.library.ready();
  const prepared = await f.store.prepare(await f.store.stage({bytes: PNG, method: 'file'}, 'Original.md'));
  const sample = await f.store.describe(prepared, 'Original description');
  await f.io.write('Original.md', `![Original description](images/${sample.id}.png)`);
  f.activate(sample.recordPath);
  const process = f.io.process;
  let preserved = '';
  f.io.process = async (path, update) => {
    if (path === sample.recordPath && !preserved) {
      preserved = f.text.get('Original.md')! + '\nNew user text, including an identical embed:\n' + f.text.get('Original.md')!;
      f.text.set('Original.md', preserved);
      const content = f.text.get(path)!;
      f.text.set(path, content.replace('description: "Original description"', 'description: "Newer description"'));
    }
    await process(path, update);
  };

  await f.library.editDescription(async () => 'Submitted description');

  assert.ok(preserved);
  assert.equal(f.text.get('Original.md'), preserved);
  assert.equal(parseRecord(f.text.get(sample.recordPath)!)!.description, 'Newer description');
  assert.equal(parseRecordSnapshot(f.text.get(sample.recordPath)!)!.description, sample.description);
  assert.equal(f.errors.length, 1);
  assert.match(String(f.errors[0]), /source note changed/);
});

for (const openAddedNote of [false, true]) {
  test(`a source note added during a save receives the current caption in ${openAddedNote ? 'an open editor' : 'a saved note'}`, async () => {
    const f = fixture();
    await f.library.ready();
    const prepared = await f.store.prepare(await f.store.stage({bytes: PNG, method: 'file'}, 'Original.md'));
    const sample = await f.store.describe(prepared, 'Original description');
    await f.io.write('Original.md', `![Original description](images/${sample.id}.png)`);
    const added = [
      '# Added note sentinel',
      `![Original description](images/${sample.id}.png) GENERATED_SENTINEL`,
      `![Custom caption](images/${sample.id}.png) CUSTOM_SENTINEL`,
      'Keep surrounding text.',
    ].join('\n');
    await f.io.write('Added.md', added);
    if (openAddedNote) f.openEditor('Added.md');
    f.activate(sample.recordPath);
    const process = f.io.process;
    let addedReference = false;
    f.io.process = async (path, update) => {
      if (path === sample.recordPath && !addedReference) {
        addedReference = true;
        f.text.set(path, serializeRecord({...sample, sourceNotes: ['Original.md', 'Added.md']}));
      }
      await process(path, update);
    };

    await f.library.editDescription(async () => 'Submitted description');

    assert.equal(addedReference, true);
    const saved = parseRecord(f.text.get(sample.recordPath)!)!;
    assert.equal(saved.description, 'Submitted description');
    assert.deepEqual(saved.sourceNotes, ['Original.md', 'Added.md']);
    assert.equal(f.text.get('Original.md'), `![Submitted description](images/${sample.id}.png)`);
    assert.equal(f.text.get('Added.md'), added.replace('![Original description]', '![Submitted description]'));
    assert.deepEqual(parseRecordSnapshot(f.text.get(sample.recordPath)!), saved);
    assert.match(f.text.get(sample.sidecarPath)!, /Submitted description/);
    assert.deepEqual(f.store.allRecords(), [saved]);
    assert.deepEqual(f.errors, []);
  });
}

test('a source note removed and readded across save conflicts keeps its last projected caption', async () => {
  const f = fixture();
  await f.library.ready();
  const prepared = await f.store.prepare(await f.store.stage({bytes: PNG, method: 'file'}, 'Original.md'));
  const sample = await f.store.describe(prepared, 'Original description');
  await f.io.write('Original.md', `![Original description](images/${sample.id}.png)`);
  await f.io.write('Added.md', `![Original description](images/${sample.id}.png) KEEP_SENTINEL`);
  f.activate(sample.recordPath);
  const process = f.io.process;
  let attempts = 0;
  f.io.process = async (path, update) => {
    if (path === sample.recordPath) {
      attempts++;
      if (attempts <= 3) {
        const sourceNotes = attempts === 2 ? ['Original.md'] : ['Original.md', 'Added.md'];
        const content = serializeRecord({...sample, sourceNotes});
        f.text.set(path, attempts === 1 ? content
          : content.replace('description: "Original description"', 'description: "Newer description"'));
      }
    }
    await process(path, update);
  };

  await f.library.editDescription(async () => 'Submitted description');

  assert.equal(attempts, 4);
  const saved = parseRecord(f.text.get(sample.recordPath)!)!;
  assert.equal(saved.description, 'Newer description');
  assert.deepEqual(saved.sourceNotes, ['Original.md', 'Added.md']);
  assert.equal(f.text.get('Original.md'), `![Newer description](images/${sample.id}.png)`);
  assert.equal(f.text.get('Added.md'), `![Newer description](images/${sample.id}.png) KEEP_SENTINEL`);
  assert.deepEqual(parseRecordSnapshot(f.text.get(sample.recordPath)!), saved);
  assert.match(f.text.get(sample.sidecarPath)!, /Newer description/);
  assert.deepEqual(f.store.allRecords(), [saved]);
  assert.deepEqual(f.errors, []);
});

for (const conflict of ['malformed', 'different image'] as const) {
  test(`description retry does not replace a ${conflict} current record`, async () => {
    const f = fixture();
    await f.library.ready();
    const prepared = await f.store.prepare(await f.store.stage({bytes: PNG, method: 'file'}, 'Original.md'));
    const sample = await f.store.describe(prepared, 'Original description');
    f.activate(sample.recordPath);
    const otherId = '00000000-0000-4000-8000-000000000001';
    const replacement = conflict === 'malformed' ? 'Malformed record retained for inspection' : serializeRecord({
      ...sample,
      id: otherId,
      imagePath: `images/${otherId}.png`,
      recordPath: `image-records/${otherId}.md`,
      sidecarPath: `images/${otherId}.xmp`,
    });
    const process = f.io.process;
    let edited = false;
    f.io.process = async (path, update) => {
      if (path === sample.recordPath && !edited) {
        edited = true;
        f.text.set(path, replacement);
      }
      await process(path, update);
    };

    await f.library.editDescription(async () => 'Submitted description');

    assert.ok(edited, 'The replacement must occur at the final record write boundary');
    assert.equal(f.text.get(sample.recordPath), replacement);
    assert.equal(f.errors.length, 1);
    assert.match(String(f.errors[0]), /record.*(?:changed|cannot be read)/i);
  });
}

test('an immediate source-note rename preserves newer Bases edits and unrelated record properties', async () => {
  const f = fixture();
  await f.library.ready();
  const prepared = await f.store.prepare(await f.store.stage({bytes: PNG, method: 'file'}, 'Original.md'));
  const sample = await f.store.describe(prepared, 'Description A');
  const updated = {
    ...sample,
    sourceName: 'Updated source.png',
    sourceNotes: ['Original.md', 'Added.md'],
    metadata: {...sample.metadata, raw: {reviewed: true}},
  };
  f.text.set(sample.recordPath, serializeRecord(updated).replace('description: "Description A"', 'description: "Description B"'));

  await f.library.rename({path: 'Renamed.md'}, 'Original.md');

  const content = f.text.get(sample.recordPath)!;
  const saved = parseRecord(content)!;
  assert.equal(saved.description, 'Description B');
  assert.deepEqual(saved.sourceNotes, ['Renamed.md', 'Added.md']);
  assert.equal(saved.sourceName, updated.sourceName);
  assert.deepEqual(saved.metadata, updated.metadata);
  assert.equal(parseRecordSnapshot(content)!.description, 'Description B');
  assert.deepEqual(f.store.allRecords(), [saved]);
  assert.match(f.text.get(sample.sidecarPath)!, /Description B/);
  assert.deepEqual(f.errors, []);
});

test('renaming a record folder reads the moved record before rewriting its paths', async () => {
  const f = fixture();
  await f.library.ready();
  const prepared = await f.store.prepare(await f.store.stage({bytes: PNG, method: 'file'}, 'Original.md'));
  const sample = await f.store.describe(prepared, 'Description A');
  await f.io.write('Original.md', `![Description A](images/${sample.id}.png)`);
  const movedPath = `Archive/${sample.recordPath}`;
  const file = f.files.get(sample.recordPath)!;
  f.text.set(movedPath, f.text.get(sample.recordPath)!.replace('description: "Description A"', 'description: "Description B"'));
  f.text.delete(sample.recordPath);
  f.files.delete(sample.recordPath);
  file.path = movedPath;
  f.files.set(movedPath, file);

  await f.library.rename({path: 'Archive/image-records'}, 'image-records');

  const content = f.text.get(movedPath)!;
  const saved = parseRecord(content)!;
  assert.equal(saved.description, 'Description B');
  assert.equal(saved.recordPath, movedPath);
  assert.equal(parseRecordSnapshot(content)!.recordPath, movedPath);
  assert.equal(f.text.has(sample.recordPath), false);
  assert.match(f.text.get('Original.md')!, /!\[Description B\]/);
  assert.deepEqual(f.store.allRecords(), [saved]);
});

test('a failed reconciliation does not block later queued work', async () => {
  const f = fixture();
  await f.library.ready();
  const prepared = await f.store.prepare(await f.store.stage({bytes: PNG, method: 'file'}, 'Original.md'));
  const sample = await f.store.describe(prepared, 'Description A');
  await f.io.write('Original.md', `![Description A](images/${sample.id}.png)`);
  f.text.set(sample.recordPath, f.text.get(sample.recordPath)!.replace('description: "Description A"', 'description: "Description B"'));
  const updateEmbeds = f.notes.updateEmbeds.bind(f.notes);
  f.notes.updateEmbeds = async () => { throw new Error('Temporary note failure'); };
  await assert.rejects(f.library.reconcileAll(), /Temporary note failure/);
  f.notes.updateEmbeds = updateEmbeds;

  await f.library.reconcileAll();

  assert.equal(parseRecordSnapshot(f.text.get(sample.recordPath)!)!.description, 'Description B');
  assert.match(f.text.get('Original.md')!, /!\[Description B\]/);
});

test('delayed reconciliation cannot replace a newer saved description or record properties', async () => {
  const f = fixture();
  await f.library.ready();
  const prepared = await f.store.prepare(await f.store.stage({bytes: PNG, method: 'file'}, 'Original.md'));
  const sample = await f.store.describe(prepared, 'Original description');
  await f.io.write('Original.md', `![Original description](images/${sample.id}.png)`);
  f.text.set(sample.recordPath, f.text.get(sample.recordPath)!.replace('description: "Original description"', 'description: "Description A"'));
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  const updateEmbeds = f.notes.updateEmbeds.bind(f.notes);
  let blocked = false;
  f.notes.updateEmbeds = async (previous, next, journal) => {
    await updateEmbeds(previous, next, journal);
    if (next.description === 'Description A' && !blocked) {
      blocked = true;
      enter();
      await released;
    }
  };
  const older = f.library.reconcileAll();
  await entered;
  const latest = {
    ...sample,
    sourceName: 'Latest source.png',
    sourceNotes: ['Original.md', 'Added.md'],
    metadata: {...sample.metadata, raw: {editedWhileReconciling: true}},
  };
  f.text.set(sample.recordPath, serializeRecord(latest).replace('description: "Original description"', 'description: "Description B"'));
  const newer = f.library.reconcileAll();
  release();
  await Promise.all([older, newer]);

  const content = f.text.get(sample.recordPath)!;
  const saved = parseRecord(content)!;
  assert.equal(saved.description, 'Description B');
  assert.deepEqual(saved.sourceNotes, latest.sourceNotes);
  assert.equal(saved.sourceName, latest.sourceName);
  assert.deepEqual(saved.metadata, latest.metadata);
  assert.equal(parseRecordSnapshot(content)!.description, 'Description B');
  assert.match(f.text.get('Original.md')!, /!\[Description B\]/);
  assert.match(f.text.get(sample.sidecarPath)!, /Description B/);
  assert.deepEqual(f.store.allRecords(), [saved]);
  assert.deepEqual(f.errors, []);
});

test('reconciliation preserves an edit saved immediately before its record write', async () => {
  const f = fixture();
  await f.library.ready();
  const prepared = await f.store.prepare(await f.store.stage({bytes: PNG, method: 'file'}, 'Original.md'));
  const sample = await f.store.describe(prepared, 'Original description');
  await f.io.write('Original.md', `![Original description](images/${sample.id}.png)`);
  f.text.set(sample.recordPath, f.text.get(sample.recordPath)!.replace('description: "Original description"', 'description: "Description A"'));
  const process = f.io.process;
  let edited = false;
  f.io.process = async (path, update) => {
    if (path === sample.recordPath && !edited) {
      edited = true;
      const content = f.text.get(path)!;
      f.text.set(path, content.replace('description: "Description A"', 'description: "Description B"'));
    }
    await process(path, update);
  };

  await f.library.reconcileAll();

  assert.ok(edited, 'The test must edit the record at the final write boundary');
  const content = f.text.get(sample.recordPath)!;
  const saved = parseRecord(content)!;
  assert.equal(saved.description, 'Description B');
  assert.equal(parseRecordSnapshot(content)!.description, 'Description B');
  assert.match(f.text.get('Original.md')!, /!\[Description B\]/);
  assert.match(f.text.get(sample.sidecarPath)!, /Description B/);
  assert.deepEqual(f.store.allRecords(), [saved]);
  assert.deepEqual(f.errors, []);
});

async function interruptedSaveFixture() {
  const f = fixture();
  await f.library.ready();
  const first = await f.store.prepare(await f.store.stage({bytes: PNG, method: 'file'}, 'Original.md'));
  await f.store.describe(first, 'Original description');
  await f.store.complete(first.pending);
  const duplicate = await f.store.prepare(await f.store.stage({bytes: PNG, method: 'file'}, 'Added.md'));
  const sample = await f.store.describe(duplicate, null);
  await f.store.complete(duplicate.pending);
  const originals = new Map<string, string>();
  for (const sourcePath of sample.sourceNotes) {
    const content = [
      `# ${sourcePath} sentinel`,
      `![Original description](images/${sample.id}.png) FIRST_GENERATED`,
      `![Submitted description](images/${sample.id}.png) CUSTOM_SUBMITTED`,
      `![Original description](images/${sample.id}.png) SECOND_GENERATED`,
      'Keep surrounding text.',
    ].join('\n');
    originals.set(sourcePath, content);
    await f.io.write(sourcePath, content);
  }
  f.activate(sample.recordPath);
  return {f, sample, originals};
}

function moveSavedRecord(f: ReturnType<typeof fixture>, from: string, to: string) {
  const file = f.files.get(from)!;
  f.text.set(to, f.text.get(from)!);
  f.text.delete(from);
  f.files.delete(from);
  file.path = to;
  f.files.set(to, file);
}

async function assertRecovered(
  f: ReturnType<typeof fixture>,
  expected: ImageRecord,
  originals: Map<string, string>,
) {
  const content = f.text.get(expected.recordPath)!;
  assert.deepEqual(parseRecord(content), expected);
  assert.deepEqual(parseRecordSnapshot(content), expected);
  assert.equal(f.text.get(expected.sidecarPath), serializeSidecar(expected));
  assert.deepEqual(f.store.allRecords(), [expected]);
  assert.deepEqual(new Uint8Array(await f.io.readBinary(expected.imagePath)), new Uint8Array(PNG));
  for (const [sourcePath, original] of originals) {
    assert.equal(f.text.get(sourcePath), original.replaceAll('![Original description]', `![${expected.description}]`));
  }
  assert.deepEqual(await f.io.operationPaths(), []);
  assert.deepEqual(f.errors, []);
}

test('restart resumes a partially saved description after an interrupted record-folder rename', async () => {
  const {f, sample, originals} = await interruptedSaveFixture();
  const process = f.io.process;
  let failure = new Error('First note save interruption');
  f.io.process = async (path, update) => {
    if (path === 'Added.md') throw failure;
    await process(path, update);
  };
  await f.library.editDescription(async () => 'Submitted description');
  assert.deepEqual(f.errors, [failure]);
  assert.equal(f.text.get('Original.md'), originals.get('Original.md')!
    .replaceAll('![Original description]', '![Submitted description]'));
  const movedPath = `Archive/${sample.recordPath}`;
  moveSavedRecord(f, sample.recordPath, movedPath);
  failure = new Error('Rename recovery interruption');

  await assert.rejects(f.library.rename({path: 'Archive/image-records'}, 'image-records'), /Rename recovery interruption/);

  const [receipt] = await f.io.operationPaths();
  assert.ok(receipt);
  assert.equal((JSON.parse(f.text.get(receipt)!) as RecordOperation).recordPath, movedPath);
  for (let restart = 0; restart < 2; restart++) {
    const resumed = fixture(f.persisted);
    await resumed.library.ready();
    await assertRecovered(resumed, {...sample, description: 'Submitted description', recordPath: movedPath}, originals);
    assert.equal(resumed.text.has(sample.recordPath), false);
    assert.deepEqual(await resumed.io.recordPaths(), [movedPath]);
  }
});

test('record-folder rename preserves completed-save evidence and a newer offline caption revert', async () => {
  const {f, sample, originals} = await interruptedSaveFixture();
  const remove = f.io.remove;
  const failure = new Error('Receipt cleanup interruption');
  f.io.remove = async path => {
    if (path.startsWith('.image-ledger/operations/')) throw failure;
    await remove(path);
  };
  await f.library.editDescription(async () => 'Submitted description');
  assert.deepEqual(f.errors, [failure]);
  const committed = f.text.get(sample.recordPath)!;
  assert.equal(parseRecordSnapshot(committed)!.description, 'Submitted description');
  f.text.set(sample.recordPath, committed.replace('description: "Submitted description"', 'description: "Original description"'));
  const movedPath = `Archive/${sample.recordPath}`;
  moveSavedRecord(f, sample.recordPath, movedPath);
  f.io.remove = remove;
  const process = f.io.process;
  f.io.process = async (path, update) => {
    if (path === 'Added.md') throw new Error('Rename recovery interruption');
    await process(path, update);
  };

  await assert.rejects(f.library.rename({path: 'Archive/image-records'}, 'image-records'), /Rename recovery interruption/);

  assert.equal((await f.io.operationPaths()).length, 1);
  assert.equal(parseRecordSnapshot(f.text.get(movedPath)!)!.recordPath, sample.recordPath);
  for (let restart = 0; restart < 2; restart++) {
    const resumed = fixture(f.persisted);
    await resumed.library.ready();
    await assertRecovered(resumed, {...sample, recordPath: movedPath}, originals);
    assert.equal(resumed.text.has(sample.recordPath), false);
    assert.deepEqual(await resumed.io.recordPaths(), [movedPath]);
  }
});

test('startup finds the uniquely matching moved record before its rename handler runs', async () => {
  const {f, sample, originals} = await interruptedSaveFixture();
  const process = f.io.process;
  f.io.process = async (path, update) => {
    if (path === 'Added.md') throw new Error('First note save interruption');
    await process(path, update);
  };
  await f.library.editDescription(async () => 'Submitted description');
  assert.equal(f.errors.length, 1);
  const movedPath = `Archive/${sample.recordPath}`;
  moveSavedRecord(f, sample.recordPath, movedPath);
  const [receipt] = await f.io.operationPaths();
  assert.equal((JSON.parse(f.text.get(receipt)!) as RecordOperation).recordPath, sample.recordPath);

  for (let restart = 0; restart < 2; restart++) {
    const resumed = fixture(f.persisted);
    await resumed.library.ready();
    await assertRecovered(resumed, {...sample, description: 'Submitted description', recordPath: movedPath}, originals);
    assert.equal(resumed.text.has(sample.recordPath), false);
    assert.deepEqual(await resumed.io.recordPaths(), [movedPath]);
  }
});

test('startup recovers a moved record without a pending save when its rename handler never ran', async () => {
  const {f, sample, originals} = await interruptedSaveFixture();
  const movedPath = `Archive/${sample.recordPath}`;
  moveSavedRecord(f, sample.recordPath, movedPath);
  assert.deepEqual(await f.io.operationPaths(), []);

  const resumed = fixture(f.persisted);
  await resumed.library.ready();

  await assertRecovered(resumed, {...sample, recordPath: movedPath}, originals);
  assert.equal(resumed.text.has(sample.recordPath), false);
});

test('startup refuses ambiguous moved-record identities and retains all recovery data unchanged', async () => {
  const {f, sample} = await interruptedSaveFixture();
  const process = f.io.process;
  f.io.process = async (path, update) => {
    if (path === 'Added.md') throw new Error('First note save interruption');
    await process(path, update);
  };
  await f.library.editDescription(async () => 'Submitted description');
  assert.equal(f.errors.length, 1);
  const movedPath = `Archive/${sample.recordPath}`;
  moveSavedRecord(f, sample.recordPath, movedPath);
  await f.io.write(`Copy/${sample.recordPath}`, f.text.get(movedPath)!);
  const unchanged = new Map(f.text);
  const resumed = fixture(f.persisted);
  const writes: string[] = [];
  resumed.io.write = async path => { writes.push(path); };
  resumed.io.process = async path => { writes.push(path); };

  await assert.rejects(resumed.library.ready(), /ambiguous|multiple|more than one/i);

  assert.deepEqual(writes, []);
  assert.deepEqual(resumed.text, unchanged);
  assert.equal(resumed.text.has(sample.recordPath), false);
  assert.equal((await resumed.io.operationPaths()).length, 1);
});

for (const malformed of ['path traversal', 'discovered path traversal', 'projection gap', 'overlapping ranges', 'wrong id'] as const) {
  test(`startup retains a receipt with ${malformed} before writing any projection`, async () => {
    const {f} = await interruptedSaveFixture();
    const process = f.io.process;
    f.io.process = async (path, update) => {
      if (path === 'Original.md') throw new Error('Stop before the first note write');
      await process(path, update);
    };
    await f.library.editDescription(async () => 'Submitted description');
    assert.equal(f.errors.length, 1);
    const [receipt] = await f.io.operationPaths();
    assert.ok(receipt);
    const operation = JSON.parse(f.text.get(receipt)!) as RecordOperation;
    const plan = operation.notes['Original.md'];
    assert.ok(plan);
    if (malformed === 'path traversal') {
      operation.notes['../Outside.md'] = plan;
    } else if (malformed === 'discovered path traversal') {
      operation.discoveredNotes = ['../Outside.md'];
    } else if (malformed === 'projection gap') {
      plan.after = plan.after.replace('Keep surrounding text.', 'Changed outside the generated embeds.');
    } else if (malformed === 'overlapping ranges') {
      plan.ranges[1].from = plan.ranges[0].from;
    } else {
      operation.baseline.id = '00000000-0000-4000-8000-000000000001';
    }
    const damaged = JSON.stringify(operation, null, 2);
    f.text.set(receipt, damaged);
    const unchanged = new Map(f.text);
    const resumed = fixture(f.persisted);
    const writes: string[] = [];
    resumed.io.write = async path => { writes.push(path); };
    resumed.io.process = async path => { writes.push(path); };

    await assert.rejects(resumed.library.ready(), /Invalid image save recovery receipt/);

    assert.deepEqual(writes, []);
    assert.equal(resumed.text.get(receipt), damaged);
    assert.deepEqual(resumed.text, unchanged);
    assert.deepEqual(await resumed.io.operationPaths(), [receipt]);
  });
}

test('a failed first projection checkpoint preserves all notes and restarts from the durable intent', async () => {
  const {f, sample, originals} = await interruptedSaveFixture();
  const write = f.io.write;
  const failure = new Error('Receipt checkpoint unavailable');
  f.io.write = async (path, content) => {
    if (path.startsWith('.image-ledger/operations/')) {
      const operation = JSON.parse(content) as RecordOperation;
      if (Object.keys(operation.notes).length) throw failure;
    }
    await write(path, content);
  };

  await f.library.editDescription(async () => 'Submitted description');

  assert.deepEqual(f.errors, [failure]);
  for (const [path, content] of originals) assert.equal(f.text.get(path), content);
  assert.deepEqual(parseRecord(f.text.get(sample.recordPath)!), sample);
  assert.deepEqual(parseRecordSnapshot(f.text.get(sample.recordPath)!), sample);
  assert.equal(f.text.get(sample.sidecarPath), serializeSidecar(sample));
  const [receipt] = await f.io.operationPaths();
  const operation = JSON.parse(f.text.get(receipt)!) as RecordOperation;
  assert.deepEqual(operation.notes, {});
  assert.deepEqual(operation.intent, {kind: 'description', description: 'Submitted description'});
  const resumed = fixture(f.persisted);
  await resumed.library.ready();
  await assertRecovered(resumed, {...sample, description: 'Submitted description'}, originals);
});

test('a failed retry checkpoint keeps the earlier durable occurrence plan usable after restart', async () => {
  const {f, sample, originals} = await interruptedSaveFixture();
  const process = f.io.process;
  const write = f.io.write;
  const failure = new Error('Revised receipt checkpoint unavailable');
  let edited = false;
  let durableReceipt = '';
  f.io.process = async (path, update) => {
    if (path === sample.recordPath && !edited) {
      edited = true;
      const content = f.text.get(path)!;
      f.text.set(path, content.replace('description: "Original description"', 'description: "Newer retry description"'));
    }
    await process(path, update);
  };
  f.io.write = async (path, content) => {
    if (path.startsWith('.image-ledger/operations/')) {
      const operation = JSON.parse(content) as RecordOperation;
      if (operation.notes['Original.md']?.after.includes('![Newer retry description]')) {
        durableReceipt = f.text.get(path)!;
        throw failure;
      }
    }
    await write(path, content);
  };

  await f.library.editDescription(async () => 'Submitted description');

  assert.equal(edited, true);
  assert.deepEqual(f.errors, [failure]);
  const [receipt] = await f.io.operationPaths();
  assert.ok(durableReceipt);
  assert.equal(f.text.get(receipt), durableReceipt);
  for (const [path, content] of originals) {
    assert.equal(f.text.get(path), content.replaceAll('![Original description]', '![Submitted description]'));
  }
  const resumed = fixture(f.persisted);
  await resumed.library.ready();
  await assertRecovered(resumed, {...sample, description: 'Newer retry description'}, originals);
});

for (const boundary of ['first note saved', 'sidecar written', 'record committed', 'receipt cleanup'] as const) {
  test(`restart completes a description save interrupted after ${boundary}`, async () => {
    const {f, sample, originals} = await interruptedSaveFixture();
    const failure = new Error(`Interrupted after ${boundary}`);
    const process = f.io.process;
    const write = f.io.write;
    const remove = f.io.remove;
    let failed = false;
    const fail = () => {
      failed = true;
      throw failure;
    };
    f.io.process = async (path, update) => {
      if (path === 'Original.md') {
        assert.equal((await f.io.operationPaths()).length, 1, 'Persist the operation before changing a note');
      }
      if (!failed && boundary === 'first note saved' && path === 'Added.md') fail();
      await process(path, update);
      if (!failed && boundary === 'record committed' && path === sample.recordPath) fail();
    };
    f.io.write = async (path, content) => {
      await write(path, content);
      if (!failed && boundary === 'sidecar written' && path === sample.sidecarPath) fail();
    };
    f.io.remove = async path => {
      if (!failed && boundary === 'receipt cleanup' && path.startsWith('.image-ledger/operations/')) fail();
      await remove(path);
    };

    await f.library.editDescription(async () => 'Submitted description');

    assert.equal(failed, true);
    assert.deepEqual(f.errors, [failure]);
    assert.equal((await f.io.operationPaths()).length, 1);
    assert.equal(f.text.get('Original.md'), originals.get('Original.md')!.replaceAll('![Original description]', '![Submitted description]'));
    if (boundary === 'first note saved') assert.equal(f.text.get('Added.md'), originals.get('Added.md'));
    for (let restart = 0; restart < 2; restart++) {
      const resumed = fixture(f.persisted);
      await resumed.library.ready();
      await resumed.library.reconcileAll();
      await assertRecovered(resumed, {...sample, description: 'Submitted description'}, originals);
    }
  });
}

for (const boundary of ['record committed', 'receipt cleanup'] as const) {
  test(`restart preserves an offline caption revert after ${boundary}`, async () => {
    const {f, sample, originals} = await interruptedSaveFixture();
    const failure = new Error(`Interrupted after ${boundary}`);
    const process = f.io.process;
    const remove = f.io.remove;
    f.io.process = async (path, update) => {
      await process(path, update);
      if (boundary === 'record committed' && path === sample.recordPath) throw failure;
    };
    f.io.remove = async path => {
      if (boundary === 'receipt cleanup' && path.startsWith('.image-ledger/operations/')) throw failure;
      await remove(path);
    };
    await f.library.editDescription(async () => 'Submitted description');
    assert.deepEqual(f.errors, [failure]);
    assert.equal((await f.io.operationPaths()).length, 1);
    const committed = f.text.get(sample.recordPath)!;
    assert.equal(parseRecordSnapshot(committed)!.description, 'Submitted description');
    f.text.set(sample.recordPath, committed
      .replace('description: "Submitted description"', 'description: "Original description"')
      .replace('  - "[[Added]]"\n', ''));
    const expected = {...sample, sourceNotes: ['Original.md']};
    assert.deepEqual(parseRecord(f.text.get(sample.recordPath)!), expected);
    const removedNote = f.text.get('Added.md');

    for (let restart = 0; restart < 2; restart++) {
      const resumed = fixture(f.persisted);
      await resumed.library.ready();
      await assertRecovered(resumed, expected, new Map([['Original.md', originals.get('Original.md')!]]));
      assert.equal(resumed.text.get('Added.md'), removedNote, 'Recovery must not change a removed source note');
    }
  });
}

test('restart preserves a newer Bases description saved while its operation was interrupted', async () => {
  const {f, sample, originals} = await interruptedSaveFixture();
  const process = f.io.process;
  f.io.process = async (path, update) => {
    if (path === 'Added.md') throw new Error('Second note unavailable');
    await process(path, update);
  };
  await f.library.editDescription(async () => 'Submitted description');
  assert.equal(f.errors.length, 1);
  const content = f.text.get(sample.recordPath)!;
  f.text.set(sample.recordPath, content.replace('description: "Original description"', 'description: "Newer offline description"'));

  for (let restart = 0; restart < 2; restart++) {
    const resumed = fixture(f.persisted);
    await resumed.library.ready();
    await assertRecovered(resumed, {...sample, description: 'Newer offline description'}, originals);
  }
});

test('a twice-interrupted capture save preserves a newer caption revert and its added source reference', async () => {
  const {f, sample, originals} = await interruptedSaveFixture();
  await f.io.write('Capture.md', '# Capture sentinel\n');
  const pending = await f.store.stage({bytes: PNG, method: 'file'}, 'Capture.md');
  const prepared = await f.library.prepare(pending);
  const process = f.io.process;
  f.io.process = async (path, update) => {
    if (path === 'Added.md') throw new Error('First interruption');
    await process(path, update);
  };
  await assert.rejects(f.store.describe(prepared, 'Submitted description', 'Capture.md',
    (previous, next, journal) => f.notes.updateEmbeds(previous, next, journal)), /First interruption/);
  assert.equal(f.text.get('Original.md'), originals.get('Original.md')!
    .replaceAll('![Original description]', '![Submitted description]'));
  const originalRecord = f.text.get(sample.recordPath)!;
  f.text.set(sample.recordPath, originalRecord
    .replace('description: "Original description"', 'description: "Newer observed description"'));

  const firstRestart = fixture(f.persisted);
  const resumedProcess = firstRestart.io.process;
  firstRestart.io.process = async (path, update) => {
    if (path === 'Added.md') throw new Error('Second interruption');
    await resumedProcess(path, update);
  };
  await assert.rejects(firstRestart.library.ready(), /Second interruption/);
  const [receipt] = await firstRestart.io.operationPaths();
  const operation = JSON.parse(firstRestart.text.get(receipt)!) as RecordOperation;
  assert.equal(operation.target?.description, 'Newer observed description');
  assert.deepEqual(operation.intent, {
    kind: 'description', description: null, source: {from: 'Capture.md', to: 'Capture.md'},
  });
  assert.equal(parseRecordSnapshot(firstRestart.text.get(sample.recordPath)!)!.description, 'Original description');
  assert.equal(firstRestart.text.get('Original.md'), originals.get('Original.md')!
    .replaceAll('![Original description]', '![Newer observed description]'));
  firstRestart.text.set(sample.recordPath, firstRestart.text.get(sample.recordPath)!
    .replace('description: "Newer observed description"', 'description: "Original description"'));

  const secondRestart = fixture(f.persisted);
  await secondRestart.library.ready();
  const expected = {...sample, sourceNotes: [...sample.sourceNotes, 'Capture.md']};
  await assertRecovered(secondRestart, expected, originals);
  const recovery = secondRestart.workflow(async () => null);
  recovery.recover();
  await secondRestart.drain(recovery);
  await assertRecovered(secondRestart, expected, originals);
  assert.match(secondRestart.text.get('Capture.md')!, /!\[Original description\]/);
  assert.deepEqual(await secondRestart.store.pendingCaptures(), []);
});

test('restart and a Bases retry preserve custom captions equal to the submitted description', async () => {
  const {f, sample, originals} = await interruptedSaveFixture();
  const process = f.io.process;
  f.io.process = async (path, update) => {
    if (path === 'Added.md') throw new Error('Second note unavailable');
    await process(path, update);
  };
  await f.library.editDescription(async () => 'Submitted description');
  assert.equal(f.errors.length, 1);
  const resumed = fixture(f.persisted);
  const resumedProcess = resumed.io.process;
  let edited = false;
  resumed.io.process = async (path, update) => {
    if (path === sample.recordPath && !edited) {
      edited = true;
      const content = resumed.text.get(path)!;
      resumed.text.set(path, content.replace('description: "Original description"', 'description: "Newer retry description"'));
    }
    await resumedProcess(path, update);
  };

  await resumed.library.ready();

  assert.equal(edited, true);
  const expected = {...sample, description: 'Newer retry description'};
  await assertRecovered(resumed, expected, originals);
  const secondRestart = fixture(f.persisted);
  await secondRestart.library.ready();
  await assertRecovered(secondRestart, expected, originals);
});

test('restart retains divergent note text and its receipt for repeated safe recovery attempts', async () => {
  const {f, sample, originals} = await interruptedSaveFixture();
  const process = f.io.process;
  f.io.process = async (path, update) => {
    if (path === 'Added.md') throw new Error('Second note unavailable');
    await process(path, update);
  };
  await f.library.editDescription(async () => 'Submitted description');
  assert.equal(f.errors.length, 1);
  const divergent = f.text.get('Original.md')! + '\nUser added this while the plugin was stopped.';
  f.text.set('Original.md', divergent);

  for (let restart = 0; restart < 2; restart++) {
    const resumed = fixture(f.persisted);
    await assert.rejects(resumed.library.ready(), /source note changed/i);
    assert.equal(resumed.text.get('Original.md'), divergent);
    assert.equal(resumed.text.get('Added.md'), originals.get('Added.md'));
    assert.deepEqual(parseRecord(resumed.text.get(sample.recordPath)!), sample);
    assert.equal((await resumed.io.operationPaths()).length, 1);
  }
});

test('capture recovery replays a partial caption save before inserting and clearing its staged image', async () => {
  const {f, sample, originals} = await interruptedSaveFixture();
  await f.io.write('Capture.md', '# Capture sentinel\n');
  const process = f.io.process;
  f.io.process = async (path, update) => {
    if (path === 'Added.md') throw new Error('Second note unavailable');
    await process(path, update);
  };
  const captures = f.workflow(async () => 'Submitted description');
  let inserted = false;
  captures.capture([new File([PNG], 'duplicate.png', {type: 'image/png'})], {
    path: 'Capture.md',
    insert: async () => { inserted = true; },
    release: () => {},
  }, 'file');
  await f.drain(captures);
  assert.equal(f.errors.length, 1);
  assert.equal(inserted, false);
  const [pending] = await f.store.pendingCaptures();
  assert.ok(pending);
  assert.deepEqual(await f.io.readBinary(pending.dataPath), new Uint8Array(PNG));
  assert.equal((await f.io.operationPaths()).length, 1);

  for (let restart = 0; restart < 2; restart++) {
    const resumed = fixture(f.persisted);
    const recovery = resumed.workflow(async () => null);
    recovery.recover();
    await resumed.drain(recovery);
    const expected = {...sample, description: 'Submitted description', sourceNotes: [...sample.sourceNotes, 'Capture.md']};
    await assertRecovered(resumed, expected, originals);
    const insertedContent = resumed.text.get('Capture.md')!;
    assert.match(insertedContent, /^# Capture sentinel\n/);
    assert.equal(insertedContent.split(`![Submitted description](images/${sample.id}.png)`).length - 1, 1);
    assert.deepEqual(await resumed.store.pendingCaptures(), []);
    assert.equal(await resumed.io.exists(pending.dataPath), false);
    assert.equal(await resumed.io.exists(pending.transactionPath), false);
  }
});

const parenthesisFolders = [
  {path: 'Photos (draft)', legacy: 'Photos%20(draft)', canonical: 'Photos%20%28draft%29'},
  {path: 'Photos %28draft%29 (real)', legacy: 'Photos%20%2528draft%2529%20(real)', canonical: 'Photos%20%2528draft%2529%20%28real%29'},
];

for (const editingOpenNote of [false, true]) {
  test(`caption updates match both parenthesis URL forms in ${editingOpenNote ? 'open editors' : 'saved notes'}`, async () => {
    for (const folder of parenthesisFolders) {
      const f = fixture();
      await f.library.ready();
      const prepared = await f.store.prepare(await f.store.stage({bytes: PNG, method: 'file'}, 'Original.md'));
      const sample = await f.store.describe(prepared, 'Old %28literal%29 caption');
      const previous = {...sample, imagePath: `${folder.path}/images/${sample.id}.png`};
      const next = {...previous, description: 'New %28literal%29 $& $1 $$ caption'};
      const legacy = `${folder.legacy}/images/${sample.id}.png`;
      const canonical = `${folder.canonical}/images/${sample.id}.png`;
      const custom = [
        `![Custom %28label%29](${legacy}) CUSTOM_LEGACY_SENTINEL`,
        `![Custom %28label%29](${canonical}) CUSTOM_CANONICAL_SENTINEL`,
        `![Old (literal) caption](${legacy}) DECODED_ALT_SENTINEL`,
      ];
      await f.io.write('Original.md', [
        `![Old %28literal%29 caption](${legacy}) FIRST_SENTINEL`,
        `![Old %28literal%29 caption](${canonical}) SECOND_SENTINEL`,
        `![Old %28literal%29 caption](${legacy}) THIRD_SENTINEL`,
        ...custom,
      ].join('\n'));
      if (editingOpenNote) f.openEditor('Original.md');

      await f.notes.updateEmbeds(previous, next);

      assert.equal(f.text.get('Original.md'), [
        `![New %28literal%29 $& $1 $$ caption](${canonical}) FIRST_SENTINEL`,
        `![New %28literal%29 $& $1 $$ caption](${canonical}) SECOND_SENTINEL`,
        `![New %28literal%29 $& $1 $$ caption](${canonical}) THIRD_SENTINEL`,
        ...custom,
      ].join('\n'));
      assert.deepEqual(f.errors, []);
    }
  });
}

test('recovery preserves existing images with either parenthesis URL form and custom alt text', async () => {
  for (const folder of parenthesisFolders) {
    for (const encoding of ['legacy', 'canonical'] as const) {
      for (const alt of ['Old %28literal%29 caption', 'Custom %28label%29']) {
        const f = fixture();
        await f.library.ready();
        const prepared = await f.store.prepare(await f.store.stage({bytes: PNG, method: 'file'}, 'Original.md'));
        const sample = await f.store.describe(prepared, 'Old %28literal%29 caption');
        const record = {...sample, imagePath: `${folder.path}/images/${sample.id}.png`};
        const existing = `![${alt}](${folder[encoding]}/images/${sample.id}.png) KEEP_THIS_SENTINEL`;
        await f.io.write('Original.md', existing);

        await f.notes.recover(record, 'Original.md');

        assert.equal(f.text.get('Original.md'), existing);
        assert.deepEqual(f.errors, []);
      }
    }
  }
});


test('Bases description saves discover copied references and report custom, wiki and missing notes', async () => {
  const f = fixture();
  await f.library.ready();
  const prepared = await f.store.prepare(await f.store.stage({bytes: PNG, method: 'file'}, 'Original.md'));
  const sample = await f.store.describe(prepared, 'Old');
  const embed = `![Old](${sample.imagePath})`;
  await f.io.write('Original.md', embed + `\n![Custom](${sample.imagePath})`);
  await f.io.write('Copy.md', embed);
  await f.io.write('Wiki.md', `![[${sample.imagePath}]]`);
  f.resolvedLinks[sample.recordPath] = {[sample.imagePath]: 1};
  f.resolvedLinks['Copy.md'] = {[sample.imagePath]: 1};
  f.resolvedLinks['Wiki.md'] = {[sample.imagePath]: 1};
  f.cachedEmbeds['Wiki.md'] = [{original: `![[${sample.imagePath}]]`, link: sample.imagePath}];
  await f.io.write(sample.recordPath, serializeRecord({...sample, sourceNotes: ['Original.md', 'Missing.md']})
    .replace('description: "Old"', 'description: "New longer"'));
  const reports: ReturnType<typeof f.notes.saveReport>[] = [];
  const saveReport = f.notes.saveReport.bind(f.notes);
  f.notes.saveReport = (journal, record) => {
    const result = saveReport(journal, record);
    reports.push(result);
    return result;
  };
  await f.library.reconcileAll();
  assert.equal(f.text.get('Copy.md'), `![New longer](${sample.imagePath})`);
  assert.equal(f.text.get('Original.md'), `![New longer](${sample.imagePath})\n![Custom](${sample.imagePath})`);
  assert.equal(f.text.get('Wiki.md'), `![[${sample.imagePath}]]`);
  assert.deepEqual(parseRecord(f.text.get(sample.recordPath)!)!.sourceNotes, ['Original.md', 'Missing.md', 'Copy.md', 'Wiki.md']);
  assert.equal(reports.at(-1)!.skipped[0].from, `![New longer](${sample.imagePath})\n`.length);
  assert.equal(reports.at(-1)!.updated, 2);
  assert.equal(reports.at(-1)!.notes, 2);
  assert.deepEqual(reports.at(-1)!.skipped.map(item => item.reason), [
    'Customized alt text or non-generated Markdown form', 'Missing source note', 'Wiki embed: no alt text',
  ]);
});

for (const explicit of [false, true]) {
  test(`custom alt overwrite requires ${explicit ? 'an exact reviewed occurrence' : 'the opt-in setting'}`, async () => {
    const f = fixture();
    await f.library.ready();
    const prepared = await f.store.prepare(await f.store.stage({bytes: PNG, method: 'file'}, 'Original.md'));
    const sample = await f.store.describe(prepared, 'Old');
    const custom = `![Custom](${sample.imagePath})`;
    await f.io.write('Original.md', `${custom}\n${custom}\n\`${custom}\``);
    f.settings.syncCustomAlt = !explicit;
    const selection = explicit ? {path: 'Original.md', from: 0, text: custom, reason: 'Custom'} : undefined;
    await f.store.setDescription(sample, 'New', (previous, next, journal) => f.notes.updateEmbeds(previous, next, journal, selection));
    assert.equal(f.text.get('Original.md'), `![New](${sample.imagePath})\n${explicit ? custom : `![New](${sample.imagePath})`}\n\`${custom}\``);
  });
}

test('copied reference discovery survives interruption and restart without changing custom text', async () => {
  const f = fixture();
  await f.library.ready();
  const prepared = await f.store.prepare(await f.store.stage({bytes: PNG, method: 'file'}, 'Original.md'));
  const sample = await f.store.describe(prepared, 'Old');
  await f.io.write('Original.md', `![Old](${sample.imagePath})`);
  await f.io.write('Copy.md', `![Old](${sample.imagePath})\n![Custom](${sample.imagePath})`);
  f.resolvedLinks['Copy.md'] = {[sample.imagePath]: 1};
  const process = f.io.process;
  f.io.process = async (path, update) => {
    if (path === 'Copy.md') throw new Error('Interrupted copy');
    await process(path, update);
  };
  f.activate('Original.md');
  await f.library.editDescription(async () => 'New', sample.id);
  assert.match(String(f.errors[0]), /Interrupted copy/);
  const restarted = fixture(f.persisted);
  await restarted.library.ready();
  assert.equal(restarted.text.get('Copy.md'), `![New](${sample.imagePath})\n![Custom](${sample.imagePath})`);
  assert.ok(parseRecord(restarted.text.get(sample.recordPath)!)!.sourceNotes.includes('Copy.md'));
  assert.deepEqual(await restarted.io.operationPaths(), []);
});

for (const unsupported of ['Copy [draft].md', 'Copy#draft.md']) {
  test(`indexed unsupported path is reported without blocking save or recovery: ${unsupported}`, async () => {
    const f = fixture();
    await f.library.ready();
    const prepared = await f.store.prepare(await f.store.stage({bytes: PNG, method: 'file'}, 'Original.md'));
    const sample = await f.store.describe(prepared, 'Old');
    await f.io.write('Original.md', `![Old](${sample.imagePath})`);
    const copied = `![Old](${sample.imagePath})`;
    await f.io.write(unsupported, copied);
    f.resolvedLinks[unsupported] = {[sample.imagePath]: 1};
    const process = f.io.process;
    f.io.process = async (path, update) => {
      if (path === sample.recordPath) throw new Error('Interrupted record commit');
      await process(path, update);
    };
    await f.library.editDescription(async () => 'New', sample.id);
    assert.match(String(f.errors[0]), /Interrupted record commit/);
    const restarted = fixture(f.persisted);
    restarted.resolvedLinks[unsupported] = {[sample.imagePath]: 1};
    const reports: ReturnType<typeof restarted.notes.saveReport>[] = [];
    const saveReport = restarted.notes.saveReport.bind(restarted.notes);
    restarted.notes.saveReport = (journal, record) => {
      const report = saveReport(journal, record);
      reports.push(report);
      return report;
    };
    await restarted.library.ready();
    assert.deepEqual(await restarted.io.operationPaths(), []);
    assert.deepEqual(parseRecord(restarted.text.get(sample.recordPath)!)!.sourceNotes, ['Original.md']);
    assert.equal(restarted.text.get('Original.md'), `![New](${sample.imagePath})`);
    assert.equal(restarted.text.get(unsupported), copied);
    await restarted.library.editDescription(async () => 'Latest', sample.id);
    assert.deepEqual(restarted.errors, []);
    assert.equal(reports.at(-1)!.skipped[0].path, unsupported);
    assert.match(reports.at(-1)!.skipped[0].reason, /Unsupported note path/);
    assert.equal(reports.at(-1)!.skipped[0].from, undefined);
    assert.deepEqual(await restarted.io.operationPaths(), []);
  });
}

test('reports multiline and reference-style embeds without offering unsafe overwrites or double-counting inline embeds', async () => {
  const f = fixture();
  await f.library.ready();
  const prepared = await f.store.prepare(await f.store.stage({bytes: PNG, method: 'file'}, 'Original.md'));
  const sample = await f.store.describe(prepared, 'Old');
  const inline = `![Old](${sample.imagePath})`;
  const multiline = `![Line one\nline two](${sample.imagePath})`;
  const reference = '![Old][photo]';
  await f.io.write('Original.md', `${inline}\n${multiline}\n${reference}\n\n[photo]: ${sample.imagePath}`);
  f.cachedEmbeds['Original.md'] = [inline, multiline].map(original => ({original, link: sample.imagePath}));
  const reports: ReturnType<typeof f.notes.saveReport>[] = [];
  const saveReport = f.notes.saveReport.bind(f.notes);
  f.notes.saveReport = (journal, record) => {
    const report = saveReport(journal, record);
    reports.push(report);
    return report;
  };
  f.settings.syncCustomAlt = true;
  await f.library.editDescription(async () => 'New', sample.id);
  assert.deepEqual(f.errors, []);
  assert.equal(reports.at(-1)!.updated, 1);
  assert.deepEqual(reports.at(-1)!.skipped.map(item => item.reason), [
    'Multiline Markdown embed: overwrite unsupported', 'Reference-style Markdown embed: overwrite unsupported',
  ]);
  assert.ok(reports.at(-1)!.skipped.every(item => item.from === undefined));
  assert.equal(f.text.get('Original.md'), `![New](${sample.imagePath})\n${multiline}\n${reference}\n\n[photo]: ${sample.imagePath}`);
  assert.deepEqual(await f.io.operationPaths(), []);
});

test('review overwrite rejects a Bases edit after refresh but before the mutation baseline', async () => {
  const f = fixture();
  await f.library.ready();
  const prepared = await f.store.prepare(await f.store.stage({bytes: PNG, method: 'file'}, 'Original.md'));
  const sample = await f.store.describe(prepared, 'Reviewed description');
  const custom = `![Custom caption](${sample.imagePath})`;
  await f.io.write('Original.md', custom);
  const before = new Map(f.text);
  const newer = f.text.get(sample.recordPath)!.replace('description: "Reviewed description"', 'description: "Newer Bases description"');
  let armed = false;
  let injected = false;
  const setDescription = f.store.setDescription.bind(f.store);
  f.store.setDescription = (...args) => {
    armed = true;
    return setDescription(...args);
  };
  const exists = f.io.exists;
  f.io.exists = async path => {
    if (armed && !injected && path === `.image-ledger/operations/${sample.id}.json`) {
      injected = true;
      f.text.set(sample.recordPath, newer);
    }
    return exists(path);
  };
  const review = f.library as unknown as {
    overwriteSkipped(record: ImageRecord, item: {path: string; from: number; text: string; reason: string}): Promise<unknown>;
  };
  await assert.rejects(review.overwriteSkipped(sample, {
    path: 'Original.md', from: 0, text: custom, reason: 'Custom caption',
  }), /image description changed/);
  assert.equal(injected, true);
  before.set(sample.recordPath, newer);
  assert.deepEqual(f.text, before, 'Rejection must preserve the newer record, note, XMP and receipt state');
  assert.deepEqual(await f.io.operationPaths(), []);
});
