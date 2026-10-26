import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('release metadata agrees on plugin version and minimum Obsidian version', async () => {
  const readJson = async (file: string) => {
    const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    return JSON.parse(source);
  };
  const manifest = await readJson('manifest.json');
  const packageInfo = await readJson('package.json');
  const lock = await readJson('package-lock.json');
  const versions = await readJson('versions.json');

  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(packageInfo.version, manifest.version);
  assert.equal(lock.version, manifest.version);
  assert.equal(lock.packages[''].version, manifest.version);
  assert.equal(versions[manifest.version], manifest.minAppVersion);
});
