import exifr from 'exifr';

/** Read fixture metadata independently of the ExifTool writer. */
export function readExif(bytes: Uint8Array): Promise<Record<string, unknown> | undefined> {
  return exifr.parse(bytes, {
    translateValues: false,
    reviveValues: false,
    xmp: false,
    iptc: false,
    icc: false,
    ihdr: true,
  });
}
