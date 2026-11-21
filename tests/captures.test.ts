import assert from 'node:assert/strict';
import test from 'node:test';
import { CaptureWorkflow } from '../src/captures';
import { UnreadableImageError } from '../src/images/identity';
import { JPEG, PNG } from './fixtures';
import { storageFixture } from './storage-fixture';
import type { ManagedImage } from '../src/images/model';

function captures(f: ReturnType<typeof storageFixture>, describe: () => Promise<string | null> = async () => 'Caption') {
  const errors: unknown[] = [];
  const synced: [string, string][] = [];
  let recovered: ManagedImage | undefined;
  const workflow = new CaptureWorkflow(f.store, {
    sourceNote: () => ({} as never),
    recover: async image => { recovered = image; },
    syncDescription: async (previous, next) => {
      synced.push([previous.description, next.description]);
      return {updated: 0, skipped: 0, conflicts: []};
    },
  }, {describe, notify: () => {}, report: error => { errors.push(error); }});
  return {workflow, errors, synced, recovered: () => recovered};
}

const file = () => new File([JPEG], 'synthetic.jpg', {type: 'image/jpeg'});

test('capture embeds a batch once, silently reuses described duplicates, and releases the target', async () => {
  const f = storageFixture();
  let prompts = 0;
  let released = 0;
  const results: ManagedImage[][] = [];
  const {workflow, errors} = captures(f, async () => { prompts++; return 'Caption'; });
  const target = {path: 'Note.md', insert: async (images: ManagedImage[]) => { results.push(images); }, release: () => { released++; }};
  workflow.capture([file(), file()], target, 'clipboard');
  await workflow.enqueue(async () => {});
  assert.equal(results[0].length, 1);
  assert.equal(prompts, 1);
  assert.equal(released, 1);
  assert.deepEqual(errors, []);
  assert.deepEqual(await f.store.pendingCaptures(), []);
});

test('failed note insertion retains staging and restart recovery inserts the committed image', async () => {
  const f = storageFixture();
  const first = captures(f);
  let released = false;
  first.workflow.capture([file()], {path: 'Note.md', insert: async () => { throw new Error('Note save failed'); }, release: () => { released = true; }}, 'clipboard');
  await first.workflow.enqueue(async () => {});
  assert.equal(first.errors.length, 1);
  assert.equal(released, true);
  assert.equal((await f.store.pendingCaptures()).length, 1);
  const restarted = captures(f);
  restarted.workflow.recover();
  await restarted.workflow.enqueue(async () => {});
  assert.equal(restarted.recovered()?.description, 'Caption');
  assert.deepEqual(await f.store.pendingCaptures(), []);
});

test('capture discards staging only when preparation finds unreadable metadata', async t => {
  const cases = [
    {method: 'prepare', error: new UnreadableImageError(new Error('Invalid XMP')), completed: 1, stagedFiles: 0},
    {method: 'prepare', error: new Error('ExifTool failed'), completed: 0, stagedFiles: 2},
    {method: 'describe', error: new UnreadableImageError(new Error('Invalid generated XMP')), completed: 0, stagedFiles: 2},
  ] as const;
  for (const {method, error, completed, stagedFiles} of cases) {
    const f = storageFixture();
    t.mock.method(f.store, method, async () => { throw error; });
    const complete = t.mock.method(f.store, 'complete');
    const {workflow, errors} = captures(f);
    workflow.capture([file()], {
      path: 'Note.md',
      insert: async () => assert.fail('Failed capture must not be inserted'),
      release: () => {},
    }, 'clipboard');
    await workflow.enqueue(async () => {});
    assert.deepEqual(errors, [error]);
    assert.equal(complete.mock.callCount(), completed);
    assert.equal((await f.io.pendingPaths()).length, stagedFiles);
  }
});

test('missing recovery note preserves staged data and image', async () => {
  const f = storageFixture();
  await f.store.stage({bytes: JPEG}, 'Gone.md');
  const errors: unknown[] = [];
  const workflow = new CaptureWorkflow(f.store, {
    sourceNote: () => undefined,
    recover: async () => {},
    syncDescription: async () => assert.fail('Missing note must not be updated'),
  }, {
    describe: async () => 'Caption', notify: () => {}, report: error => { errors.push(error); },
  });
  workflow.recover();
  await workflow.enqueue(async () => {});
  assert.equal(errors.length, 1);
  assert.equal((await f.store.pendingCaptures()).length, 1);
});

test('a description added by a later duplicate keeps the first insertion position', async () => {
  const f = storageFixture();
  const captions = [null, 'PNG caption', 'JPEG caption'];
  const {workflow, errors, synced} = captures(f, async () => captions.shift() ?? null);
  const embedded: ManagedImage[] = [];
  const target = {
    path: 'Note.md',
    insert: async (images: ManagedImage[]) => { embedded.push(...images); },
    release: () => {},
  };
  const png = new File([PNG], 'synthetic.png', {type: 'image/png'});
  workflow.capture([file(), png, file()], target, 'clipboard');
  await workflow.enqueue(async () => {});
  assert.deepEqual(errors, []);
  assert.deepEqual(embedded.map(image => image.description), ['JPEG caption', 'PNG caption']);
  assert.deepEqual(synced, [['', 'JPEG caption']]);
});
