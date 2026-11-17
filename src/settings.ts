export type StorageLayout = 'flat' | 'import-year' | 'note-year';

export interface Settings {
  interceptPaste: boolean;
  interceptDrop: boolean;
  storageLayout: StorageLayout;
  exiftoolPath: string;
}

export const DEFAULTS: Settings = {
  interceptPaste: true,
  interceptDrop: true,
  storageLayout: 'flat',
  exiftoolPath: 'exiftool',
};

export function isStorageLayout(value: unknown): value is StorageLayout {
  return value === 'flat' || value === 'import-year' || value === 'note-year';
}

export function settingsFromData(data: unknown): Settings {
  const saved = typeof data === 'object' && data !== null && !Array.isArray(data) ? data as Partial<Settings> : undefined;
  return {
    interceptPaste: typeof saved?.interceptPaste === 'boolean' ? saved.interceptPaste : DEFAULTS.interceptPaste,
    interceptDrop: typeof saved?.interceptDrop === 'boolean' ? saved.interceptDrop : DEFAULTS.interceptDrop,
    storageLayout: isStorageLayout(saved?.storageLayout) ? saved.storageLayout : DEFAULTS.storageLayout,
    exiftoolPath: typeof saved?.exiftoolPath === 'string' && saved.exiftoolPath.trim()
      ? saved.exiftoolPath.trim() : DEFAULTS.exiftoolPath,
  };
}
