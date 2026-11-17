import { posix } from 'node:path';
import type { ManagedImage } from './model';

export function normalizeDescription(text: string): string {
  if (typeof text !== 'string') throw new TypeError('An image description is required.');
  const description = text.replace(/\s+/gu, ' ').trim();
  if (!description) throw new Error('An image description is required.');
  return description;
}

/** Generate a normal Markdown embed that works without this plugin installed. */
export function markdownEmbed(image: ManagedImage, sourcePath: string): string {
  assertVaultPath(sourcePath);
  assertVaultPath(image.imagePath);
  const relative = posix.relative(posix.dirname(sourcePath), image.imagePath);
  // Escape each URL segment, retaining the relative ../ path components.
  const target = relative.split('/').map(segment => encodeURIComponent(segment)
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')).join('/');
  const alt = (image.description.replace(/\s+/gu, ' ').trim() || 'Image')
    .replace(/\\/g, '\\\\')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]');
  return `![${alt}](${target})`;
}

export function assertVaultPath(value: string): void {
  if (typeof value !== 'string' || !value
    || posix.isAbsolute(value)
    || /[\\\u0000-\u001f\[\]#|^]/.test(value)
    || /^[a-z][a-z\d+.-]*:/i.test(value)) {
    throw new Error('Image Ledger requires safe vault-relative paths.');
  }
  if (value.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error('Image Ledger paths cannot contain traversal.');
  }
}
