const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {createHash, randomUUID} = require('node:crypto');

const fixtures = {
  'sample-exif.jpg': '692cbc270ec1af8a03a159cfd8b5cbf548e9c0a5e57ab2bd6881f374b3f8460f',
  'sample.png': '3f47bdd858d72df901f9660091ced2d9d4dab15447ee5a3e1b9910ea2d74b7b6',
};
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function verifyVault(app, config) {
  assert.equal(fs.realpathSync(app.vault.adapter.getBasePath()), fs.realpathSync(config.vault), 'Wrong vault; refusing app actions');
  assert.match(config.runId, /^[0-9a-f-]{36}$/);
  assert.ok(['main', 'recovery'].includes(config.phase));
  assert.ok(Number.isFinite(config.deadline) && Date.now() < config.deadline, 'Smoke deadline exceeded');
  const marker = JSON.parse(fs.readFileSync(path.join(config.vault, '.image-ledger-test-vault.json'), 'utf8'));
  assert.equal(marker.version, 1, 'Not a generated test vault');
  for (const [name, expected] of Object.entries(fixtures)) {
    assert.equal(marker.fixtures[name], expected);
    assert.equal(hash(path.join(config.vault, 'fixtures', name)), expected, 'Fixture changed');
  }
  assert.deepEqual(Object.keys(config.artifacts).sort(), ['main.js', 'manifest.json', 'styles.css']);
  for (const [name, expected] of Object.entries(config.artifacts)) {
    assert.match(expected, /^[0-9a-f]{64}$/);
    assert.equal(hash(path.join(config.vault, '.obsidian/plugins/image-ledger', name)), expected, 'Plugin build changed');
  }
}

module.exports = async (app, config) => {
  verifyVault(app, config);
  const root = fs.realpathSync(config.vault);
  const directory = path.join(root, '.image-ledger-smoke');
  const receiptPath = path.join(directory, config.phase + '.json');
  fs.mkdirSync(directory, {recursive: true});
  const receipt = {runId: config.runId, phase: config.phase, vault: root, obsidianVersion: require('electron').ipcRenderer.sendSync('version'), status: 'RUNNING', startedAt: new Date().toISOString(), checks: [], methods: 'Loaded plugin, real editor/modal/Bases DOM controls; generated paste/drop events. No native OS gestures.'};
  fs.writeFileSync(receiptPath, JSON.stringify(receipt), {flag: 'wx'});
  const save = () => {
    const temporary = receiptPath + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify(receipt, null, 2) + '\n');
    fs.renameSync(temporary, receiptPath);
  };
  const guard = () => {
    assert.equal(fs.realpathSync(app.vault.adapter.getBasePath()), root, 'Wrong vault');
    assert.ok(Date.now() < config.deadline, 'Smoke deadline exceeded');
  };
  const wait = async (get, label) => {
    const deadline = Math.min(config.deadline, Date.now() + 10000);
    while (Date.now() < deadline) {
      guard();
      const value = await get();
      if (value) return value;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw Error('Timed out: ' + label);
  };
  const step = async (name, action) => {
    guard();
    const item = {name, status: 'RUNNING', startedAt: new Date().toISOString()};
    receipt.checks.push(item); save();
    try {await action(); item.status = 'PASS';}
    catch (error) {item.status = 'FAIL'; throw error;}
    finally {item.finishedAt = new Date().toISOString(); save();}
  };
  const plugin = () => app.plugins.plugins['image-ledger'];
  const read = file => fs.readFileSync(path.join(root, file), 'utf8');
  const snapshot = file => JSON.parse(read(file).match(/<!-- image-ledger:record -->\r?\n```json\r?\n([\s\S]*?)\r?\n```/)[1]);
  const record = file => plugin().library.store.allRecords().find(item => item.sha256 === fixtures[file]);
  const embed = (item, note) => `![${item.description}](${path.posix.relative(path.posix.dirname(note), item.imagePath)})`;
  const verifyRecord = item => {
    assert.ok(item, 'Missing managed record');
    const saved = snapshot(item.recordPath);
    assert.equal(hash(path.join(root, saved.imagePath)), saved.sha256);
    assert.equal(fs.statSync(path.join(root, saved.imagePath)).size, saved.bytes);
    assert.ok(read(saved.recordPath).includes('description: ' + JSON.stringify(saved.description)));
    assert.ok(read(saved.recordPath).includes('caption_status: ' + JSON.stringify(saved.captionStatus)));
    const sources = saved.sourceNotes.map(note => '  - ' + JSON.stringify('[[' + note.replace(/\.md$/, '') + ']]'));
    assert.ok(read(saved.recordPath).includes('source_notes:\n' + sources.join('\n') + '\n'), 'Frontmatter source notes differ from the snapshot');
    assert.ok(read(saved.sidecarPath).includes(saved.description));
    assert.match(saved.id, /^[0-9a-f]{12}$/);
    assert.ok(read(saved.sidecarPath).includes('<rdf:li>' + saved.id + '</rdf:li>'));
    assert.ok(!read(saved.sidecarPath).includes('urn:uuid:'));
    assert.ok(fs.existsSync(path.join(root, '.image-ledger/ids', saved.id)), 'Missing permanent ID reservation');
    assert.equal(saved.schemaVersion, 2);
    assert.ok(Number.isFinite(Date.parse(saved.importedAt)), 'Missing import time');
    assert.equal('noteDate' in saved, false, 'Image records must not invent a note date');
    assert.equal(path.posix.dirname(saved.imagePath), 'images', 'New vaults must use flat image storage');
    assert.equal(path.posix.dirname(saved.sidecarPath), 'images');
    assert.equal(path.posix.dirname(saved.recordPath), config.phase === 'recovery' ? 'Archive/image-records' : 'image-records');
    for (const note of saved.sourceNotes) assert.equal(read(note).split(embed(saved, note)).length - 1, 1);
    return saved;
  };
  const documents = () => [...new Set([app.workspace.containerEl.ownerDocument, ...['markdown', 'bases'].flatMap(type => app.workspace.getLeavesOfType(type).map(leaf => leaf.view.containerEl.ownerDocument))])];
  const modal = () => wait(() => {
    const found = documents().flatMap(doc => [...doc.querySelectorAll('input[aria-label="Image description"]')]).filter(input => input.isConnected && input.getClientRects().length);
    assert.ok(found.length <= 1, 'Ambiguous caption modals');
    return found[0];
  }, 'real caption modal');
  const submit = (input, description) => {
    guard();
    const container = input.closest('.modal');
    assert.ok(container?.querySelector('img'), 'Caption preview missing');
    if (description !== null) {
      input.value = description;
      input.dispatchEvent(new input.ownerDocument.defaultView.Event('input', {bubbles: true}));
    }
    const label = description === null ? 'Describe later' : 'Save description';
    const button = [...container.querySelectorAll('button')].find(button => button.textContent.trim() === label);
    assert.ok(button, 'Missing real caption button'); button.click();
  };
  const source = 'Projects/Research.md', other = '2027/01/2027-01-04.md';
  const open = async note => {
    guard(); await app.workspace.openLinkText(note, '', false);
    return wait(() => {
      const view = app.workspace.getMostRecentLeaf()?.view;
      return view?.file?.path === note && view.editor && plugin().notes.hasEditor(view.editor) ? view : null;
    }, 'tracked editor: ' + note);
  };
  const capture = async (fixture, note, method) => {
    const view = await open(note);
    view.editor.setCursor({line: view.editor.lastLine(), ch: view.editor.getLine(view.editor.lastLine()).length});
    const win = view.containerEl.ownerDocument.defaultView;
    const file = new win.File([fs.readFileSync(path.join(root, 'fixtures', fixture))], fixture, {type: fixture.endsWith('.png') ? 'image/png' : 'image/jpeg', lastModified: fs.statSync(path.join(root, 'fixtures', fixture)).mtimeMs});
    guard();
    if (method === 'file') plugin().captures.capture([file], plugin().notes.captureTarget(view.editor, view.file), 'file');
    else {
      const data = new win.DataTransfer(); data.items.add(file);
      const event = method === 'drop' ? new win.DragEvent('drop', {dataTransfer: data, cancelable: true}) : new win.ClipboardEvent('paste', {clipboardData: data, cancelable: true});
      app.workspace.trigger(method === 'drop' ? 'editor-drop' : 'editor-paste', event, view.editor, view);
      assert.equal(event.defaultPrevented, true, 'Registered handler did not claim image');
    }
    return modal();
  };
  const synchronized = (file, description) => {
    const item = record(file);
    if (!item || snapshot(item.recordPath).description !== description || !read(item.sidecarPath).includes(description)) return false;
    return item.sourceNotes.every(note => read(note).includes(embed({...item, description}, note)));
  };
  let processBeforeRename;
  try {
    await wait(plugin, 'Image Ledger loaded');
    await plugin().library.ready(); await plugin().library.store.refresh();
    assert.equal(plugin().settings.storageLayout, 'flat', 'New vaults must default to flat image storage');
    if (config.phase === 'main') {
      assert.equal(plugin().library.store.allRecords().length, 0, 'Smoke vault must be fresh');
      await step('JPEG file import and EXIF', async () => {
        submit(await capture('sample-exif.jpg', source, 'file'), 'Synthetic JPEG.');
        await wait(() => synchronized('sample-exif.jpg', 'Synthetic JPEG.'), 'JPEG persistence');
        const jpeg = verifyRecord(record('sample-exif.jpg'));
        assert.equal(jpeg.metadata.capturedAt, '2026-10-17T12:34:56.0074-04:00');
        assert.equal(jpeg.ingestMethod, 'file');
      });
      const jpegId = record('sample-exif.jpg').id;
      await step('Dated-note duplicate reuse', async () => {
        submit(await capture('sample-exif.jpg', other, 'file'), 'Synthetic JPEG.');
        await wait(() => record('sample-exif.jpg').sourceNotes.length === 2 && synchronized('sample-exif.jpg', 'Synthetic JPEG.'), 'duplicate persistence');
        assert.equal(record('sample-exif.jpg').id, jpegId);
        assert.equal(plugin().library.store.allRecords().length, 1);
        verifyRecord(record('sample-exif.jpg'));
      });
      await step('Actual Bases description editor and links', async () => {
        assert.equal(app.commands.executeCommandById('image-ledger:open-image-library'), true);
        let leaf = await wait(() => app.workspace.getLeavesOfType('bases').find(leaf => leaf.view.file?.path === 'image-library.base'), 'Bases view');
        app.workspace.setActiveLeaf(leaf, {focus: true});
        const jpeg = record('sample-exif.jpg');
        const row = () => [...leaf.view.containerEl.querySelectorAll('.bases-tbody .bases-tr')].find(row => row.querySelector('[data-href="' + jpeg.imagePath + '"]'));
        const cell = await wait(() => row()?.querySelector('[data-property="note.description"] [contenteditable="true"]'), 'Bases caption cell');
        cell.focus(); cell.textContent = 'Edited synthetic JPEG.';
        cell.dispatchEvent(new cell.ownerDocument.defaultView.InputEvent('input', {bubbles: true, inputType: 'insertText', data: cell.textContent}));
        cell.dispatchEvent(new cell.ownerDocument.defaultView.KeyboardEvent('keydown', {bubbles: true, key: 'Enter', code: 'Enter'})); cell.blur();
        await wait(() => synchronized('sample-exif.jpg', 'Edited synthetic JPEG.'), 'Bases synchronization');
        verifyRecord(record('sample-exif.jpg'));
        row().querySelector('[data-href="' + jpeg.imagePath + '"]').click();
        await wait(() => app.workspace.getActiveFile()?.path === jpeg.imagePath && app.workspace.getMostRecentLeaf()?.view.getViewType() === 'image', 'Base image link');
        assert.equal(app.commands.executeCommandById('image-ledger:open-image-library'), true);
        leaf = await wait(() => app.workspace.getLeavesOfType('bases').find(leaf => leaf.view.file?.path === 'image-library.base'), 'reopened Bases view');
        app.workspace.setActiveLeaf(leaf, {focus: true});
        const scroller = await wait(() => leaf.view.containerEl.querySelector('.bases-view'), 'Bases table scroller'); scroller.scrollLeft = 0;
        await wait(row, 'JPEG row');
        const link = await wait(() => {
          // Drive the real scroll handler even when the test window is hidden.
          scroller.scrollLeft = scroller.scrollWidth;
          scroller.dispatchEvent(new scroller.ownerDocument.defaultView.Event('scroll'));
          const rows = leaf.view.containerEl.querySelectorAll('.bases-tbody .bases-tr');
          assert.ok(rows.length <= 1, 'Expected only the JPEG row before PNG capture');
          return rows[0]?.querySelector('[data-property="note.source_notes"] [data-href="' + source.replace(/\.md$/, '') + '"]');
        }, 'Base source-note link');
        link.click(); await wait(() => app.workspace.getActiveFile()?.path === source, 'Base source-note target');
      });
      await step('Description save rebases a concurrent source-note edit', async () => {
        const jpeg = record('sample-exif.jpg');
        const description = 'Conflict-safe synthetic JPEG.';
        const sourceNotes = [...jpeg.sourceNotes].reverse();
        await open(jpeg.recordPath);
        const process = app.vault.process;
        let injected = false;
        app.vault.process = async function(file, update, ...args) {
          guard();
          if (file.path === jpeg.recordPath && !injected) {
            injected = true;
            await app.fileManager.processFrontMatter(file, properties => {
              assert.ok(Array.isArray(properties.source_notes), 'Missing editable source references');
              properties.source_notes.reverse();
            });
          }
          return process.call(this, file, update, ...args);
        };
        try {
          await plugin().library.editDescription(async () => description);
          assert.equal(injected, true, 'Concurrent edit did not reach the record write boundary');
          await wait(() => synchronized('sample-exif.jpg', description), 'conflicting description save');
          const saved = verifyRecord(record('sample-exif.jpg'));
          assert.equal(saved.description, description);
          assert.deepEqual(saved.sourceNotes, sourceNotes, 'Concurrent source references were replaced');
        } finally {
          app.vault.process = process;
        }
      });
      await step('Description save synchronizes a source note added during the save', async () => {
        const jpeg = record('sample-exif.jpg');
        const description = 'Added-reference synthetic JPEG.';
        const added = 'Added-during-save.md';
        const oldEmbed = embed(jpeg, added);
        const customEmbed = embed({...jpeg, description: 'Custom added-note label'}, added);
        const before = '# Synthetic added source\n\nBEFORE_ADDED_IMAGE\n\n' + oldEmbed + '\n\n' + customEmbed + '\n\nAFTER_ADDED_IMAGE\n';
        await app.vault.create(added, before);
        await open(jpeg.recordPath);
        const process = app.vault.process;
        let injected = false;
        app.vault.process = async function(file, update, ...args) {
          guard();
          if (file.path === jpeg.recordPath && !injected) {
            injected = true;
            for (const note of jpeg.sourceNotes) {
              assert.ok(read(note).includes(embed({...jpeg, description}, note)), 'Original source was not updated before the conflict');
            }
            assert.equal(read(added), before, 'Added source changed before it was referenced');
            await app.fileManager.processFrontMatter(file, properties => {
              assert.ok(Array.isArray(properties.source_notes), 'Missing editable source references');
              properties.source_notes.push('[[' + added.replace(/\.md$/, '') + ']]');
            });
          }
          return process.call(this, file, update, ...args);
        };
        try {
          await plugin().library.editDescription(async () => description);
          assert.equal(injected, true, 'Added source did not reach the record write boundary');
          await wait(() => synchronized('sample-exif.jpg', description), 'added source caption synchronization');
          const saved = verifyRecord(record('sample-exif.jpg'));
          assert.equal(saved.description, description);
          assert.deepEqual(saved.sourceNotes, [...jpeg.sourceNotes, added], 'Added source reference was lost');
          assert.deepEqual(record('sample-exif.jpg'), saved, 'Cache differs from the committed record');
          assert.equal(read(added), before.replace(oldEmbed, embed({...jpeg, description}, added)), 'Added source text or custom alt text changed');
        } finally {
          app.vault.process = process;
        }
        await app.fileManager.processFrontMatter(app.vault.getAbstractFileByPath(jpeg.recordPath), properties => {
          properties.source_notes = properties.source_notes.filter(link => link !== '[[' + added.replace(/\.md$/, '') + ']]');
        });
        await plugin().library.editDescription(async () => description);
        assert.deepEqual(verifyRecord(record('sample-exif.jpg')).sourceNotes, jpeg.sourceNotes, 'Temporary source reference was not removed');
      });
      await step('Description retry preserves custom alt text matching the submitted caption', async () => {
        const jpeg = record('sample-exif.jpg');
        const submitted = 'Matching custom alt synthetic JPEG.';
        const newer = 'Newer Bases synthetic JPEG.';
        const before = read(source);
        const oldEmbed = embed(jpeg, source);
        const custom = '\n\nMATCHING_CUSTOM_ALT_START\n' + embed({...jpeg, description: submitted}, source) + '\nMATCHING_CUSTOM_ALT_END\n';
        assert.equal(before.split(oldEmbed).length - 1, 1, 'Expected one generated embed before the race');
        const view = await open(source);
        view.editor.setValue(before + custom);
        await view.save();
        await open(jpeg.recordPath);
        const process = app.vault.process;
        let injected = false;
        app.vault.process = async function(file, update, ...args) {
          guard();
          if (file.path === jpeg.recordPath && !injected) {
            injected = true;
            assert.equal(read(source), before.replace(oldEmbed, embed({...jpeg, description: submitted}, source)) + custom,
              'Generated caption or matching custom alt changed before the conflict');
            await app.fileManager.processFrontMatter(file, properties => {
              properties.description = newer;
            });
          }
          return process.call(this, file, update, ...args);
        };
        try {
          await plugin().library.editDescription(async () => submitted);
          assert.equal(injected, true, 'Concurrent Bases edit did not reach the record write boundary');
          await wait(() => synchronized('sample-exif.jpg', newer), 'matching custom alt retry');
          const saved = verifyRecord(record('sample-exif.jpg'));
          assert.equal(saved.description, newer);
          assert.deepEqual(record('sample-exif.jpg'), saved, 'Cache differs from the committed record');
          assert.deepEqual(saved.sourceNotes, jpeg.sourceNotes, 'Source references changed during the retry');
          assert.equal(read(source), before.replace(oldEmbed, embed({...jpeg, description: newer}, source)) + custom,
            'Retry changed matching custom alt text or surrounding text');
        } finally {
          app.vault.process = process;
        }
        await app.vault.process(app.vault.getAbstractFileByPath(source), content => content.replace(custom, ''));
        verifyRecord(record('sample-exif.jpg'));
      });
      await step('Drop handler, note switch and Describe later', async () => {
        const input = await capture('sample.png', source, 'drop');
        const before = read(other); await open(other); submit(input, null);
        await wait(() => synchronized('sample.png', 'Description pending'), 'pending PNG persistence');
        const png = verifyRecord(record('sample.png'));
        assert.equal(png.captionStatus, 'pending'); assert.equal(png.ingestMethod, 'drop');
        assert.equal(read(other), before, 'Drop inserted into wrong note');
      });
      await step('Edit image description command', async () => {
        await open(record('sample.png').recordPath);
        assert.equal(app.commands.executeCommandById('image-ledger:edit-image-description'), true);
        submit(await modal(), 'Synthetic PNG.');
        await wait(() => synchronized('sample.png', 'Synthetic PNG.'), 'caption command persistence');
        assert.equal(verifyRecord(record('sample.png')).captionStatus, 'confirmed');
      });
      const operations = [];
      await step('Prepare isolated sources for interrupted description saves', async () => {
        for (const [fixture, count, description] of [
          ['sample-exif.jpg', 2, 'Restarted partial-note JPEG.'],
          ['sample.png', 1, 'Restarted record-write PNG.'],
        ]) {
          const original = record(fixture);
          const notes = [];
          for (let index = 0; index < count; index++) {
            const note = `Interrupted-${original.format}-${index}.md`;
            const before = `# Synthetic interrupted save\n\nBEFORE_${original.format}_${index}\n\n`
              + embed(original, note) + '\n\n'
              + embed({...original, description: `Custom ${original.format} caption ${index}`}, note)
              + `\n\nAFTER_${original.format}_${index}\n`;
            await app.vault.create(note, before);
            notes.push({path: note, before, after: before.replace(embed(original, note), embed({...original, description}, note))});
          }
          await app.fileManager.processFrontMatter(app.vault.getAbstractFileByPath(original.recordPath), properties => {
            properties.source_notes = notes.map(note => '[[' + note.path.replace(/\.md$/, '') + ']]');
          });
          const sidecar = read(original.sidecarPath).replace(original.description, description);
          operations.push({fixture, original, description, notes, sidecar, receipt: `.image-ledger/operations/${original.id}.json`});
        }
        await plugin().library.store.refresh();
        await wait(() => plugin().library.recordTimers.size === 0, 'source-reference edit reconciliation');
      });
      let checkpoint;
      await step('Paste handler staged with caption open', async () => {
        const input = await capture('sample.png', other, 'paste'); assert.ok(input.isConnected);
        const pending = await wait(async () => (await plugin().library.store.pendingCaptures()).find(item => item.sourcePath === other), 'real paste staging');
        assert.equal(pending.storageFolder, '', 'Dated notes must still use flat storage by default');
        assert.equal(hash(path.join(root, pending.dataPath)), fixtures['sample.png']);
        const token = randomUUID(); plugin().__imageLedgerSmokeToken = token;
        checkpoint = {runId: config.runId, token, pending, pngId: record('sample.png').id, operations};
      });
      await step('Retain partial-note and record-write failures for restart', async () => {
        for (const operation of operations) {
          const item = record(operation.fixture);
          const failedPath = operation.notes.length > 1 ? operation.notes[1].path : item.recordPath;
          assert.equal(app.workspace.getLeavesOfType('markdown').some(leaf => operation.notes.some(note => leaf.view.file?.path === note.path)), false, 'Interrupted sources must use saved-file writes');
          const process = app.vault.process;
          let injected = false;
          app.vault.process = async function(file, update, ...args) {
            guard();
            if (file.path === failedPath) {
              injected = true;
              assert.equal(read(operation.notes[0].path), operation.notes[0].after, 'First note was not saved before the injected failure');
              throw new Error('Synthetic interrupted description write');
            }
            return process.call(this, file, update, ...args);
          };
          try {
            await assert.rejects(plugin().library.store.setDescription(item, operation.description, plugin().library.synchronize), /Synthetic interrupted description write/);
          } finally {
            app.vault.process = process;
          }
          assert.equal(injected, true, 'Description save missed the intended failure boundary');
          assert.equal(snapshot(item.recordPath).description, operation.original.description, 'Failed save committed the record snapshot');
          assert.ok(fs.existsSync(path.join(root, operation.receipt)), 'Failed save lost its durable operation receipt');
          assert.doesNotThrow(() => JSON.parse(read(operation.receipt)), 'Operation receipt is not readable JSON');
          for (const [index, note] of operation.notes.entries()) {
            assert.equal(read(note.path), index === 0 ? note.after : note.before, 'Unexpected partial note state');
          }
        }
        assert.deepEqual(fs.readdirSync(path.join(root, '.image-ledger/operations')).sort(), operations.map(operation => path.basename(operation.receipt)).sort(), 'Both failed operations must survive until reload');
      });
      await step('Rename record folder while description saves remain interrupted', async () => {
        const failedPaths = new Set(operations.map(operation => operation.notes.length > 1
          ? operation.notes[1].path
          : 'Archive/' + operation.original.recordPath));
        const process = app.vault.process;
        processBeforeRename = process;
        // Keep the synthetic failures active until the actual app reload discards this runtime.
        app.vault.process = async function(file, update, ...args) {
          if (failedPaths.has(file.path)) {
            guard();
            throw new Error('Synthetic interrupted description write');
          }
          return process.call(this, file, update, ...args);
        };
        await app.vault.createFolder('Archive');
        const folder = app.vault.getAbstractFileByPath('image-records');
        assert.ok(folder, 'Missing original record folder');
        await app.vault.rename(folder, 'Archive/image-records');
        // The open caption blocks the capture queue, so await its rename handler directly.
        try {
          await plugin().library.rename(folder, 'image-records');
        } catch (error) {
          assert.match(error.message, /Synthetic interrupted description write/);
        }
        assert.equal(fs.existsSync(path.join(root, 'image-records')), false, 'Rename left the old record folder');
        for (const operation of operations) {
          const moved = 'Archive/' + operation.original.recordPath;
          assert.equal(snapshot(moved).id, operation.original.id, 'Renamed file lost its record identity');
          assert.equal(snapshot(moved).description, operation.original.description, 'Rename completed an interrupted save before reload');
          assert.equal(JSON.parse(read(operation.receipt)).recordPath, moved, 'Pending receipt still points at the old record path');
          for (const [index, note] of operation.notes.entries()) {
            assert.equal(read(note.path), index === 0 ? note.after : note.before, 'Rename changed the interrupted note state');
          }
        }
        fs.writeFileSync(path.join(directory, 'checkpoint.json'), JSON.stringify(checkpoint), {flag: 'wx'});
      });
      receipt.status = 'AWAITING_RELOAD';
    } else {
      const checkpoint = JSON.parse(fs.readFileSync(path.join(directory, 'checkpoint.json'), 'utf8'));
      assert.equal(checkpoint.runId, config.runId);
      assert.notEqual(plugin().__imageLedgerSmokeToken, checkpoint.token, 'Plugin was not reloaded');
      await step('Replay partial description saves after app reload', async () => {
        assert.equal(fs.existsSync(path.join(root, 'image-records')), false, 'Recovery recreated the old record folder');
        for (const operation of checkpoint.operations) {
          const saved = verifyRecord(record(operation.fixture));
          assert.equal(saved.recordPath, 'Archive/' + operation.original.recordPath, 'Recovery did not use the renamed record');
          assert.equal(saved.description, operation.description, 'Restart did not finish the interrupted description');
          assert.deepEqual(saved.sourceNotes, operation.notes.map(note => note.path));
          assert.deepEqual(record(operation.fixture), saved, 'Recovered cache differs from the committed record');
          assert.equal(read(saved.sidecarPath), operation.sidecar, 'Recovered XMP differs from the intended record');
          for (const note of operation.notes) {
            assert.equal(read(note.path), note.after, 'Restart changed custom captions or surrounding text');
          }
          assert.equal(fs.existsSync(path.join(root, operation.receipt)), false, 'Completed operation receipt remains');
        }
        assert.deepEqual(fs.readdirSync(path.join(root, '.image-ledger/operations')), [], 'Pending description operations remain');
        for (const operation of checkpoint.operations) {
          await app.fileManager.processFrontMatter(app.vault.getAbstractFileByPath(record(operation.fixture).recordPath), properties => {
            properties.description = operation.original.description;
            properties.caption_status = operation.original.captionStatus;
            properties.source_notes = operation.original.sourceNotes.map(note => '[[' + note.replace(/\.md$/, '') + ']]');
          });
        }
        await plugin().library.reconcileAll();
        for (const operation of checkpoint.operations) {
          verifyRecord(record(operation.fixture));
          for (const note of operation.notes) await app.vault.delete(app.vault.getAbstractFileByPath(note.path));
        }
      });
      await step('Recover real caption-open paste after app reload', async () => {
        assert.ok((await plugin().library.store.pendingCaptures()).some(item => item.id === checkpoint.pending.id), 'Interrupted paste staging disappeared');
        assert.equal(app.commands.executeCommandById('image-ledger:recover-captures'), true);
        submit(await modal(), 'Recovered synthetic PNG.');
        await wait(async () => (await plugin().library.store.pendingCaptures()).length === 0 && synchronized('sample.png', 'Recovered synthetic PNG.'), 'recovery completion');
        const png = verifyRecord(record('sample.png'));
        assert.equal(png.id, checkpoint.pngId); assert.equal(png.sourceNotes.length, 2);
        assert.equal(plugin().library.store.allRecords().length, 2);
        assert.deepEqual(fs.readdirSync(path.join(root, '.image-ledger/staging')), []);
      });
      await step('Final records and actual audit notice', async () => {
        receipt.records = plugin().library.store.allRecords().map(verifyRecord);
        assert.equal(fs.existsSync(path.join(root, 'image-records')), false, 'A later save recreated the old record folder');
        assert.ok(receipt.records.every(record => record.captionStatus === 'confirmed'));
        assert.equal(app.commands.executeCommandById('image-ledger:audit-images'), true);
        receipt.audit = await wait(() => documents().flatMap(doc => [...doc.querySelectorAll('.notice')]).map(notice => notice.textContent).find(text => text.includes('2 image records') && text.includes('0 descriptions pending') && text.includes('0 missing files') && text.includes('0 interrupted captures')), 'clean audit notice');
      });
      receipt.status = 'PASS';
    }
  } catch (error) {
    if (processBeforeRename) app.vault.process = processBeforeRename;
    receipt.status = 'FAIL';
    receipt.error = String(error.stack ?? error);
  }
  receipt.finishedAt = new Date().toISOString(); save();
  return receipt.status;
};
module.exports.verifyVault = verifyVault;
