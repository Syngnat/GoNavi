import ResultDiffWizard from '../resultDiff/ResultDiffWizard';
import type { ResultDiffComparableResult } from '../../utils/resultDiff/types';
import { t as translate } from '../../i18n';
import { buildRpcConnectionConfig } from '../../utils/connectionRpcConfig';
import ResultDiffPanel from '../resultDiff/ResultDiffPanel';
import ViewDataVerifyWizard from '../resultDiff/ViewDataVerifyWizard';
import { resolveViewNameForVerify } from '../../utils/resultDiff/viewDataVerify';
import type { QueryEditorCoreStateApi } from './hooks/useQueryEditorCoreState';
import type { QueryEditorConnectionContextApi } from './hooks/useQueryEditorConnectionContext';
import type { QueryEditorProps } from '../QueryEditor';

export interface QueryEditorResultDiffViewsProps {
  resultDiffWizardOpen: QueryEditorCoreStateApi['resultDiffWizardOpen'];
  resultSets: QueryEditorCoreStateApi['resultSets'];
  currentConnectionId: QueryEditorCoreStateApi['currentConnectionId'];
  currentDb: QueryEditorCoreStateApi['currentDb'];
  resultDiffAnchorKey: QueryEditorCoreStateApi['resultDiffAnchorKey'];
  connections: QueryEditorConnectionContextApi['connections'];
  setResultDiffWizardOpen: QueryEditorCoreStateApi['setResultDiffWizardOpen'];
  setResultDiffSession: QueryEditorCoreStateApi['setResultDiffSession'];
  resultDiffSession: QueryEditorCoreStateApi['resultDiffSession'];
  darkMode: QueryEditorConnectionContextApi['darkMode'];
  viewDataVerifyOpen: QueryEditorCoreStateApi['viewDataVerifyOpen'];
  query: QueryEditorCoreStateApi['query'];
  tab: QueryEditorProps['tab'];
  setViewDataVerifyOpen: QueryEditorCoreStateApi['setViewDataVerifyOpen'];
}

export const QueryEditorResultDiffViews = ({
  resultDiffWizardOpen, resultSets, currentConnectionId, currentDb, resultDiffAnchorKey,
  connections, setResultDiffWizardOpen, setResultDiffSession, resultDiffSession, darkMode,
  viewDataVerifyOpen, query, tab, setViewDataVerifyOpen,
}: QueryEditorResultDiffViewsProps) => (
  <>
    <ResultDiffWizard
      open={resultDiffWizardOpen}
      results={resultSets
        .map((rs, idx) => ({ rs, idx }))
        .filter(({ rs }) => rs.resultType !== 'message' && Array.isArray(rs.columns) && rs.columns.length > 0)
        .map(({ rs, idx }): ResultDiffComparableResult => ({
          key: rs.key,
          label: translate('query_editor.results_panel.tab.result', { index: idx + 1 }) + ` (${rs.rows?.length ?? 0})`,
          sql: String(rs.sql || rs.exportSql || ''),
          columns: rs.columns || [],
          rows: (rs.rows || []) as Record<string, unknown>[],
          pkColumns: rs.pkColumns || [],
          truncated: Boolean(rs.truncated),
          executionConnectionId: rs.executionConnectionId || currentConnectionId,
          executionDbName: rs.executionDbName ?? currentDb,
          executionConnectionParams: rs.executionConnectionParams,
          metadataDbName: rs.metadataDbName ?? rs.executionDbName ?? currentDb,
          metadataTableName: rs.metadataTableName || rs.tableName,
        }))}
      initialRightKey={resultDiffAnchorKey}
      connectionConfig={(() => {
        const conn = connections.find((c) => c.id === currentConnectionId);
        return conn ? buildRpcConnectionConfig(conn.config) : {};
      })()}
      database={currentDb}
      resolveExecutionConnectionConfig={(result) => {
        const connectionId = result.executionConnectionId || currentConnectionId;
        const conn = connections.find((item) => item.id === connectionId);
        if (!conn) return {};
        const config = result.executionConnectionParams === undefined
          ? conn.config
          : {
              ...conn.config,
              connectionParams: result.executionConnectionParams,
            };
        return buildRpcConnectionConfig(config);
      }}
      onCancel={() => setResultDiffWizardOpen(false)}
      onCompleted={(payload) => {
        setResultDiffWizardOpen(false);
        setResultDiffSession(payload);
      }}
    />

    {resultDiffSession && (
      <ResultDiffPanel
        open={Boolean(resultDiffSession)}
        jobId={resultDiffSession.jobId}
        summary={resultDiffSession.summary}
        leftLabel={resultDiffSession.leftLabel}
        rightLabel={resultDiffSession.rightLabel}
        darkMode={darkMode}
        columnMeta={resultDiffSession.columnMeta}
        onClose={() => setResultDiffSession(null)}
      />
    )}

    <ViewDataVerifyWizard
      open={viewDataVerifyOpen}
      connectionConfig={(() => {
        const conn = connections.find((c) => c.id === currentConnectionId);
        return conn ? buildRpcConnectionConfig(conn) : {};
      })()}
      database={currentDb}
      dbType={String(connections.find((c) => c.id === currentConnectionId)?.config?.type || '')}
      viewName={resolveViewNameForVerify({
        sql: query,
        tabViewName: tab.viewName,
        tabTitle: tab.title,
      })}
      ddlSql={query}
      onCancel={() => setViewDataVerifyOpen(false)}
      onCompleted={(payload) => {
        setViewDataVerifyOpen(false);
        setResultDiffSession(payload);
      }}
    />
  </>
);
