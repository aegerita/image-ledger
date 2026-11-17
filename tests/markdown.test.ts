import test from 'node:test';
import assert from 'node:assert/strict';
import { assertVaultPath, markdownEmbed, normalizeDescription } from '../src/images/markdown';
import { deletionBlockers, deletionProjection, findManagedImage, managedImageEmbeds } from '../src/images/embeds';
import type { ManagedImage } from '../src/images/model';

const image: ManagedImage = {
  id: 'a'.repeat(64),
  imagePath: `2026/images/${'a'.repeat(64)}.jpg`,
  description: 'Rice [with egg] & vegetables',
};
const note = '2026/Meals.md';

test('embeds escape descriptions and destinations while pending images use accessible default alt', () => {
  assert.equal(normalizeDescription('  Rice\n and\t eggs '), 'Rice and eggs');
  assert.throws(() => normalizeDescription(' \n '));
  assert.equal(markdownEmbed(image, note), `![Rice \\[with egg\\] & vegetables](images/${image.id}.jpg)`);
  assert.equal(markdownEmbed({...image, description: ''}, note), `![Image](images/${image.id}.jpg)`);
  assert.match(markdownEmbed({...image, imagePath: `images/a (b).jpg`}, note), /a%20%28b%29\.jpg/);
});

test('unsafe vault paths cannot enter generated embeds or deletion receipts', () => {
  for (const value of ['', '../secret.md', '/absolute.jpg', 'a/../b.jpg', 'a\\b.jpg', 'a#b.jpg', 'a\u0000.jpg']) {
    assert.throws(() => assertVaultPath(value));
  }
});

test('cursor lookup finds managed inline embeds and respects caret and selection boundaries', () => {
  const embed = markdownEmbed(image, note);
  const text = `Before\n${embed}\nAfter`;
  const from = text.indexOf(embed);
  const to = from + embed.length;
  assert.equal(findManagedImage(text, note, [image], {from, to: from})?.record, image);
  assert.equal(findManagedImage(text, note, [image], {from: to, to}), undefined);
  assert.equal(findManagedImage(text, note, [image], {from, to})?.record, image);
  assert.equal(findManagedImage(text, note, [image], {from: from - 1, to}), undefined);
  assert.equal(findManagedImage(text, note, [image], {from, to: to + 1}), undefined);
});

test('code, comments, escaped images and frontmatter cannot be mistaken for managed references', () => {
  const embed = markdownEmbed(image, note);
  const text = `---\nexample: '${embed}'\n---\n\n\`${embed}\`\n\n\`\`\`md\n${embed}\n\`\`\`\n\n<!-- ${embed} -->\n\n\\${embed}\n\n${embed}`;
  const found = managedImageEmbeds(text, note, [image], true);
  assert.equal(found.length, 1);
  assert.equal(found[0].from, text.lastIndexOf(embed));
});

test('relative destinations, angle paths and nested custom alt text resolve to the same image', () => {
  const text = `![custom [nested] alt](./images/${image.id}.jpg)\n![another](<images/${image.id}.jpg>)`;
  assert.equal(managedImageEmbeds(text, note, [image]).length, 2);
});

test('deletion removes inline and reference embeds while retaining prose and reference definitions', () => {
  const inline = markdownEmbed(image, note);
  const text = `Before ${inline}\n![custom][meal]\n\n[meal]: images/${image.id}.jpg\n\nAfter`;
  const plan = deletionProjection(text, note, image);
  assert.equal(plan.before, text);
  assert.equal(plan.beforeRanges.length, 2);
  assert.equal(plan.after, `Before \n\n\n[meal]: images/${image.id}.jpg\n\nAfter`);
  assert.equal(deletionBlockers(text, note, image, () => undefined).length, 0);
  assert.equal(managedImageEmbeds(text, note, [image]).length, 1);
  assert.equal(managedImageEmbeds(text, note, [image], true).length, 2);
});

test('deletion blocks wiki and ordinary links without treating examples as live references', () => {
  const target = image.imagePath.split('/').at(-1)!;
  const resolve = (link: string) => link === target ? image.imagePath : undefined;
  const text = `![[${target}]]\n[image](images/${image.id}.jpg)\n\n\`![[${target}]]\`\n<!-- ![[${target}]] -->`;
  assert.deepEqual(deletionBlockers(text, note, image, resolve), [
    `[image](images/${image.id}.jpg)`, `![[${target}]]`,
  ]);
});
