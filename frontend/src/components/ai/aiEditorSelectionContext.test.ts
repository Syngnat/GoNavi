import { describe, expect, it, vi } from 'vitest';

import {
  AI_EDITOR_SELECTION_MAX_CHARS,
  buildAIEditorSelectionContextItem,
  clearAIEditorSelection,
  getAIEditorSelection,
  publishAIEditorSelection,
} from './aiEditorSelectionContext';
import { bindAIEditorSelectionContext } from './bindAIEditorSelectionContext';

describe('aiEditorSelectionContext', () => {
  it('normalizes and bounds a selection before it can be attached', () => {
    const raw = 'x'.repeat(AI_EDITOR_SELECTION_MAX_CHARS + 20);
    publishAIEditorSelection({
      tabId: 'tab-1',
      tabTitle: 'Orders',
      connectionId: 'conn-1',
      dbName: 'analytics',
      text: raw,
      startLine: 2,
      startColumn: 1,
      endLine: 4,
      endColumn: 8,
    });

    const selection = getAIEditorSelection('tab-1');
    expect(selection?.text.length).toBe(AI_EDITOR_SELECTION_MAX_CHARS);
    expect(selection?.truncated).toBe(true);
    expect(selection?.tabTitle).toBe('Orders');

    const item = buildAIEditorSelectionContextItem(selection!);
    expect(item.kind).toBe('editor_selection');
    expect(item.content).toBe(selection?.text);
    expect(item.source).toEqual(expect.objectContaining({ tabId: 'tab-1', startLine: 2 }));

    clearAIEditorSelection('tab-1');
    expect(getAIEditorSelection('tab-1')).toBeNull();
  });

  it('drops empty selections', () => {
    publishAIEditorSelection({ tabId: 'tab-empty', text: ' \n ' });
    expect(getAIEditorSelection('tab-empty')).toBeNull();
  });

  it('replaces a previously attached editor selection for the same database context', () => {
    const addAIContext = vi.fn();
    const removeAIContext = vi.fn();
    const oldItem = {
      kind: 'editor_selection' as const,
      dbName: 'analytics',
      tableName: '__gonavi_editor_selection__',
      ddl: '',
      content: 'old selection',
      source: { tabId: 'old-tab' },
    };
    const result = bindAIEditorSelectionContext({
      selection: { tabId: 'new-tab', dbName: 'analytics', text: 'new selection' },
      connectionKey: 'conn-1:analytics',
      contextItems: [oldItem],
      addAIContext,
      removeAIContext,
    });

    expect(result).toBe('added');
    expect(removeAIContext).toHaveBeenCalledWith('conn-1:analytics', 'analytics', '__gonavi_editor_selection__');
    expect(addAIContext).toHaveBeenCalledWith('conn-1:analytics', expect.objectContaining({
      kind: 'editor_selection',
      content: 'new selection',
    }));
  });
});
