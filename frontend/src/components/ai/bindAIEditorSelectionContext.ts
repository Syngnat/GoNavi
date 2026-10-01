import type { AIContextItem, AIEditorSelection } from '../../types';
import { buildAIEditorSelectionContextItem, isAIEditorSelectionContext } from './aiEditorSelectionContext';

interface BindAIEditorSelectionContextOptions {
  selection: AIEditorSelection | null | undefined;
  connectionKey: string;
  contextItems: AIContextItem[];
  addAIContext: (connectionKey: string, item: AIContextItem) => void;
  removeAIContext: (connectionKey: string, dbName: string, tableName: string) => void;
}

export type AIEditorSelectionBindingResult = 'added' | 'unchanged' | 'empty';

/** Keep composer and editor actions on the same selection attachment contract. */
export const bindAIEditorSelectionContext = ({
  selection,
  connectionKey,
  contextItems,
  addAIContext,
  removeAIContext,
}: BindAIEditorSelectionContextOptions): AIEditorSelectionBindingResult => {
  if (!selection?.tabId.trim() || !selection.text.trim()) return 'empty';
  const selectionItems = contextItems.filter(isAIEditorSelectionContext);
  const alreadyBound = selectionItems.some((item) => item.source?.tabId === selection.tabId
    && String(item.content || item.ddl || '') === selection.text);
  if (alreadyBound) return 'unchanged';

  selectionItems.forEach((item) => removeAIContext(connectionKey, item.dbName, item.tableName));
  addAIContext(connectionKey, buildAIEditorSelectionContextItem(selection));
  return 'added';
};
