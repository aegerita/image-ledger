# Verification

## Automated checks

Run `npm test` and `npm run build`. Tests use generated/fixed images and temporary filesystem vaults. They verify received-byte identity, EXIF offsets and missing metadata, UUID reuse, safe caption encoding, sidecar/record consistency, write failures and capture recovery.

## Live Obsidian smoke test

Use a dedicated test note in the current journal rather than changing an existing diary entry.

1. Enable Journal Media and disable the competing Imgur paste handler.
2. Paste a synthetic JPEG/PNG with a known SHA-256 into the test note.
3. Enter a description; confirm the preview, Markdown, UUID image, XMP and record.
4. Paste the same bytes again. Confirm the same UUID and no second image payload.
5. Open `journal-images.base`; confirm the record, description, date fields and working image/journal links.
6. Edit a description in Bases; confirm the record snapshot, sidecar and managed alt text agree.
7. Switch notes while a caption is open; confirm insertion remains in the original note.
8. Restart/reload with a staged capture; confirm recovery makes the record and image available without overwriting an existing file.

Actual phone clipboard metadata depends on the sending application and transfer method. The synthetic-image test proves plugin preservation, not that every phone transfer supplies original metadata.

## Recorded live results

Verified on 2026-10-17 in the user's Journal vault, Obsidian 1.14.4 on macOS:

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
