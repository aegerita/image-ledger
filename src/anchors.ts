import { StateEffect, StateField } from '@codemirror/state';
export interface InsertionAnchor { id: string; from: number; to: number; selected: string }
export const addAnchor = StateEffect.define<InsertionAnchor>();
export const removeAnchor = StateEffect.define<string>();
export const insertionAnchors = StateField.define<Map<string, InsertionAnchor>>({
  create: () => new Map(),
  update(value, transaction) {
    const mapped = new Map<string, InsertionAnchor>();
    for (const [id, anchor] of value) {
      const from = transaction.changes.mapPos(anchor.from, 1);
      const to = Math.max(from, transaction.changes.mapPos(anchor.to, -1));
      mapped.set(id, {...anchor, from, to});
    }
    for (const effect of transaction.effects) {
      if (effect.is(addAnchor)) mapped.set(effect.value.id, effect.value);
      if (effect.is(removeAnchor)) mapped.delete(effect.value);
    }
    return mapped;
  },
});
