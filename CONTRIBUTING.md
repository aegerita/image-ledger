# Contributing to Image Ledger

For installation and everyday use, see the [README](README.md).

## Development setup

Use Node.js 22 or later and npm:

```sh
npm ci
npm test
```

`npm test` checks TypeScript, builds `main.js`, and runs the unit/filesystem tests. `npm run dev` rebuilds on source changes; it does not install the build into a vault. `npm run build` produces a single build without running tests.

## Find the code

| File | Responsibility |
| --- | --- |
| `src/main.ts` | Plugin startup, commands, and event registration. |
| `src/captures.ts` | Capture batches, description prompts, and recovery on one shared queue. |
| `src/images/` | Image model, byte validation/metadata, record formats, managed embed lookup, and queued record mutations. No Obsidian imports. |
| `src/obsidian/notes.ts` | Editor tracking, insertion positions, and image embeds in notes. |
| `src/obsidian/library.ts` | Record initialization, description synchronization, renames, and audits. |
| `src/obsidian/ui.ts` | Description dialog, image picker, and settings tab. |
| `src/obsidian/vault-io.ts`, `anchors.ts` | Filesystem access and CodeMirror insertion state. |
| `src/settings.ts` | Saved settings and defaults. |

Capture flow: stage received bytes, prepare or reuse an image, ask for a description, insert into the original note, then clear staging. Preserve that order so interrupted captures remain recoverable. Renames and recovery share the capture queue. Descriptions edited in Bases are read back before capture processing; avoid replacing them with stale values.

`images/ids.ts` generates 12 lowercase hex characters from six random bytes and validates both short IDs and existing UUIDs. SHA-256 remains separate. Before staging, check the catalog, indexed filenames, pinned output paths, and hidden receipts; reserve the ID exclusively in `.image-ledger/ids/`. Retry collisions up to 100 times. Keep these empty reservation files after cleanup or deletion so IDs cannot be reused. There is no deletion subsystem yet; future deletion must preserve reservations. Catalog scans reject the same ID with different hashes. XMP stores short IDs literally and UUIDs as `urn:uuid:<id>`.

`MediaStore` owns one queue for record scans, capture descriptions, renames, and reconciliation. Existing-record changes share a read/apply/compare-and-swap loop; raw persistence is private. Description saves keep the submitted caption across unrelated property edits, while a newer saved caption/status pair wins. Writes compare the original text inside Obsidian's atomic `Vault.process` callback and reapply the change to current fields on conflict.

Before changing notes, the store atomically saves the semantic intent and baseline in `.image-ledger/operations/<image-id>.json`. `operations.ts` validates these receipts. `NoteImages` checkpoints each note's exact before/after text and eligible embed ranges before applying it; its callback must not call queued store operations. Retries and startup replay use these persisted ranges, preserving untouched custom captions. A newly added reference starts from the current saved snapshot.

Startup replays unfinished saves before reconciliation. A new mutation of the same image must first finish its previous save. Each attempt records its target snapshot before writing; a matching saved snapshot proves the commit happened, so recovery preserves later Bases edits even when cleanup failed. Notes, XMP, and the record are replayable; only a completed save removes its receipt. Independently changed or missing planned notes stop recovery with the receipt retained. This is process-interruption recovery with conservative conflicts, not a transaction across multiple plugin instances. Receipts temporarily contain source-note text and remain local vault data.

Record-folder renames retarget affected receipts before replay. Startup can locate a missing record by one matching ID filename, record ID, and image hash, including when the rename handler never ran. Multiple matches stop recovery. The receipt keeps its historical target snapshot as commit evidence; the discovered file location becomes the record's current path on commit.

Keep related behavior together. Extract a module when it has a clear job; avoid adding layers or folders just to shorten a file. Linear holds active plans; this guide describes the current code.

This is one plugin package, following the [Obsidian sample plugin](https://github.com/obsidianmd/obsidian-sample-plugin) layout. Supporting scripts live in `scripts/`. Synthetic fixture generators are tracked in `tests/fixtures.ts` and `scripts/test-vault.ts`; their generated `test-vaults/` output stays ignored.

## Verify changes

Run `npm test` for code changes. For plugin or UI changes, also run:

```sh
npm run test:obsidian
```

The host test creates a fresh synthetic vault and uses Obsidian's CLI/API. Read [TESTING.md](TESTING.md) for prerequisites, receipts, and coverage limits. Never test in a personal vault or use native GUI automation. Documentation-only edits need a link and accuracy check.

## Install a build

For development, prefer the isolated vault created by `npm run test:vault`. You can install into an existing development vault with:

```sh
npm run build
npm run install:vault -- --vault /absolute/path/to/development-vault
```

The vault must already contain `.obsidian/`. The installer copies the three plugin files, preserves saved Image Ledger settings, and adds `images/` and `.image-ledger/` to the vault's Git ignore rules. Reload the plugin after each install.

Optional `--enable` updates the saved community-plugin list, disables `obsidian-imgur-plugin`, and saves the prior list under `.image-ledger/`. It does not reload an open Obsidian window or configure sync exclusions.

## Before submitting

Describe the user-visible change and checks run. Keep generated builds, dependencies, test vaults, and personal data out of commits. Update the README when the user workflow changes; keep technical details here and test procedures in TESTING.md.

Use an issue branch such as `codex/obs-7-github-setup` and include `OBS-7` in its pull request title. Link the Linear issue in the pull request description. Repository access for automatic linking is configured through [Linear's GitHub integration](https://linear.app/docs/github-integration).

## Prepare a release

Update the version in `package.json`, `package-lock.json`, and `manifest.json`, and add its minimum Obsidian version to `versions.json`. The tests check that these agree. After changes pass review, push a tag matching the version exactly, such as `0.1.0`, without a `v` prefix.

The release workflow runs `npm test`, checks the tag, and creates a draft with `main.js`, `manifest.json`, and `styles.css`. Review the draft and run the local Obsidian host test before publishing. Update the README installation steps when the first downloadable release is published.
