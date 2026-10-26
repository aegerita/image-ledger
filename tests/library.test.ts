import assert from 'node:assert/strict';
import test from 'node:test';
import type { App, EditorPosition, TFile } from 'obsidian';
import { CaptureWorkflow } from '../src/captures';
import type { ImageRecord } from '../src/images/model';
import type { VaultIO } from '../src/images/store';
import { DEFAULTS } from '../src/settings';
import { PNG } from './fixtures';
import { loadHostModules } from './host-modules';

const host = await loadHostModules();

function fixture() {
  const text = new Map<string, string>();
  const bytes = new Map<string, Uint8Array>();
  const files = new Map<string, TFile>();
  const folders = new Set<string>();
  const leaves: {view: unknown}[] = [];
  let activeFile: TFile | undefined;
  let reads = 0;
  const io: VaultIO = {
    exists: async path => text.has(path) || bytes.has(path) || folders.has(path),
    read: async path => {
      reads++;
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
    writeBinary: async (path, value) => { bytes.set(path, value.slice()); },
    mkdir: async path => { folders.add(path); },
    remove: async path => { text.delete(path); bytes.delete(path); files.delete(path); },
    recordPaths: async () => [...text.keys()].filter(path => /(?:^|\/)image-records\/[^/]+\.md$/.test(path)),
    pendingPaths: async () => [...text.keys(), ...bytes.keys()].filter(path => path.startsWith('.image-ledger/staging/')),
  };
  const app = {
    vault: {
      getAbstractFileByPath: (path: string) => files.get(path),
      read: (file: TFile) => io.read(file.path),
      process: async (file: TFile, update: (value: string) => string) => io.write(file.path, update(await io.read(file.path))),
      adapter: {exists: io.exists},
    },
    workspace: {getLeavesOfType: () => leaves, openLinkText: async () => {}, getActiveFile: () => activeFile},
  } as unknown as App;
  const errors: unknown[] = [];
  const store = new host.MediaStore(io);
  const notes = new host.NoteImages(app, {...DEFAULTS});
  const library = new host.RecordLibrary(app, store, notes, error => { errors.push(error); });
  const workflow = (describe: (record: ImageRecord) => Promise<string | null>) => new CaptureWorkflow(store, library, notes, {
    describe, notify: () => {}, report: error => { errors.push(error); },
  });
  const drain = (captures: CaptureWorkflow) => new Promise<void>(resolve => captures.enqueue(async () => { resolve(); }));
  const openEditor = (path: string) => {
    let content = text.get(path)!;
    const offset = (position: EditorPosition) => content.split('\n').slice(0, position.line)
      .reduce((total, line) => total + line.length + 1, 0) + position.ch;
    const editor = {
      getValue: () => content,
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
  };
  return {io, text, files, store, notes, library, workflow, drain, errors, openEditor, reads: () => reads, activate: (path: string) => { activeFile = files.get(path); }};
}

test('initialization shares in-flight work but retries after a temporary failure', async () => {
  const f = fixture();
  let attempts = 0;
  const initialize = f.store.initialize.bind(f.store);
  f.store.initialize = async () => {
    if (++attempts === 1) throw new Error('Temporary read failure');
    await initialize();
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
    await f.store.persist({
      ...sample, id,
      imagePath: `images/${id}.png`, recordPath: `image-records/${id}.md`, sidecarPath: `images/${id}.xmp`,
      sha256: index.toString(16).padStart(64, '0'),
    });
  }
  await f.io.write('Original.md', `![Original description](images/${sample.id}.png)`);
  f.text.set(sample.recordPath, f.text.get(sample.recordPath)!.replace('description: "Original description"', 'description: "Edited in Bases"'));
  const before = f.reads();
  let inserted: ImageRecord[] = [];
  const captures = f.workflow(async () => null);
  captures.capture([new File([PNG], 'sample.png', {type: 'image/png'})], {
    path: 'Other.md', insert: async records => { inserted = records; }, release: () => {},
  }, 'clipboard');
  await f.drain(captures);
  assert.ok(f.reads() - before <= recordCount + 3, 'Capture must not scan the complete library twice');
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
