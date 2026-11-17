# Testing Image Ledger

Use ExifTool 13.58 or 13.63. Set `EXIFTOOL` to its absolute executable path for the codec tests and host runner.

```sh
EXIFTOOL=/absolute/path/to/exiftool npm test
```

This type-checks and builds the plugin, then tests image validation, caption readback and add/edit/remove, export/reimport identity, metadata preservation, duplicate capture, guarded replacement, restart recovery, embed handling, and recoverable deletion. Without a supported executable, the codec integration tests may skip. CI runs those checks with ExifTool 13.58.

## Obsidian host test

```sh
EXIFTOOL=/absolute/path/to/exiftool npm run test:obsidian
```

Requires macOS, a running Obsidian app at `/Applications/Obsidian.app`, an initialized open vault, and the Obsidian CLI enabled. The runner builds the plugin and opens a fresh synthetic vault. The already open vault is never a test destination.

Keep the **90-second deadline**, including the build. The runner verifies the canonical vault path, generated-vault marker, fixture hashes, plugin allowlist, build hashes and ExifTool identity before enabling community plugins in that vault. Host calls recheck the selected path and run identity. Keep the nonce checks, bounded waits and JSON receipts.

The host exercises actual description dialogs, the image picker, editor and file menu handlers, generated paste/drop, duplicate reuse, **Describe later** after closing the source editor, and interrupted capture recovery after reload. Final checks compare normalized filenames, embedded descriptions, fixture metadata, saved note embeds and empty staging. They also check for any generated record, sidecar or Bases file.

Computer-use tools and native GUI automation are prohibited, including screenshots, coordinate clicks, simulated keyboard/mouse input, accessibility/AppleScript UI scripting and Finder/clipboard gestures. Use direct CLI/API calls and programmatic DOM handlers only. If the runner fails, diagnose it or report `FAIL` / `NOT RUN` with the blocker and retained receipt. Generated events leave native clipboard conversion, Finder gestures and native menu targeting unverified.

## Create fixtures for development

```sh
EXIFTOOL=/absolute/path/to/exiftool npm run test:vault
# Choose a new directory whose parent already exists.
EXIFTOOL=/absolute/path/to/exiftool npm run test:vault -- --vault /absolute/path/to/new-test-vault
```

This creates an ignored `test-vaults/ImageLedger-*` folder with the current build, generated images and synthetic notes. Existing destinations are refused. Never install a test build in a personal vault or copy personal notes, settings, or credentials into fixtures.

## Report results

Keep the generated vault and its `.image-ledger-smoke/` JSON receipts locally, including failures. Store dated summaries in ignored `docs/smoke-tests/` or attach them to Linear. Report the vault path, result, duration, checks run, image and staging counts, and unverified native boundaries. A timeout, missing receipt, or historical result is not a current pass.
