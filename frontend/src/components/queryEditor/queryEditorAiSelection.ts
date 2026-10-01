import {
  clearAIEditorSelection,
  publishAIEditorSelection,
} from '../ai/aiEditorSelectionContext';
import type { AIEditorSelection } from '../../types';

interface QueryEditorSelectionRange {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

interface QueryEditorSelectionModel {
  getValueInRange?: (range: QueryEditorSelectionRange) => unknown;
}

export interface QueryEditorSelectionEditor {
  getModel?: () => QueryEditorSelectionModel | null;
  getSelection?: () => QueryEditorSelectionRange | null;
}

export interface QueryEditorSelectionPublishOptions {
  editor: QueryEditorSelectionEditor;
  tabId: string;
  tabTitle?: string;
  connectionId?: string;
  dbName?: string;
  language?: string;
}

/** Publish the current Monaco range to the AI composer selection registry. */
export const publishQueryEditorSelection = ({
  editor,
  tabId,
  tabTitle,
  connectionId,
  dbName,
  language,
}: QueryEditorSelectionPublishOptions): AIEditorSelection | null => {
  const model = editor.getModel?.();
  const selection = editor.getSelection?.();
  if (!model || !selection || typeof model.getValueInRange !== 'function') {
    clearAIEditorSelection(tabId);
    return null;
  }
  const selectedText = String(model.getValueInRange(selection) || '');
  if (!selectedText.trim()) {
    clearAIEditorSelection(tabId);
    return null;
  }
  return publishAIEditorSelection({
    tabId,
    tabTitle,
    connectionId,
    dbName,
    language,
    text: selectedText,
    startLine: Number(selection.startLineNumber),
    startColumn: Number(selection.startColumn),
    endLine: Number(selection.endLineNumber),
    endColumn: Number(selection.endColumn),
  });
};

export { clearAIEditorSelection };
