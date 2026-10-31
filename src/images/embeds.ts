import type { ImageRecord } from './model';
import type { EmbedRange } from './operations';
import { posix } from 'node:path';
import { parser } from '@lezer/markdown';

export interface ManagedImageEmbed extends EmbedRange {
  record: ImageRecord;
  reference?: boolean;
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
export function managedImageEmbeds(text: string, sourcePath: string, records: ImageRecord[], includeReferences = false): ManagedImageEmbed[] {
  const embeds: ManagedImageEmbed[] = [];
  const byPath = new Map(records.map(record => [record.imagePath, record]));
  const frontmatter = /^---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?---[ \t]*(?:\r?\n|$)/.exec(text);
  const from = frontmatter?.[0].length ?? 0;
  const tree = parser.parse(text.slice(from));
  const references = new Map<string, string | undefined>();
  if (includeReferences) {
    tree.iterate({
      enter(node) {
        if (node.name !== 'LinkReference') return;
        const label = node.node.getChild('LinkLabel');
        const url = node.node.getChild('URL');
        if (!label || !url) return;
        const key = referenceLabel(text.slice(from + label.from + 1, from + label.to - 1));
        if (!references.has(key)) {
          references.set(key, resolveImageTarget(text.slice(from + url.from, from + url.to), sourcePath));
        }
        return false;
      },
    });
  }
  tree.iterate({
    enter(node) {
      if (node.name !== 'Image') return;
      // Reference occurrences are inspected for save reports; cursor lookup remains inline-only.
      const url = node.node.getChild('URL');
      let target = url ? resolveImageTarget(text.slice(from + url.from, from + url.to), sourcePath) : undefined;
      if (!url && includeReferences) {
        const label = node.node.getChild('LinkLabel');
        const close = node.node.getChildren('LinkMark').at(-1);
        if (!close) return false;
        const key = label && label.to - label.from > 2
          ? text.slice(from + label.from + 1, from + label.to - 1)
          : text.slice(from + node.from + 2, from + close.from);
        target = references.get(referenceLabel(key));
      }
      const record = target ? byPath.get(target) : undefined;
      if (record) {
        const embed: ManagedImageEmbed = {from: from + node.from, to: from + node.to, record};
        if (!url) embed.reference = true;
        embeds.push(embed);
      }
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

function referenceLabel(text: string): string {
  return text.trim().replace(/\s+/gu, ' ').toUpperCase();
}
