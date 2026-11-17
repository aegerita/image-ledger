import type { ManagedImage } from './model';
import type { EmbedRange, NoteProjection } from './operations';
import { posix } from 'node:path';
import { parser } from '@lezer/markdown';

export interface ManagedImageEmbed extends EmbedRange {
  record: ManagedImage;
  alt?: EmbedRange;
}

/** Match managed destinations relative to this note, independent of their alt text. */
export function managedImageEmbeds(text: string, sourcePath: string, records: ManagedImage[], includeReferences = false): ManagedImageEmbed[] {
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
      // Deletion and recovery also inspect reference-style embeds.
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
        if (url) {
          const [open, close] = node.node.getChildren('LinkMark');
          if (open && close) embed.alt = {from: from + open.to, to: from + close.from};
        }
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
export function findManagedImage(text: string, sourcePath: string, records: ManagedImage[], selection: EmbedRange): ManagedImageEmbed | undefined {
  const {from, to} = selection;
  return managedImageEmbeds(text, sourcePath, records).find(embed =>
    from >= embed.from && from < embed.to && to >= from && to <= embed.to);
}

function referenceLabel(text: string): string {
  return text.trim().replace(/\s+/gu, ' ').toUpperCase();
}

/** Delete only parsed embeds, leaving surrounding text intact. */
export function deletionProjection(text: string, sourcePath: string, record: ManagedImage): NoteProjection {
  const beforeRanges: EmbedRange[] = managedImageEmbeds(text, sourcePath, [record], true)
    .map(({from, to}) => ({from, to}));
  const plan: NoteProjection = {before: text, after: '', beforeRanges};
  let cursor = 0;
  for (const range of beforeRanges) {
    plan.after += text.slice(cursor, range.from);
    cursor = range.to;
  }
  plan.after += text.slice(cursor);
  return plan;
}

/** Find wiki and ordinary links even before Obsidian has indexed a changed note. */
export function deletionBlockers(text: string, sourcePath: string, record: ManagedImage, resolveWiki: (link: string) => string | undefined): string[] {
  const plan = deletionProjection(text, sourcePath, record);
  const excluded: EmbedRange[] = [];
  const blocked: string[] = [];
  const frontmatter = /^---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?---[ \t]*(?:\r?\n|$)/.exec(text);
  const offset = frontmatter?.[0].length ?? 0;
  const managed = (target: string | undefined) => target === record.imagePath;
  const resolve = (url: string) => {
    const relative = resolveImageTarget(url, sourcePath);
    if (managed(relative)) return relative;
    try {
      return resolveWiki(decodeURIComponent(url.replace(/^<|>$/g, '')));
    } catch {
      return undefined;
    }
  };
  const tree = parser.parse(text.slice(offset));
  const references = new Map<string, string | undefined>();
  tree.iterate({
    enter(node) {
      if (node.name !== 'LinkReference') return;
      const label = node.node.getChild('LinkLabel');
      const url = node.node.getChild('URL');
      if (!label || !url) return;
      const key = referenceLabel(text.slice(offset + label.from + 1, offset + label.to - 1));
      if (!references.has(key)) references.set(key, resolve(text.slice(offset + url.from, offset + url.to)));
      return false;
    },
  });
  tree.iterate({
    enter(node) {
      const from = offset + node.from;
      const to = offset + node.to;
      if (['FencedCode', 'CodeBlock', 'InlineCode', 'HTMLBlock', 'CommentBlock', 'Comment'].includes(node.name)) {
        excluded.push({from, to});
        return false;
      }
      if (node.name !== 'Link' && node.name !== 'Image') return;
      const url = node.node.getChild('URL');
      let target = url ? resolve(text.slice(offset + url.from, offset + url.to)) : undefined;
      if (!url) {
        const label = node.node.getChild('LinkLabel');
        const close = node.node.getChildren('LinkMark').at(-1);
        if (close) {
          const key = label && label.to - label.from > 2
            ? text.slice(offset + label.from + 1, offset + label.to - 1)
            : text.slice(from + (node.name === 'Image' ? 2 : 1), offset + close.from);
          target = references.get(referenceLabel(key));
        }
      }
      if (managed(target)
        && !plan.beforeRanges.some(range => range.from === from && range.to === to)) {
        blocked.push(text.slice(from, to));
      }
      if (node.name === 'Image') return false;
    },
  });
  for (const match of text.matchAll(/!?\[\[([^\]\n]+)\]\]/g)) {
    if (match.index < offset || excluded.some(range => range.from <= match.index && range.to >= match.index + match[0].length)) continue;
    const target = match[1].split(/[|#]/)[0];
    if (managed(resolveWiki(target))) blocked.push(match[0]);
  }
  return blocked;
}
