# Image Ledger for Obsidian

Capture JPEG/PNG images in any note, give each a one-line description, and preserve the received bytes and metadata locally with stable UUID filenames. Browse linked descriptions and dates in Obsidian Bases. No journal layout or dated note names are required.

## Daily use

1. Paste an image, drag it into a note, or run **Image Ledger: Import JPEG or PNG**.
2. Enter one short description. Press Enter or **Save description**.
3. The note gets a local Markdown image and an **Image details** link. The image record also links back to the source note.
4. Run **Image Ledger: Open image library** to browse or edit descriptions in Bases.

**Describe later** keeps the image and marks its description pending. It never discards a pasted image. Use **Edit image description** or edit the `description` property in Bases to finish it. The plugin updates matching generated alt text and the XMP sidecar; deliberately customized alt labels are left alone.

## Files

```text
images/<uuid>.jpg                   # or .png, received bytes unchanged
images/<uuid>.xmp                   # portable UUID and description
image-records/<uuid>.md             # searchable metadata and note references
image-library.base                 # view over managed image records
.image-ledger/staging/              # temporary crash-recovery files
```

New installs use the flat layout above. **Image storage** offers three policies:

- **Single folder**: `images/` and `image-records/`, independent of note names and dates.
- **Import year**: group both folders under the local year when the image was imported.
- **Note year**: use a `YYYY-MM-DD` note name or leading year folder, falling back to the import year.

Storage policy chooses a destination only. It does not assign a date to the image. Each capture keeps its chosen destination through setting changes, note moves, and recovery; existing images stay at their paths.

Pasting identical bytes again reuses the existing UUID and local image, including across storage modes. The SHA-256 hash is recorded for later backup/import integration. Similar-looking but differently encoded images remain separate in this release.

File bytes are not re-encoded or edited, preserving all metadata that reached the clipboard. Images have an import timestamp and source capture metadata, independent of the notes that reference them. EXIF capture time and source UTC offset are recorded when present; a missing timezone remains unknown. A clipboard image may already lack the phone original's metadata; the plugin cannot recover missing data from its pixels. For full source metadata use the file-import command with the original JPEG/PNG.

This release accepts JPEG and PNG. For HEIC, choose its JPEG/PNG companion. It does not import Live Photo videos, convert HEIC, or delete source files.

Each image owns one record, regardless of how many notes use it. Schema 2 records use `type: image-ledger-image`, `source_notes` for note references, and `imported_at` / `captured_at` for dates. There is no single note date on an image. Removing a note does not remove its image.

Records carry flat properties for Bases plus a portable JSON snapshot for recovery. Keep the snapshot block intact; edit description/caption status through properties, Bases or the plugin command. If you move a note, Obsidian's normal link updates and the plugin reconcile the references. Keep UUID filenames; use the plugin rather than manually renaming individual images.

This project is under development. Only the current Image Ledger format is supported; earlier development formats are not migrated.

## Install from source

Requires desktop Obsidian 1.10 or later and Node.js 22 or later for development.

```sh
npm ci
npm test
npm run build
npm run install:vault -- --vault /absolute/path/to/your/vault --enable
```

The installer copies `main.js`, `manifest.json`, and `styles.css` into `.obsidian/plugins/image-ledger/`. It adds `images/` and `.image-ledger/` to the vault's Git ignore rules. `--enable` enables Image Ledger in the saved plugin configuration and disables the competing Imgur paste handler; its prior plugin list is saved under `.image-ledger/`. Existing Image Ledger settings are preserved. Reload Obsidian or toggle the plugin on in Community plugins to apply the configuration to an already open window.

For updates, rebuild and run the installer again, then reload the plugin. `npm run dev` rebuilds source changes; it does not copy them automatically into a vault.

## Commands

- **Import JPEG or PNG** — choose files without losing their received metadata.
- **Open image library** — open the generated Base.
- **Edit image description** — search by description or UUID, or edit the active record/image.
- **Recover interrupted image captures** — finalize retained captures after an interruption.
- **Check image records** — show pending captions, missing files and interrupted captures.

Paste positions follow edits in the original editor while a caption is being entered. If that editor closes, the plugin appends to the original note. It never redirects the image into whichever note happens to be active. Image records remain recoverable if the original note is deleted. Removing an embed does not delete the underlying image automatically.

## Storage boundaries

All processing stays on your Mac; this version has no network requests, image upload, backup jobs, AI caption service or credentials. Your existing Imgur images are untouched.

Git exclusions do not configure Obsidian Sync, iCloud, Dropbox or other sync services. Configure image folder exclusions separately before using real photos if you want them kept out of those services. This phase deliberately does not provide an independent image backup; those copies come in the next phase.

## Verification

Run unit/filesystem checks and the default live smoke test:

```sh
npm test
npm run test:obsidian
```

The smoke test uses the loaded Obsidian app through CLI/API calls and real DOM handlers in a fresh generated vault. It has a 90-second deadline and keeps JSON receipts. Computer-use tools and native GUI automation are prohibited, including as a fallback when the API fails. Report failures or unverified OS boundaries instead. Never use the personal journal for testing. See [AGENTS.md](AGENTS.md) and [TESTING.md](TESTING.md) for the current instructions.

## License

MIT. Bundled EXIF parsing uses the MIT-licensed [exifr](https://github.com/MikeKovarik/exifr) library. Obsidian APIs are provided by the host application.
