import {
  clearAIEditorSelection,
  publishAIEditorSelection,
  registerAIEditorSelectionRefresher,
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

interface QueryEditorSelectionBindingEditor extends QueryEditorSelectionEditor {
  onDidChangeCursorSelection?: (listener: () => void) => { dispose?: () => void } | void;
  onDidDispose?: (listener: () => void) => unknown;
}

/**
 * Keep the AI selection registry in step with a Monaco editor: publish on every
 * selection change, and let the composer ask for the current selection on
 * demand. `options` is read each time so a connection or database switch is
 * picked up. Returns a disposer; it also runs when the editor is disposed.
 */
export const bindQueryEditorSelectionPublisher = (
  editor: QueryEditorSelectionBindingEditor,
  options: () => Omit<QueryEditorSelectionPublishOptions, 'editor'>,
): (() => void) => {
  const publish = () => publishQueryEditorSelection({ editor, ...options() });
  const subscription = editor.onDidChangeCursorSelection?.(publish);
  const unregister = registerAIEditorSelectionRefresher(options().tabId, publish);
  publish();
  const dispose = () => {
    subscription?.dispose?.();
    unregister();
  };
  editor.onDidDispose?.(dispose);
  return dispose;
};

export { clearAIEditorSelection };
