export type ImageFormat = 'jpg' | 'png';

/** A catalog entry rebuilt from the image, never persisted as a separate record. */
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
