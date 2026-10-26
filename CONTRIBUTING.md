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
| `src/images/` | Image model, byte validation/metadata, record formats, and storage. No Obsidian imports. |
| `src/obsidian/notes.ts` | Editor tracking, insertion positions, and image embeds in notes. |
| `src/obsidian/library.ts` | Record initialization, description synchronization, renames, and audits. |
| `src/obsidian/ui.ts` | Description dialog, image picker, and settings tab. |
| `src/obsidian/vault-io.ts`, `anchors.ts` | Filesystem access and CodeMirror insertion state. |
| `src/settings.ts` | Saved settings and defaults. |

Capture flow: stage received bytes, prepare or reuse an image, ask for a description, insert into the original note, then clear staging. Preserve that order so interrupted captures remain recoverable. Renames and recovery share the capture queue. Descriptions edited in Bases are read back before capture processing; avoid replacing them with stale values.

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
