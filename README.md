# Image Ledger for Obsidian

Paste, drop, or import JPEG and PNG images into notes. Image Ledger embeds the description in the image and names the file by a hash that stays stable through description edits. Export by copying the image files.

Requires desktop Obsidian 1.10 or later and [ExifTool](https://exiftool.org/install.html) 13.58 or 13.63. Tested on macOS. The vault filesystem must support hard links and atomic renames.

## Install

1. Install or extract a supported ExifTool version in a permanent location. Run its `exiftool -ver` command to check the version. If you extract the source archive, keep its `lib` folder alongside the executable.
2. From [GitHub Releases](https://github.com/aegerita/image-ledger/releases), copy `main.js`, `manifest.json`, and `styles.css` to `.obsidian/plugins/image-ledger/` in your vault. For a source build, see [development setup](CONTRIBUTING.md#development-setup).
3. Enable **Image Ledger** in **Settings → Community plugins**. In **Image Ledger → ExifTool executable**, enter the absolute path to ExifTool and reload the plugin. The default `exiftool` works when Obsidian can find that command on its `PATH`.
4. Disable other plugins that handle image paste or drop to avoid conflicts.

Update the three plugin files together. Existing vaults from the earlier record-based format need a separate migration. Their image embeds still work, but their short IDs and UUIDs are outside the new picker and deduplication catalog. Finish any old interrupted operations with the previous build and keep the old records and sidecars until their descriptions have been migrated.

## Add and describe images

1. Open a note. Paste or drop a JPEG/PNG, or run **Image Ledger: Import JPEG or PNG**.
2. Enter a description and choose **Save description**, or choose **Describe later** to keep the image with its current metadata.
3. Run **Open image library** to browse and open images. Search by embedded description, ID, or path.

**Known issue:** macOS can block Obsidian from reading photos copied from an iPhone through Universal Clipboard. Copy the photo again and paste promptly, or AirDrop a JPEG or PNG and import it.

**Edit image description** opens the dialog for a managed image under the cursor or an open image file. Elsewhere it opens a picker, scoped to the note's images when available. It is also available in the managed image file menu and on inline embeds in Source or Live Preview. The description is stored as the default `XMP-dc:Description` value. The Markdown embed keeps the alt text it received at insertion.

## Storage and export

Images go in `images/`, or in `<year>/images/` if you choose a year-based layout. Their names use a 64-character normalized SHA-256 hash. Imports with matching identity reuse the existing image. An existing description wins when you reimport another copy. Description changes keep the filename and all note links.

Copy the image files or the entire image folder to export them. The images contain their descriptions and received photo metadata. The filename is a deduplication ID, so use a separate file checksum to verify a transfer. The hash stays stable through description edits and across the supported ExifTool versions. Recompression or other metadata edits can produce a different ID.

The plugin changes the saved copy's bytes when embedding a description and verifies that the encoded image, EXIF and color profile survive. Source files remain intact. Clipboard conversion can remove GPS or capture dates before Obsidian receives the file. Import the original JPEG or PNG when that metadata matters. A file copy carries embedded photo dates. Filesystem timestamps depend on how you copy it.

## Delete and recover

**Delete image everywhere...** previews the image and affected notes. It removes supported Markdown embeds and sends the file to Obsidian's recoverable Trash. Set **Deleted files** to system Trash or the vault `.trash` folder. Resolve blockers such as wiki embeds, ordinary links, or unsaved conflicting edits before confirming. Removing an embed by hand leaves the image file in place.

**Recover interrupted image captures** resumes from the original source note. **Check managed images** lists pending descriptions, unreadable images and unfinished operations. An interrupted deletion resumes when the plugin reloads. If a note or file changed, the receipt stays available for inspection.

Image Ledger runs locally. Exported files can include GPS or other metadata already present in the image. Any vault sync or backup policy is managed by your own service.

[Developer setup](CONTRIBUTING.md) · [Verification](TESTING.md) · [MIT license](LICENSE)
