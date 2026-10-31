# Testing Image Ledger

## Unit and filesystem checks

```sh
npm test
```

This checks TypeScript, builds the plugin, and tests image validation, byte identity, metadata, records/XMP, description conflicts, anchors, duplicate reuse, storage policies, recovery, and test-vault isolation. Partial-save tests rebuild runtime objects from persisted data after note, sidecar, record, and receipt-cleanup failures, then recover twice. It does not exercise the loaded Obsidian app.

Description synchronization tests cover indexed copied references, custom alt preservation, explicit per-embed overwrite, opt-in synchronization, wiki and missing-note reporting, code exclusions, unsupported indexed note paths, multiline and reference-style skips, and restart during an update to a discovered note. Host checks also overwrite two skipped embeds in one review, verifying refreshed positions and disabled overwrite actions for unsupported forms.

Embed lookup tests cover line positions, selections, repeated targets, nested custom alt text, normalized relative targets and parenthesis URL forms. Code, escaped markers, HTML comments, frontmatter and Image details links must not match. Fake-menu tests cover editor/image/record targets, unrelated targets, refreshed descriptions, target identity after switching notes, and records removed after a menu opens. Host checks exercise cursor-directed editing, note-first and all-image pickers, thumbnails, search, newest-first order, and the visible result cap.

The generated-vault menu prototype records Source and Live Preview API event delivery with supplied editor positions. It invokes registered `editor-menu` and `file-menu` handlers using fake menus, then runs their callbacks against real description dialogs. Reading View is explicitly excluded even when Obsidian retains an editor object; the command uses saved note text there. Native right-click event delivery, cursor placement and rendered-image hit targeting are **NOT RUN** in every mode. The API prototype does not establish those native boundaries. Do not add a native-gesture fallback.

ID tests force collisions with files, receipts, and permanent reservations, race concurrent captures, bound retries, and recover legacy UUID captures. Closed-editor tests check insertion into the original note and retained staging when that note is missing. The host checks verify short filenames, literal XMP identifiers, retained reservations through capture and reload, and insertion after detaching the original Markdown leaf during its description dialog.

GitHub Actions runs this command with Node.js 22 on Ubuntu for every push and pull request. The `Build and test` job checks the build and unit/filesystem tests. Obsidian host checks remain local because they require a running app and its enabled CLI.

## Obsidian host test

```sh
npm run test:obsidian
```

Requires macOS, a running Obsidian app at `/Applications/Obsidian.app`, an initialized open vault, and the Obsidian CLI enabled. The runner builds the plugin and creates a fresh synthetic vault; the already open vault is not a test destination.

The runner checks the exact canonical vault path, generated-vault marker, fixture hashes, plugin allowlist, and current build hashes before enabling community plugins in that vault. Every host call checks the target path again. Keep these guards, nonce checks, bounded readiness waits, and the **90-second deadline**, including the build.

Checks cover description dialogs, Bases edits and links, description saves racing reordered or newly added source references, matching custom alt text during a concurrent caption edit, generated paste/drop events, duplicate reuse, note switching, Describe later, description editing, and recovery after an app reload. Before that reload, the runner interrupts one save after its first note and another after its notes but before its record write, then renames the record folder while both saves remain interrupted. Recovery must use the moved records without recreating the old folder. File assertions check records, payload hashes, metadata, XMP, embeds, staging, save-receipt cleanup, and final audit counts.

Computer-use tools and native GUI automation are prohibited, including screenshots, coordinate clicks, simulated keyboard/mouse input, accessibility/AppleScript UI scripting, and Finder/clipboard gestures. Direct CLI/API calls and programmatic DOM handlers are allowed. If the runner fails, diagnose or repair it, or report `FAIL` / `NOT RUN` with the actual blocker and retained receipt. Never use a native UI fallback or extend the deadline to try one.

Generated paste/drop events do not establish native macOS clipboard conversion or Finder gesture behavior. Leave those boundaries unverified. The runner uses private app APIs and Bases DOM selectors, so an Obsidian update may require a runner change.

## Create fixtures for development

```sh
npm run test:vault
# Or choose a new directory whose parent already exists:
npm run test:vault -- --vault /absolute/path/to/new-test-vault
```

This creates an ignored `test-vaults/ImageLedger-*` folder with the current build, two generated images, two synthetic notes, and isolated settings. Existing directories, files, and symlinks are refused; there is no reset mode. Routine host tests create and verify their own vaults.

All tests use fresh synthetic vaults. Never test or install a test build in the personal Journal vault, or copy personal notes, settings, or credentials into fixtures.

## Report results

Keep the generated vault and its `.image-ledger-smoke/` JSON receipts locally, including failures. Store dated summaries in ignored `docs/smoke-tests/` or attach them to Linear. Do not commit reports or raw receipts. Report:

- Date, Obsidian version, vault path, build identity, duration, and exit status.
- Which unit and host checks ran, with `PASS`, `FAIL`, or `NOT RUN` outcomes.
- Payload/record/sidecar checks, description/embed consistency, duplicate counts, and final staging/audit counts.
- API/DOM methods exercised and unverified OS boundaries.

A timeout, missing receipt, or historical result is not a current pass. Do not repeat a successful check unless a new change or unresolved concern warrants it.

Only current record, settings, and staging formats are supported. Malformed receipts must retain their payloads; recovery never infers a missing storage destination.

Follow this guide and [AGENTS.md](AGENTS.md) for current procedures.
