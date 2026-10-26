# Image Ledger for Obsidian

Save JPEG and PNG images in your notes, describe them, and find them again in an image library. Image Ledger keeps local copies with the metadata it receives. Any Markdown note works; no journal setup is needed.

Requires desktop Obsidian 1.10 or later. This is a development build; earlier experimental formats are not migrated.

## Install

1. [Build the plugin from source](CONTRIBUTING.md#development-setup).
2. Copy `main.js`, `manifest.json`, and `styles.css` into your vault's `.obsidian/plugins/image-ledger/` folder. Create that folder if needed.
3. Reload Obsidian and enable **Image Ledger** in **Settings → Community plugins**.
4. Disable any other plugin that handles image pastes, so only one plugin handles each image.

To update, replace those three files with a new build and reload the plugin.

## Add your first image

1. Open a note. Paste or drop a JPEG/PNG, or run **Image Ledger: Import JPEG or PNG** from the command palette.
2. Write a short description, such as “Whiteboard sketch from the planning meeting,” and select **Save description**.
3. Your note gets the image and an **Image details** link. Run **Image Ledger: Open image library** to browse descriptions, dates, and links back to your notes in Bases.

Choose **Describe later** to keep the image without finishing its description. Run **Image Ledger: Edit image description** later, or edit `description` in the library. This updates generated image descriptions in your notes; custom alt text stays as you wrote it.

## Where your images go

By default, each image gets a unique filename in `images/`, a metadata note in `image-records/`, and an `.xmp` sidecar beside the image. The library is `image-library.base`.

In **Settings → Image Ledger**, **Image storage** can group new files by import year or by the year in a note's name or folder. Existing images stay in place. You can also turn off paste/drop handling or the **Image details** link.

Pasting identical bytes again reuses the saved image, even from another note. Removing an embed or deleting a note does not delete its image. Keep generated image filenames and record snapshot blocks intact; edit descriptions through the library or plugin command.

## Privacy and limits

Image Ledger makes no network requests and provides no upload, AI descriptions, or independent backup. Your vault's sync service may still copy its files; configure exclusions in that service if needed. The source installer adds Git exclusions, which do not control other sync services.

Received image bytes stay unchanged. Clipboard images may already have lost original metadata; use **Import JPEG or PNG** with the original file when that matters. HEIC and Live Photo videos are not supported. Source files are never deleted.

## If something goes wrong

- **A description is unfinished:** run **Edit image description**.
- **An import was interrupted:** run **Recover interrupted image captures**. The plugin retains staged files until capture finishes.
- **An image seems missing:** run **Check image records** for counts of missing files, pending descriptions, and interrupted captures.

For development and testing, see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE). Bundled EXIF parsing uses the MIT-licensed [exifr](https://github.com/MikeKovarik/exifr) library.
