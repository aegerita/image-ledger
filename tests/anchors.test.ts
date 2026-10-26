import test from 'node:test';
import assert from 'node:assert/strict';
import { EditorState } from '@codemirror/state';
import { addAnchor, insertionAnchors, removeAnchor } from '../src/obsidian/anchors';
test('insertion anchor follows edits before it and releases after use', () => {
  let state = EditorState.create({doc: 'before after', extensions: [insertionAnchors]});
  state = state.update({effects: addAnchor.of({id: 'paste', from: 7, to: 7, selected: ''})}).state;
  state = state.update({changes: {from: 0, insert: 'new '}}).state;
  assert.equal(state.field(insertionAnchors).get('paste')?.from, 11);
  state = state.update({effects: removeAnchor.of('paste')}).state;
  assert.equal(state.field(insertionAnchors).size, 0);
});
