import { posix } from 'node:path';
import type { ImageMetadata, ImageRecord } from './model';
import { isImageId, isLegacyImageId } from './ids';

const RECORD_START = '<!-- image-ledger:record -->';
const RECORD_END = '<!-- /image-ledger:record -->';
const SHA256 = /^[0-9a-f]{64}$/i;
const RECORD_FIELDS = new Set([
  'schemaVersion', 'id', 'description', 'captionStatus',
  'imagePath', 'recordPath', 'sidecarPath',
  'sourceName', 'sourceLastModified', 'ingestMethod', 'importedAt', 'sourceNotes',
  'sha256', 'bytes', 'format', 'metadata',
]);

/** Keep captions useful both as one-line Markdown alt text and Bases properties. */
export function normalizeDescription(text: string): string {
  if (typeof text !== 'string') throw new TypeError('An image description is required.');
  const description = text.replace(/\s+/gu, ' ').trim();
  if (!description) throw new Error('An image description is required.');
  return description;
}

/** Generate a normal Markdown embed that works without this plugin installed. */
export function markdownEmbed(record: ImageRecord, sourcePath: string): string {
  assertVaultPath(sourcePath);
  assertVaultPath(record.imagePath);
  const relative = posix.relative(posix.dirname(sourcePath), record.imagePath);
  // Escape each URL segment, retaining the relative ../ path components.
  const target = relative.split('/').map(segment => encodeURIComponent(segment)
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')).join('/');
  const alt = normalizeDescription(record.description)
    .replace(/\\/g, '\\\\')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]');
  return `![${alt}](${target})`;
}

/**
 * The frontmatter makes the record editable in Bases. The structured body keeps
 * the original metadata and all recovery information portable and lossless.
 */
export function serializeRecord(record: ImageRecord): string {
  if (!isImageRecord(record)) throw new Error('Cannot serialize an invalid image record.');
  const description = normalizeDescription(record.description);
  const portable = { ...record, description };
  const scalar = (key: string, value: string | number | null) => `${key}: ${JSON.stringify(value)}`;
  const lines = [
    '---',
    scalar('type', 'image-ledger-image'),
    scalar('schema_version', record.schemaVersion),
    scalar('image_id', record.id),
    scalar('description', description),
    scalar('caption_status', record.captionStatus),
    scalar('local_file', wikiLink(record.imagePath)),
    scalar('sidecar_file', wikiLink(record.sidecarPath)),
    'source_notes:',
    ...record.sourceNotes.map((entry) => `  - ${JSON.stringify(wikiLink(entry.replace(/\.md$/i, '')))}`),
    scalar('captured_at', record.metadata.capturedAt),
    scalar('capture_time_raw', record.metadata.captureTimeRaw),
    scalar('capture_time_offset', record.metadata.captureTimeOffset),
    scalar('capture_time_status', record.metadata.captureTimeStatus),
    scalar('imported_at', record.importedAt),
    scalar('sha256', record.sha256),
    scalar('byte_count', record.bytes),
    scalar('format', record.format),
    scalar('source_name', record.sourceName),
    scalar('source_last_modified', record.sourceLastModified),
    scalar('ingest_method', record.ingestMethod),
    scalar('width', record.metadata.width),
    scalar('height', record.metadata.height),
    scalar('orientation', record.metadata.orientation),
    scalar('camera_make', record.metadata.cameraMake),
    scalar('camera_model', record.metadata.cameraModel),
    scalar('metadata_warning', record.metadata.warning ?? null),
    '---',
    '',
    `# ${description.replace(/([\\`*_{}\[\]<>])/g, '\\$1')}`,
    '',
    markdownEmbed(portable, record.recordPath),
    '',
    'The description and caption status above can be edited in Bases. Other properties describe the preserved image. This record contains the information needed to rebuild the image index.',
    '',
    RECORD_START,
    '```json',
    JSON.stringify(portable, null, 2),
    '```',
    RECORD_END,
    '',
  ];
  // An explicit empty YAML array is distinguishable from a null property.
  if (record.sourceNotes.length === 0) {
    lines[lines.indexOf('source_notes:')] = 'source_notes: []';
  }
  return lines.join('\n');
}

/** Read our portable record without importing or depending on Obsidian. */
export function parseRecordSnapshot(markdown: string): ImageRecord | null {
  try {
    const match = markdown.match(/<!-- image-ledger:record -->\r?\n```json\r?\n([\s\S]*?)\r?\n```\r?\n<!-- \/image-ledger:record -->/);
    if (!match) return null;
    const value: unknown = JSON.parse(match[1]);
    return isImageRecord(value) ? value : null;
  } catch {
    return null;
  }
}

export function parseRecord(markdown: string): ImageRecord | null {
  try {
    const parsed = parseRecordSnapshot(markdown);
    if (!parsed) return null;
    const frontmatter = markdown.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
    if (!frontmatter) return null;
    const type = readFrontmatterScalar(frontmatter, 'type');
    const id = readFrontmatterScalar(frontmatter, 'image_id');
    if (type !== 'image-ledger-image' || id !== parsed.id) return null;
    const hash = readFrontmatterScalar(frontmatter, 'sha256');
    if (hash !== undefined && hash !== parsed.sha256) return null;
    const localFile = readFrontmatterScalar(frontmatter, 'local_file');
    if (localFile !== undefined && localFile !== wikiLink(parsed.imagePath)) return null;
    const editedDescription = readFrontmatterScalar(frontmatter, 'description');
    if (editedDescription !== undefined) {
      if (typeof editedDescription !== 'string') return null;
      parsed.description = normalizeDescription(editedDescription);
    } else {
      parsed.description = normalizeDescription(parsed.description);
    }
    const captionStatus = readFrontmatterScalar(frontmatter, 'caption_status');
    if (captionStatus !== undefined) {
      if (captionStatus !== 'pending' && captionStatus !== 'confirmed') return null;
      parsed.captionStatus = captionStatus;
    }
    const entries = readSourceNotes(frontmatter);
    if (entries !== undefined) parsed.sourceNotes = entries;
    return isImageRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readSourceNotes(frontmatter: string): string[] | undefined {
  const key = 'source_notes';
  const lines = frontmatter.split(/\r?\n/);
  const start = lines.findIndex(line => line.startsWith(`${key}:`));
  if (start < 0) return undefined;
  const inline = lines[start].slice(key.length + 1).trim();
  const strings: string[] = [];
  if (inline) {
    const values: unknown = JSON.parse(inline);
    if (!Array.isArray(values) || !values.every(value => typeof value === 'string')) {
      throw new Error('Invalid note links.');
    }
    strings.push(...values);
  } else {
    for (let index = start + 1; index < lines.length; index++) {
      const line = lines[index];
      if (!line.trim() || /^\s*#/.test(line)) continue;
      const item = /^\s*-\s+(.+)$/.exec(line);
      if (!item) {
        if (/^[^\s:#][^:]*:/.test(line)) break;
        throw new Error('Invalid note list.');
      }
      const value = readFrontmatterScalar(`item: ${item[1]}`, 'item');
      if (typeof value !== 'string') throw new Error('Invalid note link.');
      strings.push(value);
    }
  }
  return strings.map(value => {
    const link = /^\[\[([^\[\]#|]+)\]\]$/.exec(value);
    if (!link) throw new Error('Invalid note link.');
    const location = link[1].endsWith('.md') ? link[1] : `${link[1]}.md`;
    assertVaultPath(location);
    return location;
  });
}

/** A standard XMP sidecar keeps the image ID and caption alongside unchanged bytes. */
export function serializeSidecar(record: ImageRecord): string {
  if (!isImageRecord(record)) throw new Error('Cannot serialize an invalid image record.');
  const description = xml(normalizeDescription(record.description));
  const identifier = isLegacyImageId(record.id) ? `urn:uuid:${record.id}` : record.id;
  const created = record.metadata.capturedAt === null
    ? ''
    : `\n      <xmp:CreateDate>${xml(record.metadata.capturedAt)}</xmp:CreateDate>`;
  return `<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Image Ledger">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about=""
      xmlns:dc="http://purl.org/dc/elements/1.1/"
      xmlns:xmp="http://ns.adobe.com/xap/1.0/">
      <dc:identifier><rdf:Bag><rdf:li>${xml(identifier)}</rdf:li></rdf:Bag></dc:identifier>
      <dc:description><rdf:Alt><rdf:li xml:lang="x-default">${description}</rdf:li></rdf:Alt></dc:description>${created}
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>
`;
}

/** Bases is a view of ordinary Markdown notes, not a separate metadata store. */
export const BASE_CONTENT = `filters:
  and:
    - 'note.type == "image-ledger-image"'
properties:
  note.description:
    displayName: Description
  note.local_file:
    displayName: Image
  note.captured_at:
    displayName: Captured
  note.imported_at:
    displayName: Imported
  note.caption_status:
    displayName: Caption status
  note.source_notes:
    displayName: Notes
views:
  - type: table
    name: Images
    order:
      - note.description
      - note.local_file
      - note.captured_at
      - note.imported_at
      - note.caption_status
      - note.source_notes
    sort:
      - property: note.imported_at
        direction: DESC
`;

function xml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]!);
}

function wikiLink(vaultPath: string): string {
  assertVaultPath(vaultPath);
  return `[[${vaultPath}]]`;
}

export function assertVaultPath(value: string): void {
  if (typeof value !== 'string' || !value
    || posix.isAbsolute(value)
    || /[\\\u0000-\u001f\[\]#|^]/.test(value)
    || /^[a-z][a-z\d+.-]*:/i.test(value)) {
    throw new Error('Image records require safe vault-relative paths.');
  }
  if (value.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error('Image records cannot contain path traversal.');
  }
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value));
}

function isMetadata(value: unknown): value is ImageMetadata {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const item = value as Partial<ImageMetadata>;
  return isNullableString(item.capturedAt)
    && isNullableString(item.captureTimeRaw)
    && isNullableString(item.captureTimeOffset)
    && ['source_offset', 'timezone_unknown', 'missing_from_received_file'].includes(item.captureTimeStatus ?? '')
    && isNullableNumber(item.width)
    && isNullableNumber(item.height)
    && isNullableNumber(item.orientation)
    && isNullableString(item.cameraMake)
    && isNullableString(item.cameraModel)
    && typeof item.raw === 'object'
    && item.raw !== null
    && !Array.isArray(item.raw)
    && (item.warning === undefined || typeof item.warning === 'string');
}

export function isImageRecord(value: unknown): value is ImageRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  if (Object.keys(value).some(key => !RECORD_FIELDS.has(key))) return false;
  const item = value as Partial<ImageRecord>;
  if (item.schemaVersion !== 2
    || !isImageId(item.id)
    || typeof item.description !== 'string' || !item.description.trim()
    || (item.captionStatus !== 'confirmed' && item.captionStatus !== 'pending')
    || typeof item.sha256 !== 'string' || !SHA256.test(item.sha256)
    || typeof item.bytes !== 'number' || !Number.isSafeInteger(item.bytes) || item.bytes <= 0
    || (item.format !== 'jpg' && item.format !== 'png')
    || !isNullableString(item.sourceName) || !isNullableNumber(item.sourceLastModified)
    || !['clipboard', 'drop', 'file'].includes(item.ingestMethod ?? '')
    || typeof item.importedAt !== 'string' || !Number.isFinite(Date.parse(item.importedAt))
    || !Array.isArray(item.sourceNotes) || !isMetadata(item.metadata)) {
    return false;
  }
  try {
    for (const path of [item.imagePath, item.recordPath, item.sidecarPath, ...item.sourceNotes]) {
      if (typeof path !== 'string') return false;
      assertVaultPath(path);
    }
    if (posix.basename(item.imagePath!) !== `${item.id}.${item.format}`
      || posix.basename(item.recordPath!) !== `${item.id}.md`
      || posix.basename(item.sidecarPath!) !== `${item.id}.xmp`
      || !item.sourceNotes.every((path) => path.endsWith('.md'))) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** Read simple scalars and folded/literal captions produced by Obsidian YAML. */
function readFrontmatterScalar(frontmatter: string, key: string): string | number | null | undefined {
  const lines = frontmatter.split(/\r?\n/);
  const index = lines.findIndex((line) => line.startsWith(`${key}:`));
  if (index < 0) return undefined;
  const raw = lines[index].slice(key.length + 1).trim();
  if (/^[>|][+-]?$/.test(raw)) {
    const content: string[] = [];
    for (let cursor = index + 1; cursor < lines.length && (/^\s/.test(lines[cursor]) || lines[cursor] === ''); cursor++) {
      content.push(lines[cursor].replace(/^ {1,}/, ''));
    }
    return content.join(raw[0] === '>' ? ' ' : '\n').trim();
  }
  if (raw.startsWith('"')) return JSON.parse(raw) as string;
  if (raw.startsWith("'")) {
    if (!raw.endsWith("'")) throw new Error('Invalid YAML string.');
    return raw.slice(1, -1).replace(/''/g, "'");
  }
  if (raw === 'null' || raw === '~' || raw === '') return null;
  return raw.replace(/\s+#.*$/, '').trim();
}
