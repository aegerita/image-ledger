import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assertSelectedVault, cliInvocation, runCommand, validateFinalVault, verifyTrustTarget, waitForReady, waitForReceipt, waitForSelectedVault } from '../scripts/obsidian-smoke';
import { createTestVault, markerName } from '../scripts/test-vault';
import { sha256 } from '../src/images/media';

const host = createRequire(import.meta.url)('../scripts/obsidian-smoke-host.cjs');
const runId = randomUUID();

async function temporaryDirectory(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'image-ledger-smoke-test-'));
}

async function guardedFixture() {
  const parent = await temporaryDirectory();
  const vault = await createTestVault(path.join(parent, 'generated vault'));
  const artifacts = Object.fromEntries(await Promise.all(['main.js', 'manifest.json', 'styles.css'].map(async name => [name, sha256(await readFile(path.join(vault, '.obsidian/plugins/image-ledger', name)))])));
  const config = { vault, runId: randomUUID(), phase: 'main', deadline: Date.now() + 10000, artifacts };
  const app = { vault: { adapter: { getBasePath: () => vault } } };
  return { parent, vault, app, config };
}

test('CLI preserves spaced paths and code as individual arguments, with vault before eval', () => {
  const binary = '/Applications/Obsidian App.app/Contents/MacOS/Obsidian';
  const code = 'void "quotes \\" and $(not-a-shell) `literal`"';
  const invocation = cliInvocation(binary, '/private/tmp/Vault with spaces', code);
  assert.equal(invocation.command, '/usr/bin/script');
  assert.deepEqual(invocation.args, ['-q', '/dev/null', binary, 'vault=Vault with spaces', 'eval', `code=${code}`]);
  assert.deepEqual(cliInvocation(binary, undefined, code).args, ['-q', '/dev/null', binary, 'eval', `code=${code}`]);
});

test('stale completed receipts cannot pass a different run or phase', async () => {
  const parent = await temporaryDirectory();
  try {
    const receipt = path.join(parent, 'receipt.json');
    for (const invalid of [{ runId: randomUUID(), phase: 'main' }, { runId, phase: 'recovery' }]) {
      await writeFile(receipt, JSON.stringify({ ...invalid, status: 'PASS' }));
      await assert.rejects(waitForReceipt(receipt, { runId, phase: 'main' }, ['PASS'], Date.now() + 500));
    }
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test('host failure is surfaced, and a valid completed receipt is accepted', async () => {
  const parent = await temporaryDirectory();
  try {
    const receipt = path.join(parent, 'receipt.json');
    await writeFile(receipt, JSON.stringify({ runId, phase: 'main', status: 'FAIL', error: 'Intentional host failure' }));
    await assert.rejects(waitForReceipt(receipt, { runId, phase: 'main' }, ['PASS'], Date.now() + 500), /Intentional host failure/);
    await writeFile(receipt, JSON.stringify({ runId, phase: 'main', status: 'PASS' }));
    assert.equal((await waitForReceipt(receipt, { runId, phase: 'main' }, ['PASS'], Date.now() + 500)).status, 'PASS');
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test('missing and unfinished results have bounded waits', async () => {
  const parent = await temporaryDirectory();
  try {
    const receipt = path.join(parent, 'receipt.json');
    const started = Date.now();
    await assert.rejects(waitForReceipt(receipt, { runId, phase: 'main' }, ['PASS'], Date.now() + 50), /tim|deadline|budget/i);
    await writeFile(receipt, JSON.stringify({ runId, phase: 'main', status: 'RUNNING' }));
    await assert.rejects(waitForReceipt(receipt, { runId, phase: 'main' }, ['PASS'], Date.now() + 50), /tim|deadline|budget/i);
    assert.ok(Date.now() - started < 1500, 'Result polling exceeded its short deadlines.');
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test('CLI subprocess failures and stalls cannot outlive their deadline', async () => {
  await assert.rejects(runCommand(process.execPath, ['-e', 'process.exit(3)'], Date.now() + 2000), /exit|fail|code/i);
  const started = Date.now();
  await assert.rejects(runCommand(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], Date.now() + 2000, { timeoutMs: 100 }), /tim|deadline|budget/i);
  assert.ok(Date.now() - started < 1500, 'Stalled subprocess exceeded its short timeout.');
});

test('host guard rejects a different active vault without changing it', async () => {
  const f = await guardedFixture();
  try {
    const sentinel = path.join(f.parent, 'sentinel.md');
    await writeFile(sentinel, 'keep');
    host.verifyVault(f.app, f.config);
    const wrongApp = { vault: { adapter: { getBasePath: () => f.parent } } };
    assert.throws(() => host.verifyVault(wrongApp, f.config), /Wrong vault/);
    assert.equal(await readFile(sentinel, 'utf8'), 'keep');
  } finally { await rm(f.parent, { recursive: true, force: true }); }
});

test('host guard rejects an invalid marker and changed fixture before app actions', async () => {
  const f = await guardedFixture();
  try {
    const markerPath = path.join(f.vault, markerName);
    const marker = await readFile(markerPath, 'utf8');
    await writeFile(markerPath, JSON.stringify({ ...JSON.parse(marker), version: 99 }));
    assert.throws(() => host.verifyVault(f.app, f.config), /generated test vault/);
    await writeFile(markerPath, marker);
    await writeFile(path.join(f.vault, 'fixtures/sample.png'), 'changed fixture');
    assert.throws(() => host.verifyVault(f.app, f.config), /Fixture changed/);
  } finally { await rm(f.parent, { recursive: true, force: true }); }
});

for (const storage of ['', '2042']) test(`final validation discovers ${storage || 'flat'} storage and skips hidden state and fixtures`, async () => {
  const f = await guardedFixture();
  try {
    for (const folder of [storage, '.ignored/2042', 'fixtures/2042']) {
      for (const kind of ['images', 'image-records']) await mkdir(path.join(f.vault, folder, kind), {recursive: true});
      for (const id of ['one', 'two']) {
        await writeFile(path.join(f.vault, folder, 'image-records', id + '.md'), 'invalid synthetic record');
        await writeFile(path.join(f.vault, folder, 'images', id + '.png'), 'synthetic payload');
      }
    }
    await assert.rejects(validateFinalVault(f.vault, f.config.artifacts), new RegExp(`Invalid record: ${storage ? storage + '/' : ''}image-records/`));
  } finally {await rm(f.parent, {recursive: true, force: true});}
});

test('host guard rejects plugin artifact drift and expired execution', async () => {
  const f = await guardedFixture();
  try {
    host.verifyVault(f.app, f.config);
    assert.throws(() => host.verifyVault(f.app, { ...f.config, deadline: Date.now() - 1 }), /deadline/i);
    await writeFile(path.join(f.vault, '.obsidian/plugins/image-ledger/main.js'), 'changed build');
    assert.throws(() => host.verifyVault(f.app, f.config), /Plugin build changed/);
  } finally { await rm(f.parent, { recursive: true, force: true }); }
});


test('readiness retries a dropped startup evaluation and accepts only its nonce', async () => {
  const parent = await temporaryDirectory();
  try {
    const file = path.join(parent, 'ready.json');
    const expected = { runId: randomUUID(), phase: 'main' as const, nonce: randomUUID(), vault: parent };
    let calls = 0;
    await waitForReady(file, expected, Date.now() + 1500, async timeoutMs => {
      assert.ok(timeoutMs > 0 && timeoutMs <= 2000, 'Startup evaluation must have a short bounded timeout.');
      calls++;
      if (calls === 2) await writeFile(file, JSON.stringify({ ...expected, status: 'READY' }));
      return calls === 1 ? 'Startup evaluation dropped' : 'Acknowledgment written';
    });
    assert.equal(calls, 2);
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test('readiness rejects stale nonce and phase acknowledgments', async () => {
  const parent = await temporaryDirectory();
  try {
    const expected = { runId: randomUUID(), phase: 'main' as const, nonce: randomUUID(), vault: parent };
    for (const invalid of [{ nonce: randomUUID() }, { phase: 'recovery' }]) {
      const file = path.join(parent, `stale-${Object.keys(invalid)[0]}.json`);
      await writeFile(file, JSON.stringify({ ...expected, ...invalid, status: 'READY' }));
      await assert.rejects(waitForReady(file, expected, Date.now() + 500, async () => 'No new acknowledgment'));
    }
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test('missing readiness is bounded and reports the last transport output', async () => {
  const parent = await temporaryDirectory();
  try {
    const expected = { runId: randomUUID(), phase: 'recovery' as const, nonce: randomUUID(), vault: parent };
    const started = Date.now();
    await assert.rejects(waitForReady(path.join(parent, 'missing.json'), expected, Date.now() + 100, async () => 'No vault selected'), /No vault selected/);
    assert.ok(Date.now() - started < 1500, 'Missing startup acknowledgment exceeded its deadline.');
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test('zero-exit CLI evaluation errors fail instead of being treated as transport success', async () => {
  await assert.rejects(runCommand(process.execPath, ['-e', 'console.log("Error: bridge unavailable")'], Date.now() + 2000), error => {
    return error instanceof Error && (error as Error & { code?: string }).code === 'CLI_EVAL_ERROR' && error.message.includes('bridge unavailable');
  });
});


test('readiness retries only the exact startup eval-registration error', async () => {
  const parent = await temporaryDirectory();
  try {
    const file = path.join(parent, 'ready.json');
    const expected = {runId, phase: 'main' as const, nonce: randomUUID(), vault: parent};
    let calls = 0;
    await waitForReady(file, expected, Date.now() + 2000, async () => {
      calls++;
      if (calls === 1) throw Object.assign(new Error('CLI eval error: Error: Command "eval" not found. It may require a plugin to be enabled.'), {code: 'CLI_EVAL_ERROR'});
      await writeFile(file, JSON.stringify({...expected, status: 'READY'}));
      return 'READY';
    });
    assert.equal(calls, 2);
    await rm(file);
    await assert.rejects(waitForReady(file, expected, Date.now() + 2000, async () => {
      throw Object.assign(new Error('CLI eval error: Error: unsupported bridge'), {code: 'CLI_EVAL_ERROR'});
    }), /unsupported bridge/);
  } finally {await rm(parent, {recursive: true, force: true});}
});


test('trust selection requires one exact canonical path line, not a substring', () => {
  const vault = '/private/tmp/Generated vault';
  assert.doesNotThrow(() => assertSelectedVault('Warning: old installer\r\n' + vault + '\r\n', vault));
  assert.throws(() => assertSelectedVault(vault + '-different\n', vault), /exact generated vault path/);
  assert.throws(() => assertSelectedVault(vault + '\n' + vault + '\n', vault), /exact generated vault path/);
});

test('trust refuses extra enabled or installed plugins before lowering restricted mode', async () => {
  const fixture = await guardedFixture();
  try {
    const vault = await realpath(fixture.vault);
    await verifyTrustTarget(vault, fixture.config.artifacts);
    const enabled = path.join(vault, '.obsidian/community-plugins.json');
    await writeFile(enabled, JSON.stringify(['image-ledger', 'unreviewed-plugin']));
    await assert.rejects(verifyTrustTarget(vault, fixture.config.artifacts), /unknown plugin/);
    await writeFile(enabled, JSON.stringify(['image-ledger']));
    await mkdir(path.join(vault, '.obsidian/plugins/unreviewed-plugin'));
    await assert.rejects(verifyTrustTarget(vault, fixture.config.artifacts), /another plugin/);
  } finally {await rm(fixture.parent, {recursive: true, force: true});}
});


test('vault selection waits only for the exact startup command-registration error', async () => {
  const vault = '/private/tmp/generated vault';
  let calls = 0;
  await waitForSelectedVault(vault, Date.now() + 2000, async () => {
    if (++calls === 1) throw Object.assign(new Error('CLI eval error: Error: Command "vault" not found. It may require a plugin to be enabled.'), {code: 'CLI_EVAL_ERROR'});
    return 'Installer warning\n' + vault + '\n';
  });
  assert.equal(calls, 2);
  await assert.rejects(waitForSelectedVault(vault, Date.now() + 2000, async () => '/private/tmp/another-vault\n'), /exact generated vault path/);
  await assert.rejects(waitForSelectedVault(vault, Date.now() + 2000, async () => {
    throw Object.assign(new Error('CLI eval error: Error: unknown command failure'), {code: 'CLI_EVAL_ERROR'});
  }), /unknown command failure/);
});
