# Verification

## Agent testing policy

The default live smoke test is **`npm run test:obsidian`**, using the Obsidian host CLI/API and programmatic DOM handlers. Computer-use tools and native GUI automation are prohibited for this project. Do not fall back to screenshots, coordinate clicks, simulated keyboard/mouse input, accessibility/AppleScript UI scripting, or Finder/clipboard gestures.

If the host test is blocked or fails, fix the bounded API runner or report `FAIL` / `NOT RUN` with the actual blocker and JSON receipt. Keep the 90-second deadline. Native-only behavior outside API coverage remains explicitly unverified; do not switch to computer use to cover it. See `AGENTS.md` for the project rules.

All future live tests use a generated synthetic vault. Never test in the personal Journal vault or copy its notes, plugin settings, or credentials into a test vault.

## Unit and filesystem checks

```sh
npm test
```

This builds the plugin and runs the Node tests. Coverage includes image validation, byte identity and EXIF, records/XMP, captions, anchors, duplicate reuse, interrupted writes/recovery, and fresh-vault setup. Temporary filesystem tests do not exercise the Obsidian UI.

## Default smoke test — Obsidian host API

```sh
npm run test:obsidian
```

Requires macOS, a running Obsidian application at `/Applications/Obsidian.app`, an initialized open vault, and its CLI enabled. The command builds the current plugin, creates and opens a fresh generated vault, and runs the checks through the loaded app. It does not use the personal journal as a test destination. Before enabling the generated vault's plugin, it verifies the CLI's exact canonical target path, marker, fixtures, plugin allowlist and current build hashes. It then uses `plugins:restrict off` only for that generated vault. This avoids its first-open trust dialog. Each host invocation checks the exact vault path again.

The suite exercises flat storage from an ordinary project note, duplicate reuse from a dated note, actual caption dialogs, actual Bases description editing and image/note links, generated paste/drop events, note switching, Describe later, the edit-description command, and recovery after a real app reload with a caption still open. It independently checks schema 2 records, reference links, payload hashes, metadata, snapshots, XMP, embeds and staging files. A clean audit notice must also appear.

The whole command has a **90-second deadline**, including its build. A missing dialog, failed assertion, unavailable CLI or wrong vault fails with a nonzero exit. There is no fallback into computer control. The printed generated vault and JSON receipts are retained for inspection, including failures.

This is a **real-host integration test**, not a native OS gesture test. Generated clipboard/drop events do not test macOS clipboard conversion or Finder drag gestures. Report those boundaries as unverified; do not use computer use to test them. The runner uses experimental/private app and plugin APIs plus Bases DOM selectors; an incompatible Obsidian update should fail promptly and may require a runner update.

## Create a separate test vault

```sh
npm run test:vault
# Optional: choose a new directory whose parent already exists.
npm run test:vault -- --vault /absolute/path/to/new-test-vault
```

The default creates a unique `test-vaults/ImageLedger-*` folder inside the repository, ignored by Git. Each run builds and copies only the current plugin artifacts, two generated image fixtures, two synthetic notes, and isolated Obsidian settings. Existing folders, files, and symlinks are refused without changes; there is no reset mode.

`test:vault` only creates fixtures for inspection or API-based test development. For routine smoke verification, run `npm run test:obsidian`; it creates, opens, and verifies its own isolated vault, including the guarded trust step. Do not open or configure a vault through native UI automation.

## Coverage boundaries

The host runner verifies received payloads and metadata, record/caption synchronization, actual Bases widgets and links, insertion after note switching, duplicate reuse, Describe later, and reload recovery through app APIs and DOM handlers. Unit/filesystem tests cover additional data and storage-policy cases. Extend those automated checks when new behavior needs coverage.

Generated clipboard/drop events do not establish native clipboard conversion or Finder gesture behavior. Leave unsupported boundaries `NOT RUN`. Historical native test results do not authorize a new native/computer-use test.

## Evidence checklist

Use the retained `.image-ledger-smoke/` JSON receipts and file assertions. Record:

- Date, Obsidian version, generated vault path, build identity, duration, and exit status.
- Unit/build results when run, plus each host check's `PASS`, `FAIL`, or `NOT RUN` outcome.
- Payload/record/sidecar hashes, metadata, caption/embed consistency, duplicate counts, and final staging/audit counts.
- The actual API/DOM methods exercised and any unverified OS boundaries.

A timeout, blocked action, missing receipt, or historical result is not a current pass. Keep failed vaults and receipts for diagnosis. Do not collect screenshots or start native UI automation as a verification fallback.

## Current format

Image Ledger is under development and supports only its current record, settings, and staging formats. There are no legacy-name aliases, migration backups, settings imports, or inferred recovery destinations. Staged captures must retain their explicit storage folder. Unit tests cover malformed current-format inputs and refuse them without deleting staged payloads.

## Previous image-model validation — 2026-10-24

Verified on 2026-10-24 for OBS-5 in Obsidian 1.14.5:

- PASS: `npm test` builds successfully and passes 65 tests. Coverage includes the image-centered schema, legacy settings/record/receipt migration, original-record backups, caption synchronization across migration, all storage policies, and safe installer upgrades.
- PASS: `npm run test:obsidian` completed all eight host checks in a fresh `ImageLedger-*` synthetic vault in **4.7 seconds**, including the build. Flat storage, schema 2, arbitrary note references, Bases edits, duplicate reuse, note switching, and real reload recovery passed. Final audit: two records, zero pending descriptions, zero missing images, zero staged captures.
- Native OS clipboard conversion and Finder gestures were not rerun. The personal journal was not used for testing or installation.

See [the OBS-5 report](docs/smoke-tests/2026-10-24-obs5.md) for the model, compatibility boundary, and receipts.

## Previous host-runner validation — 2026-10-23

Verified on 2026-10-23 in Obsidian 1.14.5:

- PASS: `npm test` builds successfully and passes 51 tests, including 16 smoke-runner isolation, trust, receipt and timeout checks.
- PASS: two consecutive `npm run test:obsidian` runs in fresh generated vaults, including their builds, took **13.620 seconds** and **4.529 seconds**. Both completed all eight host checks and independently verified two records, confirmed captions, matching payloads/metadata/XMP/embeds, and empty staging.
- The first-open trust gate is handled only after verifying the new synthetic vault and its sole bundled plugin. Startup and reload require explicit readiness acknowledgments. Every run has a 90-second deadline and produces JSON receipts; no native computer-control fallback runs.
- Native OS clipboard conversion and Finder gestures were not verified by this host run. Current policy leaves them unverified without computer-use testing.

See [the host-runner report](docs/smoke-tests/2026-10-23-host.md) and its JSON evidence.

## Previous mixed validation — 2026-10-22

Verified on 2026-10-22 in two fresh synthetic vaults, Obsidian 1.14.4:

- PASS: `npm test` builds successfully and passes 35 tests.
- PASS: native JPEG file import and Preview clipboard capture, with independent payload, metadata, record, XMP and embed checks. Preview supplied a transformed PNG rather than the original JPEG bytes.
- PASS: live app checks for cross-year duplicate reuse, actual Bases caption editing and image/journal links, note-switch insertion, Describe later, the edit-description command, caption-open reload/recovery, and final audits. These used the loaded plugin and real app controls through programmatic DOM/API actions; paste/drop handler inputs were synthetic events.
- PASS: both final audit notices and independent file checks report zero pending descriptions, zero missing files and zero interrupted captures.
- NOT RUN: the complete native mouse/keyboard protocol. Native Finder drag/drop, repeated duplicate file-picker selection, and the remaining native control paths are unverified. Computer control returned stale screens, `noWindowsAvailable` and timeouts; these are not plugin failures or passes.

See [the dated report](docs/smoke-tests/2026-10-22.md) for methods, hashes, receipts and remaining native gaps. This is mixed native/host validation, not a full native protocol pass. The one-off host runners are not included as a supported automated test framework. These dated results are historical evidence; the current API-only testing policy above applies.

## Historical live baseline

The following is retained evidence from before isolated-vault setup. It is not authorization or a procedure for future testing in the journal.

Historical verification on 2026-10-17 in the user's Journal vault, Obsidian 1.14.4 on macOS:

- Production build and 33 automated tests pass.
- Live synthetic JPEG paste created a UUID file, descriptive local embed, linked record and XMP.
- JPEG and PNG bytes exactly match their input fixtures. EXIF `2026:10:16 19:07:22`, subsecond `123`, source offset `-04:00`, orientation and camera metadata survived.
- Repeated JPEG paste reused the UUID and added no second image payload.
- Opening another note/Base during the caption prompt still inserted into the original test note.
- A description edited in the live Bases table updated both journal alt labels, the record's portable snapshot and XMP.
- Live PNG drop preserved its received bytes and source file modification timestamp.
- Reload with a staged PNG, followed by the recovery command, reused the existing image, synchronized the revised caption and cleared staging.
- The generated Base displayed both records with working property data. Journal Media was enabled and the competing Imgur paste plugin disabled.
- `git check-ignore` confirmed both image payloads and staging were ignored.

The dedicated `2026/Journal Media Test.md` and two small synthetic image records remain as reviewable examples. Existing diary entries and historical Imgur links were not migrated.

Not exercised with an actual phone clipboard during this run. The source-transfer metadata limitation still applies. Backup, remote upload, HEIC conversion and phone-album imports are outside phase 1.
