# Journal Media for Obsidian

Paste JPEG/PNG images into your journal, give each a one-line description, and keep the original bytes locally with stable UUID filenames. Browse the linked descriptions and dates in Obsidian Bases.

## Daily use

1. Paste an image, drag it into a note, or run **Journal Media: Import JPEG or PNG**.
2. Enter one short description. Press Enter or **Save description**.
3. The note gets a local Markdown image and an **Image details** link. The image record also links back to the journal entry.
4. Run **Journal Media: Open image library** to browse or edit descriptions in Bases.

**Describe later** keeps the image and marks its description pending. It never discards a pasted image. Use **Edit image description** or edit the `description` property in Bases to finish it. The plugin updates matching generated alt text and the XMP sidecar; deliberately customized alt labels are left alone.

## Files

```text
2026/
  images/<uuid>.jpg                 # or .png, received bytes unchanged
  images/<uuid>.xmp                 # portable UUID and description
  image-records/<uuid>.md           # searchable metadata and journal links
journal-images.base                # view over all years' image records
.journal-media/staging/             # temporary crash-recovery files
```

The first journal note determines the year. A daily note named `2025-12-24.md` uses `2025/images/`, even when you add the photo later. Pasting identical bytes again reuses the existing UUID and local image. The SHA-256 hash is recorded for later backup/import integration. Similar-looking but differently encoded images remain separate in this release.

File bytes are not re-encoded or edited, preserving all metadata that reached the clipboard. EXIF capture time and source UTC offset are recorded when present; a missing timezone remains unknown. Import time and journal date are separate fields. A clipboard image may already lack the phone original's metadata; the plugin cannot recover missing data from its pixels. For full source metadata use the file-import command with the original JPEG/PNG.

This release accepts JPEG and PNG. For HEIC, choose its JPEG/PNG companion. It does not import Live Photo videos, convert HEIC, or delete source files.

Records carry flat properties for Bases plus a portable JSON snapshot for recovery. Keep the snapshot block intact; edit description/caption status through properties, Bases or the plugin command. If you move a journal note, Obsidian's normal link updates and the plugin reconcile the backlinks. Keep UUID filenames; use the plugin rather than manually renaming individual images.

## Install from source

Requires desktop Obsidian 1.10 or later and Node.js 22 or later for development.

```sh
npm ci
npm test
npm run build
npm run install:vault -- --vault /absolute/path/to/your/vault --enable
```

The installer copies only `main.js`, `manifest.json`, and `styles.css` into `.obsidian/plugins/journal-media/`. It adds `images/` and `.journal-media/` to the vault's Git ignore rules. `--enable` enables Journal Media in the saved plugin configuration and disables the competing Imgur paste handler; its prior plugin list is saved under `.journal-media/`. Reload Obsidian or toggle the plugin on in Community plugins to apply the configuration to an already open window.

For updates, rebuild and run the installer again, then reload the plugin. `npm run dev` rebuilds source changes; it does not copy them automatically into a vault.

## Commands

- **Import JPEG or PNG** — choose files without losing their received metadata.
- **Open image library** — open the generated Base.
- **Edit image description** — search by description or UUID, or edit the active record/image.
- **Recover interrupted image captures** — finalize retained captures after an interruption.
- **Check image records** — show pending captions, missing files and interrupted captures.

Paste positions follow edits in the original editor while a caption is being entered. If that editor closes, the plugin appends to the original note. It never redirects the image into whichever note happens to be active. Image records remain recoverable if the original note is deleted. Removing a journal embed does not delete the underlying image automatically.

## Storage boundaries

All processing stays on your Mac; this version has no network requests, image upload, backup jobs, AI caption service or credentials. Your existing Imgur images are untouched.

Git exclusions do not configure Obsidian Sync, iCloud, Dropbox or other sync services. Configure year image folder exclusions separately before using real photos if you want them kept out of those services. This phase deliberately does not provide an independent image backup; those copies come in the next phase.

## Verification

`npm test` covers JPEG/PNG validation, byte hashes and metadata, caption escaping, Markdown/XMP records, Bases edits, duplicate reuse, insertion anchors, staging recovery and failed writes. See `TESTING.md` for the live Obsidian smoke-test procedure and recorded results.

## License

MIT. Bundled EXIF parsing uses the MIT-licensed [exifr](https://github.com/MikeKovarik/exifr) library. Obsidian APIs are provided by the host application.
