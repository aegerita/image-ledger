import type { ImageRecord } from './model';
import type { EmbedRange } from './operations';
import { markdownEmbed } from './records';

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
  for (const record of records) {
    const target = imageTargetPattern(markdownEmbed(record, sourcePath));
    const pattern = new RegExp(`!\\[(?:\\\\.|[^\\]\\\\\\n])*\\]\\(${target}\\)`, 'g');
    for (const match of text.matchAll(pattern)) {
      embeds.push({from: match.index, to: match.index + match[0].length, record});
    }
  }
  return embeds.sort((left, right) => left.from - right.from);
}

/** A selection must stay inside one embed; a caret uses an exclusive end offset. */
export function findManagedImage(text: string, sourcePath: string, records: ImageRecord[], selection: number | EmbedRange): ManagedImageEmbed | undefined {
  const {from, to} = typeof selection === 'number' ? {from: selection, to: selection} : selection;
  return managedImageEmbeds(text, sourcePath, records).find(embed =>
    from >= embed.from && from < embed.to && to >= from && to <= embed.to);
}
