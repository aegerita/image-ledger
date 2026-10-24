# Verification

All future live tests use a generated synthetic vault. Never test in the personal Journal vault or copy its notes, plugin settings, or credentials into a test vault.

## Unit and filesystem checks

```sh
npm test
```

This builds the plugin and runs the Node tests. Coverage includes image validation, byte identity and EXIF, records/XMP, captions, anchors, duplicate reuse, interrupted writes/recovery, and fresh-vault setup. Temporary filesystem tests do not exercise the Obsidian UI.

## Automated Obsidian host smoke test

```sh
npm run test:obsidian
```

Requires macOS, a running Obsidian application at `/Applications/Obsidian.app`, an initialized open vault, and its CLI enabled. The command builds the current plugin, creates and opens a fresh generated vault, and runs the checks through the loaded app. It does not use the personal journal as a test destination. Before enabling the generated vault's plugin, it verifies the CLI's exact canonical target path, marker, fixtures, plugin allowlist and current build hashes. It then uses `plugins:restrict off` only for that generated vault. This avoids its first-open trust dialog. Each host invocation checks the exact vault path again.

The suite exercises file capture, cross-year duplicate reuse, actual caption dialogs, actual Bases description editing and image/journal links, generated paste/drop events, note switching, Describe later, the edit-description command, and recovery after a real app reload with a caption still open. It independently checks the final payload hashes, metadata, records, snapshots, XMP, embeds and staging files. A clean audit notice must also appear.

The whole command has a **90-second deadline**, including its build. A missing dialog, failed assertion, unavailable CLI or wrong vault fails with a nonzero exit. There is no fallback into computer control. The printed generated vault and JSON receipts are retained for inspection, including failures.

This is a **real-host integration test**, not a native OS gesture test. Generated clipboard/drop events do not test macOS clipboard conversion or Finder drag gestures. Use the manual protocol below for those boundaries. The runner uses experimental/private app and plugin APIs plus Bases DOM selectors; an incompatible Obsidian update should fail promptly and may require a runner update.

## Create a separate test vault

```sh
npm run test:vault
# Optional: choose a new directory whose parent already exists.
npm run test:vault -- --vault /absolute/path/to/new-test-vault
```

The default creates a unique `test-vaults/JournalMedia-*` folder inside the repository, ignored by Git. Each run builds and copies only the current plugin artifacts, two generated image fixtures, two synthetic notes, and isolated Obsidian settings. Existing folders, files, and symlinks are refused without changes; there is no reset mode.

In Obsidian, choose **File > Open Vault > Open folder as vault** and select the printed folder. Allow community plugins in this synthetic vault and enable only the bundled **Journal Media** plugin. Do not install it into the personal journal for testing. Open `2026/10/2026-10-17.md`.

## Computer-use protocol

Use this protocol for live Obsidian checks. Start with a fresh generated vault. Record the vault path and Obsidian version before any action. Verify the active window is the synthetic vault before each edit; mark a blocked action **NOT RUN** rather than redirecting it to another vault.

1. Import `fixtures/sample-exif.jpg` using **Journal Media: Import JPEG or PNG** into `2026/10/2026-10-17.md`. Save `Synthetic JPEG.`. Confirm its preview, local embed, UUID image, XMP, and record. The record must report `captured_at: "2026-10-17T12:34:56.0074-04:00"` and a SHA-256 matching the fixture.
2. Copy that generated image from an image viewer and paste into the note using the native clipboard. Save a caption. Confirm the received image displays and its record matches its saved payload hash. If the clipboard supplies unchanged bytes, confirm UUID reuse; if it transforms the image, record that difference rather than claiming byte preservation from the source.
3. Import the original `sample-exif.jpg` into `2027/01/2027-01-04.md`. Confirm the same UUID, one payload with the original fixture hash, and both note links in the record. Use the identical source file for this duplicate check.
4. Open **Journal Media: Open image library**. Edit the JPEG description through the Bases table to `Edited synthetic JPEG.`. Confirm the record properties, portable JSON snapshot, XMP, and generated alt text in both notes agree; open the image and journal links.
5. Drag `fixtures/sample.png` from the file manager into the first note. While its caption is open, switch to the second note if workspace navigation permits, then save `Synthetic PNG.`. If the modal blocks navigation, record the note-switch case as NOT RUN. Confirm PNG bytes match the fixture, insertion stayed in the first note, and the second note did not gain that PNG embed.
6. Create and open another fresh generated vault for this case and steps 7–8. Import `sample.png` and choose **Describe later**. Confirm the payload and record remain, `caption_status` is `pending`, and **Edit image description** can complete it. An already confirmed duplicate keeps its existing caption instead of becoming pending.
7. Paste a fixture, leave its caption open, and reload Obsidian before saving. After reload, run **Journal Media: Recover interrupted image captures** and save a caption. Confirm the recovered embed, intact matching payload, and empty `.journal-media/staging/`. Recovering a duplicate must reuse its UUID.
8. Run **Journal Media: Check image records**. Confirm zero missing files and zero interrupted captures; explain any descriptions intentionally left pending.

For a file-preserving import or drop, compare both SHA-256 values directly (replace the paths and UUID):

```sh
shasum -a 256 "/absolute/test-vault/fixtures/sample-exif.jpg" "/absolute/test-vault/2026/images/<uuid>.jpg"
```

Both values must match each other, the record's `sha256`, and the fixture hash in `.journal-media-test-vault.json`. Repeat for the PNG. Native clipboard sources may transform bytes or strip EXIF before the plugin receives them; report that boundary explicitly.

## Evidence checklist

Record each item as **PASS**, **FAIL**, or **NOT RUN**, with the failure or omission reason:

- Date, Obsidian version, generated vault path, and build commit.
- Unit/build command result and test count.
- Each protocol step above, with its result and supporting screenshot or file check.
- Image/record/sidecar paths, source and saved hashes, duplicate payload count, and recovery staging count.
- Native clipboard, native drop, Bases UI editing, Describe later, and reload method exercised.

Keep screenshots and a short results note with the test vault. A blocked action, timeout, or missing evidence is not a pass. Do not combine historical evidence with current results.

## Current validation

Verified on 2026-10-23 in Obsidian 1.14.5:

- PASS: `npm test` builds successfully and passes 51 tests, including 16 smoke-runner isolation, trust, receipt and timeout checks.
- PASS: two consecutive `npm run test:obsidian` runs in fresh generated vaults, including their builds, took **13.620 seconds** and **4.529 seconds**. Both completed all eight host checks and independently verified two records, confirmed captions, matching payloads/metadata/XMP/embeds, and empty staging.
- The first-open trust gate is handled only after verifying the new synthetic vault and its sole bundled plugin. Startup and reload require explicit readiness acknowledgments. Every run has a 90-second deadline and produces JSON receipts; no native computer-control fallback runs.
- Native OS clipboard conversion and Finder gestures remain manual checks. The host run does not claim those boundaries passed.

See [the host-runner report](docs/smoke-tests/2026-10-23-host.md) and its JSON evidence.

## Previous mixed validation — 2026-10-22

Verified on 2026-10-22 in two fresh synthetic vaults, Obsidian 1.14.4:

- PASS: `npm test` builds successfully and passes 35 tests.
- PASS: native JPEG file import and Preview clipboard capture, with independent payload, metadata, record, XMP and embed checks. Preview supplied a transformed PNG rather than the original JPEG bytes.
- PASS: live app checks for cross-year duplicate reuse, actual Bases caption editing and image/journal links, note-switch insertion, Describe later, the edit-description command, caption-open reload/recovery, and final audits. These used the loaded plugin and real app controls through programmatic DOM/API actions; paste/drop handler inputs were synthetic events.
- PASS: both final audit notices and independent file checks report zero pending descriptions, zero missing files and zero interrupted captures.
- NOT RUN: the complete native mouse/keyboard protocol. Native Finder drag/drop, repeated duplicate file-picker selection, and the remaining native control paths are unverified. Computer control returned stale screens, `noWindowsAvailable` and timeouts; these are not plugin failures or passes.

See [the dated report](docs/smoke-tests/2026-10-22.md) for methods, hashes, receipts and remaining native gaps. This is mixed native/host validation, not a full native protocol pass. The one-off host runners are not included as a supported automated test framework. The computer-use protocol above remains the supported native verification path.

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
