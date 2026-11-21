const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');

const fixtures = {
  'sample-exif.jpg': '692cbc270ec1af8a03a159cfd8b5cbf548e9c0a5e57ab2bd6881f374b3f8460f',
  'sample.png': '3f47bdd858d72df901f9660091ced2d9d4dab15447ee5a3e1b9910ea2d74b7b6',
};
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function verifyVault(app, config) {
  assert.equal(fs.realpathSync(config.vault), config.vault, 'Vault path must be canonical');
  assert.equal(fs.realpathSync(app.vault.adapter.getBasePath()), config.vault, 'Wrong vault; refusing app actions');
  assert.match(config.runId, /^[0-9a-f-]{36}$/);
  assert.ok(['main', 'recovery'].includes(config.phase));
  assert.ok(Number.isFinite(config.deadline) && Date.now() < config.deadline, 'Smoke deadline exceeded');
  const marker = JSON.parse(fs.readFileSync(path.join(config.vault, '.image-ledger-test-vault.json'), 'utf8'));
  assert.equal(marker.version, 1, 'Not a generated test vault');
  assert.deepEqual(Object.keys(marker.fixtures).sort(), Object.keys(fixtures).sort());
  for (const [name, expected] of Object.entries(fixtures)) {
    assert.equal(marker.fixtures[name], expected);
    assert.equal(hash(path.join(config.vault, 'fixtures', name)), expected, 'Fixture changed');
  }
  assert.deepEqual(Object.keys(config.artifacts).sort(), ['main.js', 'manifest.json', 'styles.css']);
  for (const [name, expected] of Object.entries(config.artifacts)) {
    assert.match(expected, /^[0-9a-f]{64}$/);
    assert.equal(hash(path.join(config.vault, '.obsidian/plugins/image-ledger', name)), expected, 'Plugin build changed');
  }
  assert.equal(fs.realpathSync(config.exiftool.path), config.exiftool.path, 'ExifTool path must be canonical');
  assert.equal(hash(config.exiftool.path), config.exiftool.sha256, 'ExifTool executable changed');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(config.vault, '.obsidian/plugins/image-ledger/data.json'), 'utf8')),
    {exiftoolPath: config.exiftool.path}, 'Unexpected generated plugin settings');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(config.vault, '.obsidian/community-plugins.json'), 'utf8')),
    ['image-ledger'], 'Unknown enabled plugin');
  assert.deepEqual(fs.readdirSync(path.join(config.vault, '.obsidian/plugins')), ['image-ledger'], 'Unknown installed plugin');
}

module.exports = async (app, config) => {
  verifyVault(app, config);
  const root = config.vault;
  const directory = path.join(root, '.image-ledger-smoke');
  fs.mkdirSync(directory, {recursive: true});
  const receiptPath = path.join(directory, config.phase + '.json');
  const receipt = {
    runId: config.runId,
    phase: config.phase,
    vault: root,
    obsidianVersion: require('electron').ipcRenderer.sendSync('version'),
    status: 'RUNNING',
    startedAt: new Date().toISOString(),
    checks: [],
    methods: 'Loaded plugin, real editor/modal controls and registered paste/drop handlers. No native OS gestures.',
  };
  fs.writeFileSync(receiptPath, JSON.stringify(receipt), {flag: 'wx'});
  const save = () => {
    fs.writeFileSync(receiptPath + '.tmp', JSON.stringify(receipt, null, 2) + '\n');
    fs.renameSync(receiptPath + '.tmp', receiptPath);
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
    throw new Error('Timed out: ' + label);
  };
  const step = async (name, action) => {
    guard();
    const item = {name, status: 'RUNNING', startedAt: new Date().toISOString()};
    receipt.checks.push(item);
    save();
    try {
      await action();
      item.status = 'PASS';
    } catch (error) {
      item.status = 'FAIL';
      throw error;
    } finally {
      item.finishedAt = new Date().toISOString();
      save();
    }
  };
  const plugin = () => app.plugins.plugins['image-ledger'];
  const source = 'Projects/Research.md';
  const other = '2027/01/2027-01-04.md';
  const read = file => fs.readFileSync(path.join(root, file), 'utf8');
  const images = () => plugin().library.store.allRecords();
  const image = extension => images().find(item => item.imagePath.endsWith(extension));
  const embed = (item, note, description = item.description || 'Image') => {
    const target = path.posix.relative(path.posix.dirname(note), item.imagePath);
    return `![${description}](${target})`;
  };
  const documents = () => [...new Set([
    app.workspace.containerEl.ownerDocument,
    ...app.workspace.getLeavesOfType('markdown').map(leaf => leaf.view.containerEl.ownerDocument),
  ])];
  const modal = () => wait(() => {
    const found = documents().flatMap(doc => [...doc.querySelectorAll('input[aria-label="Image description"]')])
      .filter(input => input.isConnected && input.getClientRects().length);
    assert.ok(found.length <= 1, 'Ambiguous description dialogs');
    return found[0];
  }, 'real description dialog');
  const submit = (input, description) => {
    guard();
    const container = input.closest('.modal');
    assert.ok(container, 'Description dialog unavailable');
    if (description !== null) {
      input.value = description;
      input.dispatchEvent(new input.ownerDocument.defaultView.Event('input', {bubbles: true}));
    }
    const label = description === null ? 'Describe later' : 'Save description';
    const button = [...container.querySelectorAll('button')].find(button => button.textContent.trim() === label);
    assert.ok(button, 'Missing real description button');
    button.click();
  };
  const open = async note => {
    guard();
    await app.workspace.openLinkText(note, '', false);
    return wait(() => {
      const view = app.workspace.getMostRecentLeaf()?.view;
      return view?.file?.path === note && view.editor && plugin().notes.hasEditor(view.editor) ? view : null;
    }, 'tracked editor: ' + note);
  };
  const capture = async (relativePath, note, method) => {
    const view = await open(note);
    view.editor.setCursor({line: view.editor.lastLine(), ch: view.editor.getLine(view.editor.lastLine()).length});
    const win = view.containerEl.ownerDocument.defaultView;
    const filePath = path.join(root, relativePath);
    const file = new win.File([fs.readFileSync(filePath)], path.basename(relativePath), {
      type: relativePath.endsWith('.png') ? 'image/png' : 'image/jpeg',
      lastModified: fs.statSync(filePath).mtimeMs,
    });
    guard();
    if (method === 'file') {
      plugin().captures.capture([file], plugin().notes.captureTarget(view.editor, view.file), 'file');
    } else {
      const data = new win.DataTransfer();
      data.items.add(file);
      const event = method === 'drop'
        ? new win.DragEvent('drop', {dataTransfer: data, cancelable: true})
        : new win.ClipboardEvent('paste', {clipboardData: data, cancelable: true});
      app.workspace.trigger(method === 'drop' ? 'editor-drop' : 'editor-paste', event, view.editor, view);
      assert.equal(event.defaultPrevented, true, 'Registered handler did not claim image');
    }
  };
  const saved = async (extension, description, note, altText = description || 'Image') => {
    const item = image(extension);
    return item && item.description === description && read(note).includes(embed(item, note, altText))
      && (await plugin().library.store.pendingCaptures()).length === 0;
  };
  const checkImages = () => {
    assert.equal(images().length, 2);
    for (const item of images()) {
      assert.match(item.id, /^[0-9a-f]{64}$/);
      assert.equal(path.posix.basename(item.imagePath), item.id + path.posix.extname(item.imagePath));
      assert.equal(path.posix.dirname(item.imagePath), 'images');
    }
    assert.equal(fs.existsSync(path.join(root, 'image-records')), false);
    assert.equal(fs.existsSync(path.join(root, 'image-library.base')), false);
    assert.ok(!fs.readdirSync(path.join(root, 'images')).some(name => name.endsWith('.xmp')));
    assert.ok(!read(source).includes('[Image details]'));
    assert.ok(!read(other).includes('[Image details]'));
  };

  try {
    await wait(plugin, 'Image Ledger loaded');
    await plugin().library.ready();
    assert.equal(plugin().settings.storageLayout, 'flat');
    if (config.phase === 'main') {
      assert.equal(images().length, 0, 'Smoke vault must start empty');
      await step('Reject a pasted JPEG with malformed XMP and clear staging', async () => {
        const jpeg = fs.readFileSync(path.join(root, 'fixtures/sample-exif.jpg'));
        const xmp = Buffer.from('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta xmlns:x="adobe:ns:meta/">');
        const segment = Buffer.from([0xff, 0xe1, 0, 0]);
        segment.writeUInt16BE(xmp.length + 2, 2);
        const invalid = Buffer.concat([jpeg.subarray(0, 2), segment, xmp, jpeg.subarray(2)]);
        const copy = '.image-ledger-smoke/malformed-xmp.jpg';
        fs.writeFileSync(path.join(root, copy), invalid, {flag: 'wx'});
        const before = read(source);
        await capture(copy, source, 'clipboard');
        await wait(() => documents().some(doc => [...doc.querySelectorAll('.notice')].some(notice =>
          notice.textContent.includes('Re-export the image without metadata, or use a different copy.'))), 'unreadable XMP notice');
        await wait(() => fs.readdirSync(path.join(root, '.image-ledger/staging')).length === 0, 'staging cleanup');
        assert.equal(images().length, 0);
        assert.equal(read(source), before);
        assert.deepEqual(fs.readFileSync(path.join(root, copy)), invalid);
      });
      await step('Import JPEG and save embedded description', async () => {
        await capture('fixtures/sample-exif.jpg', source, 'file');
        const input = await modal();
        assert.match(input.closest('.modal').querySelector('img')?.src ?? '', /^blob:/, 'Staged image preview missing');
        submit(input, 'Synthetic JPEG.');
        await wait(() => saved('.jpg', 'Synthetic JPEG.', source), 'JPEG import');
      });
      await step('Finish pasted PNG after closing its source editor', async () => {
        const before = read(other);
        await capture('fixtures/sample.png', source, 'clipboard');
        const input = await modal();
        const leaf = app.workspace.getLeavesOfType('markdown').find(leaf => leaf.view.file?.path === source);
        assert.ok(leaf, 'Missing source editor');
        leaf.detach();
        assert.ok(!app.workspace.getLeavesOfType('markdown').some(leaf => leaf.view.file?.path === source),
          'Source editor still open');
        submit(input, null);
        await wait(() => saved('.png', '', source), 'PNG pending description');
        assert.equal(read(other), before, 'Capture changed the other note');
      });
      await step('Drop of an exported JPEG reuses the image without a dialog', async () => {
        const originalPath = image('.jpg').imagePath;
        const copy = '.image-ledger-smoke/export-copy.jpg';
        fs.copyFileSync(path.join(root, originalPath), path.join(root, copy), fs.constants.COPYFILE_EXCL);
        await capture(copy, other, 'drop');
        await wait(() => saved('.jpg', 'Synthetic JPEG.', other), 'duplicate drop');
        assert.equal(image('.jpg').imagePath, originalPath);
        checkImages();
      });
      await step('Command edits embedded description with stable identity', async () => {
        const jpeg = image('.jpg');
        const view = await open(source);
        const position = view.editor.getValue().indexOf(embed(jpeg, source));
        assert.ok(position >= 0);
        view.editor.setCursor(view.editor.offsetToPos(position + 3));
        assert.equal(app.commands.executeCommandById('image-ledger:edit-image-description'), true);
        submit(await modal(), 'Edited synthetic JPEG.');
        await wait(() => image('.jpg')?.description === 'Edited synthetic JPEG.'
          && read(source).includes(embed(jpeg, source, 'Edited synthetic JPEG.'))
          && read(other).includes(embed(jpeg, other, 'Edited synthetic JPEG.')), 'image and note descriptions updated');
        assert.equal(image('.jpg').id, jpeg.id);
        assert.equal(image('.jpg').imagePath, jpeg.imagePath);
      });
      await step('Library filters pending descriptions and image menus target the saved file', async () => {
        const openPicker = async () => {
          assert.equal(app.commands.executeCommandById('image-ledger:open-image-library'), true);
          const search = await wait(() => documents().map(doc => doc.querySelector('input[aria-label="Search images"]'))
            .find(input => input?.isConnected && input.getClientRects().length), 'image library picker');
          return search.closest('.modal');
        };
        const pendingPicker = await openPicker();
        const filter = pendingPicker.querySelector('.image-ledger-picker-filter');
        assert.match(filter?.textContent ?? '', /Pending descriptions only \(1\)/);
        const checkbox = filter.querySelector('input[type="checkbox"]');
        assert.ok(checkbox, 'Pending filter missing');
        checkbox.click();
        const pendingRows = pendingPicker.querySelectorAll('.image-ledger-picker-row');
        assert.equal(pendingRows.length, 1, 'Pending filter did not exclude described images');
        assert.match(pendingRows[0].textContent, /Description pending/);
        const edit = pendingRows[0].querySelector(`button[aria-label="Edit description for ${image('.png').imagePath}"]`);
        assert.ok(edit, 'Pending image edit action missing');
        edit.click();
        const input = await modal();
        assert.equal(input.value, '');
        submit(input, null);

        const picker = await openPicker();
        const button = [...picker.querySelectorAll('.image-ledger-picker button')]
          .find(item => item.textContent.includes('Edited synthetic JPEG.'));
        assert.ok(button, 'Picker missing edited embedded description');
        const jpeg = image('.jpg');
        guard();
        button.click();
        await wait(() => app.workspace.getActiveFile()?.path === jpeg.imagePath, 'library image opened');

        const file = await wait(() => app.vault.getAbstractFileByPath(jpeg.imagePath), 'indexed JPEG file');
        const titles = [];
        const menu = {
          addSeparator() { return this; },
          addItem(build) {
            build({
              setTitle(title) { titles.push(title); return this; },
              setIcon() { return this; },
              setSection() { return this; },
              setDisabled() { return this; },
              onClick() { return this; },
            });
            return this;
          },
        };
        guard();
        app.workspace.trigger('file-menu', menu, file, 'file-explorer-context-menu');
        assert.ok(titles.includes('Image Ledger: Edit image description'));
        assert.ok(titles.includes('Image Ledger: Delete image everywhere...'));
        titles.length = 0;
        const view = await open(source);
        const offset = view.editor.getValue().indexOf(embed(jpeg, source, 'Edited synthetic JPEG.'));
        assert.ok(offset >= 0);
        view.editor.setCursor(view.editor.offsetToPos(offset + 3));
        guard();
        app.workspace.trigger('editor-menu', menu, view.editor, view);
        assert.ok(titles.includes('Image Ledger: Edit image description'));
        assert.ok(titles.includes('Image Ledger: Delete image everywhere...'));
      });
      await step('Keep interrupted capture staged for app reload', async () => {
        await capture('fixtures/sample.png', other, 'clipboard');
        await modal();
        const pending = await wait(async () => {
          const pending = await plugin().library.store.pendingCaptures();
          return pending.length === 1 ? pending[0] : null;
        }, 'durable pending capture');
        fs.writeFileSync(path.join(directory, 'checkpoint.json'), JSON.stringify({
          runId: config.runId,
          pngId: image('.png').id,
          pendingId: pending.id,
        }), {flag: 'wx'});
      });
      receipt.status = 'AWAITING_RELOAD';
    } else {
      const checkpoint = JSON.parse(read('.image-ledger-smoke/checkpoint.json'));
      assert.equal(checkpoint.runId, config.runId, 'Stale reload checkpoint');
      await step('Recover pending capture through description dialog after reload', async () => {
        const pending = await plugin().library.store.pendingCaptures();
        assert.ok(pending.some(item => item.id === checkpoint.pendingId), 'Capture staging disappeared');
        assert.equal(app.commands.executeCommandById('image-ledger:recover-captures'), true);
        submit(await modal(), 'Recovered synthetic PNG.');
        await wait(() => saved('.png', 'Recovered synthetic PNG.', other), 'recovered capture');
        assert.equal(image('.png').id, checkpoint.pngId);
        assert.ok(read(source).includes(embed(image('.png'), source, 'Recovered synthetic PNG.')));
      });
      await step('Image-only library and completed recovery', async () => {
        checkImages();
        for (const folder of ['staging', 'operations']) {
          const directory = path.join(root, '.image-ledger', folder);
          assert.deepEqual(fs.existsSync(directory) ? fs.readdirSync(directory) : [], []);
        }
        const audit = await plugin().library.store.audit();
        assert.equal(audit.interrupted, 0);
        assert.deepEqual(audit.issues, []);
        receipt.images = images();
      });
      receipt.status = 'PASS';
    }
  } catch (error) {
    receipt.status = 'FAIL';
    receipt.error = String(error.stack ?? error);
  }
  receipt.finishedAt = new Date().toISOString();
  save();
  return receipt.status;
};
module.exports.verifyVault = verifyVault;
