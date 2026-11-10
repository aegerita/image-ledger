# Image Ledger for Obsidian

Save JPEG and PNG images in your notes, describe them, and find them again in an image library. Image Ledger keeps local copies with the metadata it receives. Any Markdown note works; no journal setup is needed.

Requires desktop Obsidian 1.10 or later. Tested on macOS. This is an early development build; earlier experimental formats are not migrated.

## Install

Install manually from [GitHub Releases](https://github.com/aegerita/image-ledger/releases).

1. Download `main.js`, `manifest.json`, and `styles.css` from the release assets.
2. Copy `main.js`, `manifest.json`, and `styles.css` into your vault's `.obsidian/plugins/image-ledger/` folder. Create that folder if needed.
3. Reload Obsidian and enable **Image Ledger** in **Settings → Community plugins**.
4. Disable any other plugin that handles image pastes, so only one plugin handles each image.

`.obsidian` is the hidden settings folder inside your vault. Enable **Bases** under **Settings → Core plugins** to browse the image library.

To update, replace those three files with the files from a newer release and reload the plugin. To build from source, see [development setup](CONTRIBUTING.md#development-setup); use a generated test vault for development builds.

## Add your first image

1. Open a note. Paste or drop a JPEG/PNG, or run **Image Ledger: Import JPEG or PNG** from the command palette.
2. Write a short description, such as “Whiteboard sketch from the planning meeting,” and select **Save description**.
3. Your note gets the image and an **Image details** link. Run **Image Ledger: Open image library** to browse descriptions, dates, and links back to your notes in Bases.

Choose **Describe later** to keep the image without finishing its description. Run **Image Ledger: Edit image description** later, or edit `description` in the library. This updates generated image descriptions in your notes; custom alt text stays as you wrote it.

In an editor, place the cursor inside a managed image's Markdown embed and run **Edit image description** to edit it directly. Elsewhere in the note, the command lists that note's images; if there are none, it lists all images. An open image or image record still opens its description directly. The picker shows thumbnails, source notes and IDs, newest imports first. Search by description, ID or note; the count shows when only the first 100 matches are displayed.

**Image Ledger: Edit image description** is also added to file menus for managed images and their record notes. Source and Live Preview editor menus include it when the editor selection is inside a managed Markdown image embed. Ordinary text and unmanaged images get no added item. Reading View has no editor-menu integration; use the command or the image/record file menu. Native right-click delivery and targeting on rendered images remain unverified; current checks invoke the menu handlers through Obsidian's API. Wiki and reference-style embeds are not supported by cursor lookup.

Description saves report updated embeds and skipped references, including customized alt text, wiki embeds without alt text, and missing notes. Choose **Review skipped embeds** in the notice to inspect them and explicitly overwrite an individual single-line inline Markdown embed. Multiline and reference-style embeds are reported but cannot be overwritten. Notes with paths that cannot be stored in image records (for example, names containing brackets) are reported and left unchanged. Copied references found through Obsidian's link index are added to the record; indexing may take a moment after a note changes. **Always keep alt text in sync with the description** in settings overwrites custom alt text on generated-form embeds during future saves; it is off by default.

Interrupted description saves resume when the plugin starts again. If a source note changed independently, Image Ledger preserves your edits and reports an unresolved save instead of guessing which text to replace. That image remains blocked until its save can recover; unrelated images can still be imported and edited. Run **Check image records** to find unfinished saves.

## Delete an image

Right-click a managed image's Markdown embed in Source or Live Preview, or its image/record file, and choose **Image Ledger: Delete image everywhere...**. The editor menu uses the selection inside the embed. The same command is available from the command palette, with the same image picker as description editing.

The confirmation shows the image, each affected note and embed count, managed image/XMP/record files, and any staged copies to cancel. **Cancel** has initial focus. Confirming removes Markdown embeds (including custom alt text, multiline and reference-style embeds) and exact generated **Image details** links, preserving surrounding note text. Files go through Obsidian's **Deleted files** setting; choose system Trash or the vault `.trash` folder. Permanent deletion and managed paths pointing outside the vault are refused. Removing one embed manually still keeps the saved image.

Deletion scans Markdown notes, including open editors and copied embeds. Wiki embeds, ordinary links to the image/record, property links, and indexed references outside Markdown block deletion; resolve the listed references first. HTML embeds and unindexed references in other file formats are outside this check. Save or reload affected notes with unsaved or conflicting edits before deleting. If notes, records or managed files change while the preview is open, reopen it before deleting.

Interrupted deletions resume on startup. Conflicting note edits retain the recovery receipt and remaining files; **Check image records** reports the unfinished operation. Deleted IDs stay reserved. Restoring deleted files from Trash does not restore their note embeds or reactivate their catalog entry; the audit flags restored files as orphans. A deliberate new import gets a new ID.

Deletion affects this vault only. Original source files, Git history, backup snapshots, remote copies and independently owned photo libraries are excluded. Native right-click delivery remains unverified; menu handlers and confirmation controls are tested through Obsidian's API.

## Where your images go

New images get a 12-character lowercase hexadecimal ID, such as `7f3a9c2d8e10`. By default, the image goes in `images/`, its metadata note in `image-records/`, and its matching `.xmp` metadata file beside the image. Existing UUID filenames and links stay unchanged. Open `image-library.base` to browse the library in Obsidian.

In **Settings → Image Ledger**, **Image storage** can group new files by import year or by the year in a note's name or folder. Existing images stay in place. You can also turn off paste/drop handling or the **Image details** link.

Adding the exact same image file again reuses the saved copy, even from another note. Removing an image from a note or deleting a note does not delete its saved file. Avoid renaming generated files or editing the generated record text; change descriptions through the library or plugin command.

## Privacy and limits

Image Ledger makes no network requests and provides no upload, AI descriptions, or independent backup. Your vault's sync service may still copy its files; configure exclusions in that service if needed.

Record notes keep capture and camera fields, decimal GPS latitude/longitude and altitude in metres when available, plus a compact `image-ledger` data block for index rebuilding and recovery. Face regions and other raw metadata are excluded. Older records remain readable; saving them keeps these GPS fields and drops the raw metadata block.

Received image bytes stay unchanged, including any embedded GPS or other metadata. Clipboard images may already have lost original metadata; use **Import JPEG or PNG** with the original file when that matters. HEIC and Live Photo videos are not supported. Source files are never deleted.

## If something goes wrong

- **A description is unfinished:** run **Edit image description**.
- **An import was interrupted:** run **Recover interrupted image captures**. The plugin retains staged files until capture finishes.
- **An image seems missing:** run **Check image records** for a report listing missing image paths, pending descriptions, interrupted captures, unreadable capture receipts, and unfinished image operations. The report stays open until dismissed. It does not change files or attempt recovery, and remains available when recovery is blocked.

For development and testing, see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE). Bundled EXIF parsing uses [exifr](https://github.com/MikeKovarik/exifr); Markdown lookup uses [Lezer](https://code.haverbeke.berlin/lezer/markdown). Both are MIT-licensed.
