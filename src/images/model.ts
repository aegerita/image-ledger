export type ImageFormat = 'jpg' | 'png';
export type CaptureTimeStatus = 'source_offset' | 'timezone_unknown' | 'missing_from_received_file';

export interface ImageMetadata {
  capturedAt: string | null;
  captureTimeRaw: string | null;
  captureTimeOffset: string | null;
  captureTimeStatus: CaptureTimeStatus;
  width: number | null;
  height: number | null;
  orientation: number | null;
  cameraMake: string | null;
  cameraModel: string | null;
  raw: Record<string, unknown>;
  warning?: string;
}

export interface ImageRecord {
  schemaVersion: 2;
  id: string;
  description: string;
  captionStatus: 'confirmed' | 'pending';
  imagePath: string;
  recordPath: string;
  sidecarPath: string;
  sourceName: string | null;
  sourceLastModified: number | null;
  ingestMethod: 'clipboard' | 'drop' | 'file';
  importedAt: string;
  sourceNotes: string[];
  sha256: string;
  bytes: number;
  format: ImageFormat;
  metadata: ImageMetadata;
}

export interface MediaInput {
  bytes: Uint8Array;
  name?: string;
  lastModified?: number;
  method: ImageRecord['ingestMethod'];
}
