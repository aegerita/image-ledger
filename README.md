# Image Ledger for Obsidian

Paste, drop, or import JPEG and PNG images into notes. Image Ledger embeds the description in the image and names the file by a hash that stays stable through description edits. Export by copying the image files.

Requires desktop Obsidian 1.10 or later and [ExifTool](https://exiftool.org/install.html). Tested on macOS. The vault filesystem must support hard links and atomic renames.

## Install

1. Install ExifTool and run `exiftool -ver` to check that it works.
2. From [GitHub Releases](https://github.com/aegerita/image-ledger/releases), copy `main.js`, `manifest.json`, and `styles.css` to `.obsidian/plugins/image-ledger/` in your vault. For a source build, see [development setup](CONTRIBUTING.md#development-setup).
3. Enable **Image Ledger** in **Settings → Community plugins**. The default `exiftool` searches Obsidian’s `PATH` and standard Homebrew locations on macOS. If you installed a separate copy, set its absolute path under **Image Ledger → ExifTool executable** and reload the plugin.
4. Disable other plugins that handle image paste or drop to avoid conflicts.

Update the three plugin files together. Existing vaults from the earlier record-based format need a separate migration. Their image embeds still work, but their short IDs and UUIDs are outside the new picker and deduplication catalog. Finish any old interrupted operations with the previous build and keep the old records and sidecars until their descriptions have been migrated.

## Add and describe images

1. Open a note. Paste or drop a JPEG/PNG, or run **Image Ledger: Import JPEG or PNG**.
2. Enter a description and choose **Save description**, or choose **Describe later** to keep the image with its current metadata.
3. Run **Open image library** to browse images or find them by description, ID, or path. Turn on **Pending descriptions only** and choose **Edit description** next to an image to finish it later.

**Known issue:** macOS can block Obsidian from reading photos copied from an iPhone through Universal Clipboard. Copy the photo again and paste promptly, or AirDrop a JPEG or PNG and import it.

**Edit image description** opens the dialog for a managed image under the cursor or an open image file. Elsewhere it opens a picker, scoped to the note's images when available. It is also available in the managed image file menu and on inline embeds in Source or Live Preview. Saving updates the default `XMP-dc:Description` in the same image file and updates matching inline embed alt text. Image Ledger leaves custom labels and reference-style embeds alone and reports skips or conflicts.

Description saves preserve the file’s modification date and, on macOS, its Finder creation date. Image Ledger keeps the original file if the replacement cannot preserve those dates.

## Storage and export

Images go in `images/`, or in `<year>/images/` if you choose a year-based layout. New filenames use 64 lowercase hexadecimal characters from a SHA-256 hash. Imports with matching image data and metadata reuse the existing image and its description. Description edits keep the filename and note links. Images with earlier 64-character filenames keep their paths and work with edits, reimports, and recovery.

Image Ledger caches captions in `.image-ledger/catalog-cache.json` for faster startup and browsing. The cache uses machine-specific file metadata, so exclude it from Git and vault sync. You can remove the cache while the plugin is closed to rebuild it on startup. Captions live in the image files.

Copy the image files or the entire image folder to export them. The images contain their descriptions and received photo metadata. Use a file checksum to verify a transfer. The image ID stays stable through description edits and ExifTool upgrades. Recompression or other metadata edits can produce a different ID.

The plugin verifies the encoded image and other metadata before saving a description. It stops the save if verification fails. Clipboard conversion can remove GPS or capture dates before Obsidian receives the file. Import the original JPEG or PNG when that metadata matters. A file copy carries embedded photo dates. Filesystem timestamps depend on how you copy it.

## Delete and recover

**Delete image everywhere...** previews the image and affected notes. It removes supported Markdown embeds and sends the file to Obsidian's recoverable Trash. Set **Deleted files** to system Trash or the vault `.trash` folder. Resolve blockers such as wiki embeds, ordinary links, or unsaved conflicting edits before confirming. Removing an embed by hand leaves the image file in place.

**Recover interrupted image captures** resumes from the original source note. If a saved capture's earlier hash-named image is missing, restore it to its original path before recovering. **Check managed images** reads and checksums the image files and lists pending descriptions, unreadable images and unfinished operations. An interrupted deletion resumes when the plugin reloads. If a note or file changed, the receipt stays available for inspection.

Image Ledger runs locally. Exported files can include GPS or other metadata already present in the image. Any vault sync or backup policy is managed by your own service.

[Developer setup](CONTRIBUTING.md) · [Verification](TESTING.md) · [MIT license](LICENSE)
