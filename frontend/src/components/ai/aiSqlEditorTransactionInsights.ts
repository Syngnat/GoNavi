import type { SqlLog } from '../../store';
import type { I18nParams } from '../../i18n';
import type { SavedConnection, TabData } from '../../types';
import { findSqlStatementRanges } from '../../utils/sqlStatementSelection';
import {
  isSqlEditorTransactionControlStatement,
  shouldUseSqlEditorManagedTransaction,
  shouldUseSqlEditorManagedTransactionForType,
} from '../../utils/sqlEditorTransaction';
import { resolveSqlDialect } from '../../utils/sqlDialect';
import type {
  AISqlEditorPendingTransactionRuntimeState,
  AISqlEditorTransactionRuntimeState,
} from './aiSnapshotInspectionToolTypes';

type SqlEditorCommitMode = 'manual' | 'auto';
type Translate = (key: string, params?: I18nParams) => string;

const DEFAULT_AUTO_COMMIT_DELAY_MS = 5000;
const SQL_PREVIEW_LIMIT = 1200;
const LOG_TRANSACTION_KEYWORD_PATTERN = new RegExp('\\u4e8b\\u52a1|\\u63d0\\u4ea4|\\u56de\\u6eda|transaction|commit|rollback', 'i');

const translateOrFallback = (
  translate: Translate | undefined,
  key: string,
  params: I18nParams | undefined,
  fallback: string,
) => {
  const translated = translate?.(key, params);
  return translated && translated !== key ? translated : fallback;
};

const normalizeCommitMode = (value: unknown): SqlEditorCommitMode =>
  String(value || '').trim().toLowerCase() === 'auto' ? 'auto' : 'manual';

const normalizeDelayMs = (value: unknown): number => {
  const delayMs = Number(value);
  return Number.isFinite(delayMs) && delayMs > 0 ? delayMs : DEFAULT_AUTO_COMMIT_DELAY_MS;
};

const splitStatements = (sql: string, dbType = ''): string[] =>
  findSqlStatementRanges(String(sql || ''), dbType)
    .map((range) => String(range.text || '').trim())
    .filter(Boolean);

const buildTabSummary = (
  tab: TabData | undefined,
  connections: SavedConnection[],
) => {
  if (!tab) return null;
  const connection = connections.find((item) => item.id === tab.connectionId);
  return {
    id: tab.id,
    title: tab.title,
    type: tab.type,
    connectionId: tab.connectionId,
    connectionName: connection?.name || '',
    connectionType: connection?.config?.type || '',
    dbName: tab.dbName || '',
    filePath: tab.filePath || '',
    resultPanelVisible: tab.resultPanelVisible === true,
    readOnly: tab.readOnly === true,
  };
};

const buildActiveSqlTabSnapshot = (params: {
  tabs?: TabData[];
  activeTabId?: string | null;
  connections: SavedConnection[];
  includeSqlPreview?: boolean;
  translate?: Translate;
}) => {
  const { tabs = [], activeTabId = null, connections, includeSqlPreview = true, translate } = params;
  const activeTab = tabs.find((tab) => tab.id === activeTabId);
  if (!activeTab) {
    return {
      hasActiveTab: false,
      hasSql: false,
      message: translateOrFallback(translate, 'ai_chat.inspection.sql_editor_transaction.no_active_tab', undefined, 'No active tab is currently selected'),
    };
  }
  if (activeTab.type !== 'query') {
    return {
      hasActiveTab: true,
      hasSql: false,
      message: translateOrFallback(translate, 'ai_chat.inspection.sql_editor_transaction.not_sql_tab', undefined, 'The current active tab is not a SQL editor tab'),
      tab: buildTabSummary(activeTab, connections),
    };
  }

  const sql = String(activeTab.query || '').trim();
  const connection = connections.find((item) => item.id === activeTab.connectionId);
  const dbType = resolveSqlDialect(
    String(connection?.config?.type || ''),
    String(connection?.config?.driver || ''),
    { oceanBaseProtocol: connection?.config?.oceanBaseProtocol },
  );
  const statements = splitStatements(sql, dbType);
  const hasExplicitTransactionControl = statements.some(isSqlEditorTransactionControlStatement);
  const usesManagedTransaction = shouldUseSqlEditorManagedTransactionForType(
    dbType,
    statements,
    connection?.config,
  );

  return {
    hasActiveTab: true,
    hasSql: sql.length > 0,
    tab: buildTabSummary(activeTab, connections),
    sqlPreview: includeSqlPreview ? sql.slice(0, SQL_PREVIEW_LIMIT) : '',
    sqlCharCount: sql.length,
    sqlTruncated: includeSqlPreview && sql.length > SQL_PREVIEW_LIMIT,
    statementCount: statements.length,
    hasExplicitTransactionControl,
    usesManagedTransaction,
    transactionSemantics: usesManagedTransaction
      ? translateOrFallback(translate, 'ai_chat.inspection.sql_editor_transaction.semantics.managed_dml', undefined, 'When the SQL editor runs INSERT/UPDATE/DELETE/MERGE/REPLACE DML, it first enters a managed transaction. The commit setting only decides when COMMIT happens after successful execution.')
      : hasExplicitTransactionControl
        ? translateOrFallback(translate, 'ai_chat.inspection.sql_editor_transaction.semantics.explicit_transaction', undefined, 'Explicit transaction control statements were detected, so GoNavi will not wrap another SQL editor managed transaction around them.')
        : translateOrFallback(translate, 'ai_chat.inspection.sql_editor_transaction.semantics.no_managed_transaction', undefined, 'The current SQL does not trigger a SQL editor managed transaction. Read-only queries still use the normal query path.'),
  };
};

const buildPendingTransactionPreview = (params: {
  item: AISqlEditorPendingTransactionRuntimeState;
  tabs?: TabData[];
  connections: SavedConnection[];
  now: number;
}) => {
  const { item, tabs = [], connections, now } = params;
  const tab = tabs.find((candidate) => candidate.id === item.tabId);
  const commitMode = normalizeCommitMode(item.commitMode);
  const dueAt = Number(item.autoCommitDueAt || 0);
  const remainingMs = commitMode === 'auto' && dueAt > 0
    ? Math.max(0, dueAt - now)
    : null;

  return {
    id: item.id,
    tabId: item.tabId,
    tab: buildTabSummary(tab, connections),
    commitMode,
    autoCommitDelayMs: normalizeDelayMs(item.autoCommitDelayMs),
    createdAt: Number(item.createdAt) || 0,
    autoCommitDueAt: dueAt || null,
    autoCommitRemainingMs: remainingMs,
  };
};

const isRelevantSqlEditorTransactionLog = (log: SqlLog): boolean => {
  const sql = String(log.sql || '');
  const statements = splitStatements(sql);
  if (shouldUseSqlEditorManagedTransaction(statements)) return true;
  if (statements.some(isSqlEditorTransactionControlStatement)) return true;
  return /\b(transaction|commit|rollback)\b/i.test(sql)
    || LOG_TRANSACTION_KEYWORD_PATTERN.test(String(log.message || ''));
};

const buildRecentLogPreview = (log: SqlLog) => ({
  id: log.id,
  timestamp: log.timestamp,
  status: log.status,
  duration: log.duration,
  dbName: log.dbName || '',
  affectedRows: typeof log.affectedRows === 'number' ? log.affectedRows : null,
  sqlPreview: String(log.sql || '').trim().slice(0, 1000),
  message: log.message || '',
});

export const buildSqlEditorTransactionSnapshot = (params: {
  transactionState?: AISqlEditorTransactionRuntimeState;
  tabs?: TabData[];
  activeTabId?: string | null;
  connections: SavedConnection[];
  sqlLogs?: SqlLog[];
  includeSqlPreview?: boolean;
  now?: number;
  translate?: Translate;
}) => {
  const {
    transactionState,
    tabs = [],
    activeTabId = null,
    connections,
    sqlLogs = [],
    includeSqlPreview = true,
    now = Date.now(),
    translate,
  } = params;
  const commitMode = normalizeCommitMode(transactionState?.commitMode);
  const autoCommitDelayMs = normalizeDelayMs(transactionState?.autoCommitDelayMs);
  const pendingTransactions = Object.values(transactionState?.pendingTransactions || {})
    .map((item) => buildPendingTransactionPreview({ item, tabs, connections, now }))
    .sort((left, right) => right.createdAt - left.createdAt);
  const activePendingTransaction = pendingTransactions.find((item) => item.tabId === activeTabId) || null;
  const activeSqlTab = buildActiveSqlTabSnapshot({
    tabs,
    activeTabId,
    connections,
    includeSqlPreview,
    translate,
  });
  const activeUsesManagedTransaction = activeSqlTab.hasActiveTab
    && activeSqlTab.hasSql
    && 'usesManagedTransaction' in activeSqlTab
    && activeSqlTab.usesManagedTransaction === true;
  const activeHasExplicitTransactionControl = activeSqlTab.hasActiveTab
    && activeSqlTab.hasSql
    && 'hasExplicitTransactionControl' in activeSqlTab
    && activeSqlTab.hasExplicitTransactionControl === true;
  const recentRelevantLogs = sqlLogs
    .filter(isRelevantSqlEditorTransactionLog)
    .slice(0, 8)
    .map(buildRecentLogPreview);

  const warnings: string[] = [];
  if (pendingTransactions.length > 0) {
    warnings.push(translateOrFallback(
      translate,
      'ai_chat.inspection.sql_editor_transaction.warning.pending_transactions',
      { count: pendingTransactions.length },
      `There are ${pendingTransactions.length} SQL editor managed transactions pending commit or rollback`,
    ));
  }
  if (activePendingTransaction) {
    warnings.push(translateOrFallback(translate, 'ai_chat.inspection.sql_editor_transaction.warning.active_pending_transaction', undefined, 'The active SQL tab already has a pending transaction. Commit or roll it back before running another DML statement.'));
  }
  if (activeUsesManagedTransaction && commitMode === 'auto') {
    warnings.push(translateOrFallback(translate, 'ai_chat.inspection.sql_editor_transaction.warning.auto_commit_managed_dml', undefined, 'Auto commit is enabled, but DML still enters a managed transaction and only runs COMMIT after the delay expires.'));
  }
  if (activeHasExplicitTransactionControl) {
    warnings.push(translateOrFallback(translate, 'ai_chat.inspection.sql_editor_transaction.warning.explicit_transaction_control', undefined, 'The current SQL already contains explicit transaction control, so the SQL editor will not take over commit or rollback.'));
  }

  const nextActions: string[] = [];
  if (activePendingTransaction) {
    nextActions.push(translateOrFallback(translate, 'ai_chat.inspection.sql_editor_transaction.next_action.resolve_active_pending', undefined, 'Ask the user to click "Commit" or "Rollback" in the result transaction bar, or wait for the auto-commit countdown to finish.'));
  } else if (pendingTransactions.length > 0) {
    nextActions.push(translateOrFallback(translate, 'ai_chat.inspection.sql_editor_transaction.next_action.switch_to_pending_tab', undefined, 'Before continuing with DML, switch back to the matching SQL tab and resolve the pending transaction.'));
  }
  if (activeUsesManagedTransaction) {
    nextActions.push(commitMode === 'auto'
      ? translateOrFallback(
        translate,
        'ai_chat.inspection.sql_editor_transaction.next_action.explain_auto_commit',
        { seconds: Math.round(autoCommitDelayMs / 1000) },
        `Explain that the current DML opens a managed transaction first and auto-commits about ${Math.round(autoCommitDelayMs / 1000)} seconds after successful execution.`,
      )
      : translateOrFallback(translate, 'ai_chat.inspection.sql_editor_transaction.next_action.explain_manual_commit', undefined, 'Explain that the current DML opens a managed transaction first and requires a manual Commit or Rollback after successful execution.'));
  }
  if (!activeSqlTab.hasActiveTab || !activeSqlTab.hasSql) {
    nextActions.push(translateOrFallback(translate, 'ai_chat.inspection.sql_editor_transaction.next_action.switch_to_sql_tab', undefined, 'Switch to a query tab with a SQL draft first, or ask the user to paste the SQL they want to run.'));
  }
  if (recentRelevantLogs.length > 0) {
    nextActions.push(translateOrFallback(translate, 'ai_chat.inspection.sql_editor_transaction.next_action.inspect_recent_activity', undefined, 'Review recent write or transaction execution results in recentRelevantLogs, and call inspect_recent_sql_activity for deeper inspection if needed.'));
  }

  return {
    commitPolicy: {
      commitMode,
      autoCommitDelayMs,
      transactionAlwaysOnForDML: true,
      semantics: translateOrFallback(translate, 'ai_chat.inspection.sql_editor_transaction.commit_policy.semantics', undefined, 'SQL editor runs INSERT/UPDATE/DELETE/MERGE/REPLACE DML inside a managed transaction. Manual or auto mode only controls when COMMIT happens after successful execution, not whether a transaction is opened.'),
    },
    activeSqlTab,
    pendingTransactionCount: pendingTransactions.length,
    activePendingTransaction,
    pendingTransactions,
    recentRelevantLogs,
    warnings,
    nextActions,
  };
};
