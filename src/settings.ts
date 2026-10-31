export type StorageLayout = 'flat' | 'import-year' | 'note-year';

export interface Settings {
  interceptPaste: boolean;
  interceptDrop: boolean;
  showRecordLink: boolean;
  syncCustomAlt: boolean;
  storageLayout: StorageLayout;
}

export const DEFAULTS: Settings = {interceptPaste: true, interceptDrop: true, showRecordLink: true, syncCustomAlt: false, storageLayout: 'flat'};

export function isStorageLayout(value: unknown): value is StorageLayout {
  return value === 'flat' || value === 'import-year' || value === 'note-year';
}

export function settingsFromData(data: unknown): Settings {
  const saved = typeof data === 'object' && data !== null && !Array.isArray(data) ? data as Partial<Settings> : undefined;
  return {
    interceptPaste: typeof saved?.interceptPaste === 'boolean' ? saved.interceptPaste : DEFAULTS.interceptPaste,
    interceptDrop: typeof saved?.interceptDrop === 'boolean' ? saved.interceptDrop : DEFAULTS.interceptDrop,
    showRecordLink: typeof saved?.showRecordLink === 'boolean' ? saved.showRecordLink : DEFAULTS.showRecordLink,
    syncCustomAlt: typeof saved?.syncCustomAlt === 'boolean' ? saved.syncCustomAlt : DEFAULTS.syncCustomAlt,
    storageLayout: isStorageLayout(saved?.storageLayout) ? saved.storageLayout : DEFAULTS.storageLayout,
  };
}
