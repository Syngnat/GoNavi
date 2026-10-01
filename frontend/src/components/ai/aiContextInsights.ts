import type { AIContextItem, SavedConnection } from '../../types';
import { translateInspectionCopy, type AIInspectionTranslator } from './aiInspectionI18n';
import { isAIEditorSelectionContext, isAITableSchemaContext } from './aiEditorSelectionContext';

const DEFAULT_DDL_PREVIEW_LIMIT = 320;
const DEFAULT_DDL_INCLUDE_LIMIT = 4000;

const normalizeDDLLimit = (input: unknown): number => {
  const value = Math.floor(Number(input) || DEFAULT_DDL_INCLUDE_LIMIT);
  if (value < 200) return 200;
  if (value > 12000) return 12000;
  return value;
};

const buildConnectionKey = (activeContext?: { connectionId: string; dbName: string } | null): string =>
  activeContext?.connectionId ? `${activeContext.connectionId}:${activeContext.dbName || ''}` : 'default';

const sliceText = (value: string, limit: number): { text: string; truncated: boolean; charCount: number } => {
  const normalized = String(value || '').trim();
  const visible = normalized.slice(0, limit);
  return {
    text: visible,
    truncated: normalized.length > visible.length,
    charCount: normalized.length,
  };
};

const buildTableContextSnapshot = (params: {
  item: AIContextItem;
  includeDDL: boolean;
  ddlLimit: number;
}) => {
  const { item, includeDDL, ddlLimit } = params;
  const preview = sliceText(item.ddl, DEFAULT_DDL_PREVIEW_LIMIT);
  const ddl = includeDDL ? sliceText(item.ddl, ddlLimit) : null;

  return {
    dbName: item.dbName,
    tableName: item.tableName,
    ddlPreview: preview.text,
    ddlPreviewTruncated: preview.truncated,
    ddlCharCount: preview.charCount,
    ddl: ddl?.text,
    ddlTruncated: ddl?.truncated || false,
  };
};

export const buildAIContextSnapshot = (params: {
  activeContext?: { connectionId: string; dbName: string } | null;
  aiContexts?: Record<string, AIContextItem[]>;
  connections: SavedConnection[];
  includeDDL?: boolean;
  ddlLimit?: unknown;
  translate?: AIInspectionTranslator;
}) => {
  const {
    activeContext = null,
    aiContexts = {},
    connections,
    includeDDL = false,
    ddlLimit,
    translate,
  } = params;
  const contextKey = buildConnectionKey(activeContext);
  const activeContextItems = aiContexts[contextKey] || [];
  const tableItems = activeContextItems.filter(isAITableSchemaContext);
  const selectionItems = activeContextItems.filter(isAIEditorSelectionContext);
  const activeConnection = activeContext?.connectionId
    ? connections.find((connection) => connection.id === activeContext.connectionId)
    : undefined;

  return {
    hasActiveContext: activeContextItems.length > 0,
    contextKey,
    connectionId: activeContext?.connectionId || '',
    connectionName: activeConnection?.name || '',
    connectionType: activeConnection?.config?.type || '',
    dbName: activeContext?.dbName || '',
    tableCount: tableItems.length,
    selectionCount: selectionItems.length,
    includeDDL,
    tables: tableItems.map((item) =>
      buildTableContextSnapshot({
        item,
        includeDDL,
        ddlLimit: normalizeDDLLimit(ddlLimit),
      })),
    selections: selectionItems.map((item) => {
      const content = sliceText(item.content || item.ddl, normalizeDDLLimit(ddlLimit));
      return {
        label: item.label || item.source?.tabTitle || '',
        tabId: item.source?.tabId || '',
        content: includeDDL ? content.text : undefined,
        contentTruncated: content.truncated,
        charCount: content.charCount,
      };
    }),
    message: activeContextItems.length > 0
      ? translateInspectionCopy(
        translate,
        'ai_chat.inspection.ai_context.linked_summary',
        `Currently linked AI contexts: ${activeContextItems.length}`,
        { count: activeContextItems.length },
      )
      : translateInspectionCopy(
        translate,
        'ai_chat.inspection.ai_context.none_linked',
        'No AI table schema context is currently linked',
      ),
  };
};
