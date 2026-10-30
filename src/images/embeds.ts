import type { ImageRecord } from './model';
import type { EmbedRange } from './operations';
import { posix } from 'node:path';
import { parser } from '@lezer/markdown';

export interface ManagedImageEmbed extends EmbedRange {
  record: ImageRecord;
}

export function escapePattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function imageTargetPattern(embed: string): string {
  const target = embed.slice(embed.lastIndexOf('](') + 2, -1);
  // Existing generated destinations can contain literal parentheses; alt text must stay exact.
  return escapePattern(target)
    .replace(/%28/g, '(?:%28|\\()')
    .replace(/%29/g, '(?:%29|\\))');
}

/** Match managed destinations relative to this note, independent of their alt text. */
export function managedImageEmbeds(text: string, sourcePath: string, records: ImageRecord[]): ManagedImageEmbed[] {
  const embeds: ManagedImageEmbed[] = [];
  const byPath = new Map(records.map(record => [record.imagePath, record]));
  const frontmatter = /^---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?---[ \t]*(?:\r?\n|$)/.exec(text);
  const from = frontmatter?.[0].length ?? 0;
  parser.parse(text.slice(from)).iterate({
    enter(node) {
      if (node.name !== 'Image') return;
      // shortcut: inline Markdown destinations only; add reference/wiki resolution when those formats are supported.
      const url = node.node.getChild('URL');
      const target = url && resolveImageTarget(text.slice(from + url.from, from + url.to), sourcePath);
      const record = target ? byPath.get(target) : undefined;
      if (record) embeds.push({from: from + node.from, to: from + node.to, record});
      // Images nested inside alt text are labels, not independently displayed images.
      return false;
    },
  });
  return embeds;
}

function resolveImageTarget(target: string, sourcePath: string): string | undefined {
  if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1);
  target = target.replace(/\\([!-/:-@\[-`{-~])/g, '$1');
  if (/^(?:[a-z][a-z\d+.-]*:|\/)/i.test(target)) return;
  try {
    return posix.normalize(posix.join(posix.dirname(sourcePath), decodeURIComponent(target)));
  } catch {
    return undefined;
  }
}

/** A selection must stay inside one embed; a caret uses an exclusive end offset. */
export function findManagedImage(text: string, sourcePath: string, records: ImageRecord[], selection: number | EmbedRange): ManagedImageEmbed | undefined {
  const {from, to} = typeof selection === 'number' ? {from: selection, to: selection} : selection;
  return managedImageEmbeds(text, sourcePath, records).find(embed =>
    from >= embed.from && from < embed.to && to >= from && to <= embed.to);
}
