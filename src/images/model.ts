export type ImageFormat = 'jpg' | 'png';

/** Image information. The checksum is present only after reading or writing the image bytes. */
export interface ManagedImage {
  id: string;
  imagePath: string;
  description: string;
  checksum?: string;
}

export interface MediaInput {
  bytes: Uint8Array;
  lastModified?: number;
}
