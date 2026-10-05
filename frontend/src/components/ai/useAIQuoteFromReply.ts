import React from 'react';

import { useStore } from '../../store';
import { buildAIChatQuoteContextItem } from './aiEditorSelectionContext';
import { clampQuoteText } from './aiReplySelection';
import type { AIQuoteMode } from './AIReplySelectionToolbar';

/**
 * Text selected in an answer can be quoted: it becomes a chip in the composer for
 * the next message ("reply" also puts the cursor in the input to write the reply).
 */
export const useAIQuoteFromReply = (
  activeContext: { connectionId?: string | null; dbName?: string | null } | null,
  textareaRef: React.RefObject<HTMLTextAreaElement>,
) => React.useCallback((text: string, messageId: string, mode: AIQuoteMode) => {
  const key = activeContext?.connectionId ? `${activeContext.connectionId}:${activeContext.dbName || ''}` : 'default';
  useStore.getState().addAIContext(key, buildAIChatQuoteContextItem(clampQuoteText(text), messageId, activeContext?.dbName || ''));
  if (mode === 'reply') setTimeout(() => textareaRef.current?.focus(), 0);
}, [activeContext?.connectionId, activeContext?.dbName, textareaRef]);
