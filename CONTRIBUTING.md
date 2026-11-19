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
| `src/captures.ts` | Capture batching, description prompts, and recovery on a shared queue. |
| `src/images/description.ts` | ExifTool caption reads and verified writes. |
| `src/images/identity.ts`, `xmp.ts` | Versioned JPEG/PNG identity and XMP normalization. |
| `src/images/store.ts` | Catalog from image filenames, deduplication, staging, and deletion recovery. |
| `src/images/markdown.ts`, `embeds.ts` | Relative embeds and Lezer-based reference parsing. |
| `src/obsidian/notes.ts`, `anchors.ts` | Tracked editor insertion, recovery, and guarded note edits. |
| `src/obsidian/library.ts`, `ui.ts` | Image picker, context menus, descriptions, deletion preview, and settings. |
| `src/obsidian/vault-io.ts` | Vault path validation, atomic image publication and replacement, and Trash. |

The v2 ID hashes the encoded image and metadata without invoking ExifTool. It normalizes XMP packet layout, the default description, the toolkit marker, PNG text and EXIF chunk placement, and JPEG MPF offsets affected by caption length. It includes alternate-language captions, EXIF, ICC, and all trailing images. Treat the hash format as permanent. The codec uses bounded ExifTool calls in private temporary directories and checks caption readback and v2 identity before returning new bytes.

Both filename generations use bare SHA-256 hex. A filename that differs from the current digest can still serve as a path alias. Capture compares the current identity from file bytes and verifies a duplicate before reusing its path. A temporary cache avoids rereading unchanged candidates. Edits and deletion receipts use the actual file checksum.

Capture stages received bytes, computes the identity and checks for an existing image, then saves the image before inserting the embed. Its temporary receipt records the original note and the verified image path. Finish note insertion before clearing staging. Note renames retarget pending captures, and interrupted cleanup can reuse the committed image.

Description editing checks the image checksum captured before the dialog, then publishes the verified replacement at the same path. Deletion stores the approved before and after note text and the exact image checksum in a temporary receipt. Recovery recomputes the embed ranges, stops on independent edits, and uses Obsidian's Trash. Receipts may temporarily contain source note text. File checks and queues protect local operations; concurrent writes from another vault instance are outside that guarantee.

## Verify changes

Run the unit and host commands in [TESTING.md](TESTING.md) for plugin changes.

The host test creates a fresh synthetic vault and uses Obsidian's CLI/API. Never test in a personal vault or use native GUI automation. Documentation-only edits need a link and accuracy check.

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
