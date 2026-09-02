import type { SqlLog } from '../../store';
import type { AIChatMessage, AIContextItem } from '../../types';
import { t as translateCatalog, type I18nParams } from '../../i18n';
import type { AIChatInlineHistorySession, AIChatInsightItem, AIChatPanelMode } from './AIChatPanelModeContent';

interface InferAIChatConnectionContextArgs {
  activeConnectionId?: string;
  activeDbName?: string;
}

interface CollectAIChatContextTableNamesArgs {
  aiContexts: Record<string, AIContextItem[]>;
  activeConnectionId?: string;
  activeDbName?: string;
}

interface BuildAIChatInsightsArgs {
  contextTableNames: string[];
  sqlLogs: SqlLog[];
  translate?: (key: string, params?: I18nParams) => string;
}

export const inferAIChatConnectionContext = ({
  activeConnectionId,
  activeDbName,
}: InferAIChatConnectionContextArgs) => {
  return {
    inferredConnectionId: activeConnectionId,
    inferredDbName: activeDbName,
  };
};

export const calculateAIContextUsageChars = (messages: AIChatMessage[]) =>
  messages.reduce(
    (sum, item) =>
      sum
      + (item.content?.length || 0)
      + (item.reasoning_content?.length || 0)
      + JSON.stringify(item.tool_calls || []).length,
    0,
  );

export const collectAIChatContextTableNames = ({
  aiContexts,
  activeConnectionId,
  activeDbName,
}: CollectAIChatContextTableNamesArgs) => {
  const contextKey = activeConnectionId ? `${activeConnectionId}:${activeDbName || ''}` : 'default';
  return (aiContexts[contextKey] || []).map((item) => `${item.dbName}.${item.tableName}`);
};

export const buildAIChatInsights = ({
  contextTableNames,
  sqlLogs,
  translate = (key, params) => translateCatalog(key, params, 'en-US'),
}: BuildAIChatInsightsArgs): AIChatInsightItem[] => {
  const recentLogs = sqlLogs.slice(0, 24);
  const slowest = recentLogs
    .filter((log) => log.status === 'success')
    .sort((left, right) => right.duration - left.duration)[0];
  const errors = recentLogs.filter((log) => log.status === 'error');
  const writeCount = recentLogs.filter((log) => /\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE)\b/i.test(log.sql)).length;
  const contextCount = contextTableNames.length;
  const tableSeparator = translate('ai_chat.panel.insight.context.table_separator');
  const tablePreview = `${contextTableNames.slice(0, 3).join(tableSeparator)}${contextCount > 3 ? translate('ai_chat.panel.insight.context.more_tables_suffix') : ''}`;

  return [
    {
      tone: 'info',
      title: contextCount > 0
        ? translate('ai_chat.panel.insight.context.linked_title', { count: contextCount })
        : translate('ai_chat.panel.insight.context.empty_title'),
      body: contextCount > 0
        ? translate('ai_chat.panel.insight.context.linked_body', { tables: tablePreview })
        : translate('ai_chat.panel.insight.context.empty_body'),
    },
    {
      tone: slowest && slowest.duration > 1000 ? 'warn' : 'accent',
      title: slowest
        ? translate('ai_chat.panel.insight.query.slowest_title', { duration: Math.round(slowest.duration).toLocaleString() })
        : translate('ai_chat.panel.insight.query.empty_title'),
      body: slowest ? slowest.sql.slice(0, 140) : translate('ai_chat.panel.insight.query.empty_body'),
    },
    {
      tone: errors.length > 0 ? 'warn' : 'info',
      title: errors.length > 0
        ? translate('ai_chat.panel.insight.status.failed_title', { count: errors.length })
        : translate('ai_chat.panel.insight.status.ok_title'),
      body: errors[0]?.message || (
        recentLogs.length > 0
          ? translate('ai_chat.panel.insight.status.recent_body', { count: recentLogs.length })
          : translate('ai_chat.panel.insight.status.empty_body')
      ),
    },
    {
      tone: writeCount > 0 ? 'warn' : 'accent',
      title: writeCount > 0
        ? translate('ai_chat.panel.insight.write.detected_title', { count: writeCount })
        : translate('ai_chat.panel.insight.write.readonly_title'),
      body: writeCount > 0
        ? translate('ai_chat.panel.insight.write.detected_body')
        : translate('ai_chat.panel.insight.write.readonly_body'),
    },
  ];
};

export const buildAIChatInlineHistorySessions = (
  sessions: AIChatInlineHistorySession[],
  limit = 8,
) => sessions.slice(0, limit);

export const resolveAIChatPanelMode = (
  isV2Ui: boolean,
  activePanelMode: AIChatPanelMode,
): AIChatPanelMode => (isV2Ui ? activePanelMode : 'chat');
