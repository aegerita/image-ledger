# Image Ledger for Obsidian

Save JPEG and PNG images in your notes, describe them, and find them again in an image library. Image Ledger keeps local copies with the metadata it receives. Any Markdown note works; no journal setup is needed.

Requires desktop Obsidian 1.10 or later. Tested on macOS. This is an early development build; earlier experimental formats are not migrated.

## Install

There is no downloadable release yet. Installation currently requires building from source. If you do not build plugins, wait for a release with ready-to-copy files. Try development builds in a separate vault first.

1. [Build the plugin from source](CONTRIBUTING.md#development-setup).
2. Copy `main.js`, `manifest.json`, and `styles.css` into your vault's `.obsidian/plugins/image-ledger/` folder. Create that folder if needed.
3. Reload Obsidian and enable **Image Ledger** in **Settings → Community plugins**.
4. Disable any other plugin that handles image pastes, so only one plugin handles each image.

`.obsidian` is the hidden settings folder inside your vault. Enable **Bases** under **Settings → Core plugins** to browse the image library.

To update, replace those three files with a new build and reload the plugin.

## Add your first image

1. Open a note. Paste or drop a JPEG/PNG, or run **Image Ledger: Import JPEG or PNG** from the command palette.
2. Write a short description, such as “Whiteboard sketch from the planning meeting,” and select **Save description**.
3. Your note gets the image and an **Image details** link. Run **Image Ledger: Open image library** to browse descriptions, dates, and links back to your notes in Bases.

Choose **Describe later** to keep the image without finishing its description. Run **Image Ledger: Edit image description** later, or edit `description` in the library. This updates generated image descriptions in your notes; custom alt text stays as you wrote it.

In an editor, place the cursor inside a managed image's Markdown embed and run **Edit image description** to edit it directly. Elsewhere in the note, the command lists that note's images; if there are none, it lists all images. An open image or image record still opens its description directly. The picker shows thumbnails, source notes and IDs, newest imports first. Search by description, ID or note; the count shows when only the first 100 matches are displayed.

Interrupted description saves resume when the plugin starts again. If a source note changed independently, Image Ledger preserves your edits and reports an unresolved save instead of guessing which text to replace.

## Where your images go

New images get a 12-character lowercase hexadecimal ID, such as `7f3a9c2d8e10`. By default, the image goes in `images/`, its metadata note in `image-records/`, and its matching `.xmp` metadata file beside the image. Existing UUID filenames and links stay unchanged. Open `image-library.base` to browse the library in Obsidian.

In **Settings → Image Ledger**, **Image storage** can group new files by import year or by the year in a note's name or folder. Existing images stay in place. You can also turn off paste/drop handling or the **Image details** link.

Adding the exact same image file again reuses the saved copy, even from another note. Removing an image from a note or deleting a note does not delete its saved file. Avoid renaming generated files or editing the generated record text; change descriptions through the library or plugin command.

## Privacy and limits

Image Ledger makes no network requests and provides no upload, AI descriptions, or independent backup. Your vault's sync service may still copy its files; configure exclusions in that service if needed.

Received image bytes stay unchanged. Clipboard images may already have lost original metadata; use **Import JPEG or PNG** with the original file when that matters. HEIC and Live Photo videos are not supported. Source files are never deleted.

## If something goes wrong

- **A description is unfinished:** run **Edit image description**.
- **An import was interrupted:** run **Recover interrupted image captures**. The plugin retains staged files until capture finishes.
- **An image seems missing:** run **Check image records** for counts of missing files, pending descriptions, and interrupted captures.

For development and testing, see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE). Bundled EXIF parsing uses the MIT-licensed [exifr](https://github.com/MikeKovarik/exifr) library.
