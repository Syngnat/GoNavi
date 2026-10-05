import React from 'react';

import type { AIChatAttachment, AIContextItem, AIProviderConfig } from '../../types';
import { toAgentAttachments } from './aiAgentAttachments';
import { buildAIChatAttachmentPromptText } from './aiChatAttachments';
import {
  buildAIContextBreakdown,
  buildAIContextBreakdownFromPreview,
  jsonStringBytes,
  type AIContextBreakdown,
  type AIHistoryMeasure,
} from './aiContextBreakdown';
import { buildContextChipAttachments } from './aiContextChips';
import { canPreviewAgentContext, previewAgentContext, type AgentContextPreview } from './aiContextPreviewClient';
import { getAIWorkspaceSourceInstanceID } from './useAIWorkspaceSnapshot';
import {
  getPublishedWorkspaceMeasure,
  getWorkspaceSnapshotVersion,
  subscribeToWorkspaceSnapshot,
} from './aiWorkspaceSnapshotMeasure';

interface UseAIContextBreakdownOptions {
  history?: AIHistoryMeasure;
  /** The panel's own figure for the window: shown where the agent enforces none. */
  contextWindow?: number;
  activeProvider: Pick<AIProviderConfig, 'id' | 'model' | 'maxTokens'> | null;
  /** What the person has bound for the next message (selections, quotes, table schemas). */
  contextItems: readonly AIContextItem[];
  input: string;
  draftAttachments: readonly AIChatAttachment[];
  /** The conversation the next message goes into; none before the first message. */
  sessionId?: string;
}

/** How long typing has to pause before the next measure is asked for. */
export const PREVIEW_DEBOUNCE_MS = 300;

/** The background workspace's share of the prompt budget, as the agent trims it. */
const LOCAL_WORKSPACE_SHARE = 0.25;

/** Images are only named: the agent costs one at a fixed size, whatever its bytes. */
const imageMarker = (attachment: AIChatAttachment): AIChatAttachment => (
  attachment.kind === 'image' && attachment.dataUrl
    ? { ...attachment, dataUrl: attachment.dataUrl.slice(0, attachment.dataUrl.indexOf(',') + 1) || 'data:image/png;base64,' }
    : attachment
);

/**
 * The composition of the next request, kept current as the person types, binds
 * context, or the conversation moves on. Go measures it with the builder a run
 * uses, so the workspace the agent trims, the earlier messages that no longer fit,
 * and the real window are what is shown. Where Go cannot measure (not ready, the
 * browser-served runtime) it is estimated here instead. Null until there is
 * something to show.
 */
export const useAIContextBreakdown = ({
  history, contextWindow, activeProvider, contextItems, input, draftAttachments, sessionId,
}: UseAIContextBreakdownOptions): AIContextBreakdown | null => {
  // The workspace is republished a moment after the desktop changes; follow it.
  const workspaceVersion = React.useSyncExternalStore(
    subscribeToWorkspaceSnapshot, getWorkspaceSnapshotVersion, getWorkspaceSnapshotVersion,
  );
  const latest = React.useRef({ contextItems, draftAttachments, input });
  latest.current = { contextItems, draftAttachments, input };
  const [measured, setMeasured] = React.useState<AgentContextPreview | null>(null);
  const [measuring, setMeasuring] = React.useState(() => canPreviewAgentContext());

  // Cheap signatures: the request itself can be large (documents), so it is built when sent.
  const boundSignature = contextItems.map((item) => `${item.kind ?? ''}:${item.dbName}.${item.tableName}:${String(item.content ?? item.ddl ?? '').length}`).join('|');
  const attachmentSignature = draftAttachments.map((attachment) => `${attachment.id}:${attachment.ocr?.status ?? ''}:${attachment.ocr?.text?.length ?? 0}`).join('|');
  const historySignature = `${history?.messageCount ?? 0}`;
  const providerKey = `${activeProvider?.id ?? ''}|${activeProvider?.model ?? ''}`;

  React.useEffect(() => {
    if (!canPreviewAgentContext()) {
      setMeasuring(false);
      return undefined;
    }
    let stale = false;
    const timer = setTimeout(() => {
      const { contextItems: bound, draftAttachments: attached, input: typed } = latest.current;
      void previewAgentContext({
        requestId: 'context-preview',
        ...(sessionId ? { sessionId } : {}),
        content: typed,
        attachments: toAgentAttachments([...attached.map(imageMarker), ...buildContextChipAttachments(bound as AIContextItem[])]),
        contextSourceId: 'desktop',
        contextSourceInstanceId: getAIWorkspaceSourceInstanceID(),
        provider: activeProvider?.id || undefined,
        model: activeProvider?.model || undefined,
      }).then((result) => {
        if (stale) return;
        setMeasured(result);
        setMeasuring(true);
      }).catch(() => {
        // Go cannot measure right now (no provider, ledger not ready): estimate instead.
        if (!stale) { setMeasured(null); setMeasuring(false); }
      });
    }, PREVIEW_DEBOUNCE_MS);
    return () => { stale = true; clearTimeout(timer); };
    // The signatures stand for the objects they are made from.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, providerKey, input, attachmentSignature, boundSignature, historySignature, workspaceVersion]);

  const reservedOutput = activeProvider?.maxTokens && activeProvider.maxTokens > 0 ? activeProvider.maxTokens : 0;

  return React.useMemo(() => {
    if (!history || !contextWindow || contextWindow <= 0) return null;
    if (measured) {
      return buildAIContextBreakdownFromPreview(measured, { windowSize: contextWindow, reservedOutput }, history.pendingAssistant);
    }
    // Waiting for the first measurement: show nothing rather than a number that may be wrong.
    if (measuring) return null;
    const workspaceBytes = getPublishedWorkspaceMeasure().workspaceBytes;
    const budget = Math.max(0, contextWindow - reservedOutput);
    const boundBytes = contextItems.length > 0 ? jsonStringBytes(JSON.stringify(contextItems)) : 0;
    const attachmentText = buildAIChatAttachmentPromptText(draftAttachments as AIChatAttachment[]);
    return buildAIContextBreakdown({
      windowSize: contextWindow,
      reservedOutput,
      workspaceBytes: Math.min(workspaceBytes, Math.floor(budget * LOCAL_WORKSPACE_SHARE)),
      boundBytes,
      history: { ...history, assistant: history.assistant + (history.pendingAssistant ?? 0) },
      draftText: attachmentText ? `${input}\n${attachmentText}` : input,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [measured, measuring, history, contextWindow, reservedOutput, boundSignature, attachmentSignature, input, workspaceVersion]);
};
