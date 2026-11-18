import React, { useCallback, useState } from 'react';
import { Segmented, Tag } from 'antd';

import { t as defaultTranslate } from '../i18n';
import { useOptionalI18n } from '../i18n/provider';
import { useStore } from '../store';
import type { DetachedQueryResultWindow } from '../utils/detachedWindow';
import QueryEditorStatementSummaryTable from './queryEditor/QueryEditorStatementSummaryTable';
import { isQueryEditorStatementSummary } from './queryEditor/run/queryEditorRunStatementSummary';

const DataGrid = React.lazy(() => import('./DataGrid'));

const isAffectedRowsResult = (columns: string[]): boolean => (
  columns.length === 1 && columns[0] === 'affectedRows'
);

const NativeDetachedQueryResult: React.FC<{
  windowState: DetachedQueryResultWindow;
  onStateChange: (patch: Partial<DetachedQueryResultWindow['result']>) => void;
}> = ({ windowState, onStateChange }) => {
  const result = windowState.result;
  const i18n = useOptionalI18n();
  const t = i18n?.t ?? defaultTranslate;
  const themeMode = useStore((state) => state.theme);
  const [elasticsearchViewMode, setElasticsearchViewMode] = useState<'table' | 'raw'>('table');
  const updateRows = useCallback((rows: Array<Record<string, unknown>>) => {
    onStateChange({ rows });
  }, [onStateChange]);
  const isDark = themeMode === 'dark';
  const sharedGridProps = {
    appliedFilterConditions: result.filterConditions,
    onApplyFilter: (filterConditions: NonNullable<typeof result.filterConditions>) => onStateChange({ filterConditions }),
    quickWhereCondition: result.quickWhereCondition,
    onApplyQuickWhereCondition: (quickWhereCondition: string) => onStateChange({ quickWhereCondition }),
    scrollSnapshot: result.scrollSnapshot,
    onScrollSnapshotChange: (scrollSnapshot: { top: number; left: number }) => onStateChange({ scrollSnapshot }),
    sessionState: {
      selectedRowKeys: result.selectedRowKeys,
      onSelectedRowKeysChange: (selectedRowKeys: React.Key[]) => onStateChange({ selectedRowKeys }),
      selectedCellKeys: result.selectedCellKeys,
      onSelectedCellKeysChange: (selectedCellKeys: string[]) => onStateChange({ selectedCellKeys }),
    },
  };

  if (result.resultType === 'elasticsearch') {
    const hasTable = Array.isArray(result.rows) && result.rows.length > 0 && (result.columns || []).length > 0;
    const viewMode = hasTable ? elasticsearchViewMode : 'raw';
    const status = Number(result.httpStatus || 0);
    const statusColor = status >= 200 && status < 300
      ? (result.partialFailure ? 'orange' : 'green')
      : 'red';
    return (
      <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%' }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', flex: '0 0 auto',
          borderBottom: isDark ? '1px solid rgba(255,255,255,0.1)' : '1px solid rgba(0,0,0,0.08)',
        }}>
          <span style={{ fontFamily: 'var(--gn-font-mono)', fontWeight: 600 }}>{result.requestLabel || result.sql}</span>
          {status > 0 ? <Tag color={statusColor}>HTTP {status}</Tag> : null}
          {result.partialFailure ? <Tag color="orange">{t('query_editor.elasticsearch.partial')}</Tag> : null}
          {result.outcomeUnknown ? <Tag color="red">{t('query_editor.elasticsearch.outcome_unknown')}</Tag> : null}
          <span style={{ flex: 1 }} />
          {hasTable ? (
            <Segmented
              size="small"
              value={viewMode}
              options={[
                { label: t('query_editor.elasticsearch.table'), value: 'table' },
                { label: t('query_editor.elasticsearch.raw'), value: 'raw' },
              ]}
              onChange={(value) => setElasticsearchViewMode(value as 'table' | 'raw')}
            />
          ) : null}
        </div>
        {viewMode === 'raw' ? (
          <textarea
            aria-label={t('query_editor.elasticsearch.raw_response')}
            readOnly
            spellCheck={false}
            value={String(result.rawResponse || '')}
            style={{
              flex: 1, minHeight: 0, margin: 12, padding: 12, resize: 'none', overflow: 'auto',
              borderRadius: 6, fontFamily: 'var(--gn-font-mono)', whiteSpace: 'pre',
              color: isDark ? '#d4d4d4' : '#333',
              background: isDark ? 'rgba(0,0,0,0.18)' : 'rgba(0,0,0,0.018)',
              border: isDark ? '1px solid rgba(255,255,255,0.14)' : '1px solid rgba(0,0,0,0.10)',
            }}
          />
        ) : (
          <DataGrid
            data={result.rows || []}
            columnNames={result.columns || []}
            loading={false}
            pkColumns={[]}
            readOnly
            connectionId={result.executionConnectionId || windowState.connectionId}
            connectionParamsOverride={result.executionConnectionParams}
            dbName={result.metadataDbName ?? result.executionDbName ?? windowState.dbName ?? ''}
            resultSql={result.sql}
            exportScope="queryResult"
            isActive
            {...sharedGridProps}
          />
        )}
      </div>
    );
  }

  if (isQueryEditorStatementSummary(result) && result.summaryEntries && result.summaryEntries.length > 0) {
    return (
      <div style={{ flex: 1, minHeight: 0, display: 'flex', padding: 12, overflow: 'hidden' }}>
        <QueryEditorStatementSummaryTable
          title={t('query_editor.results_panel.summary.title')}
          entries={result.summaryEntries}
          darkMode={isDark}
          fallbackText={(result.messages || []).join('\n')}
        />
      </div>
    );
  }

  const isMessage = result.resultType === 'message' || isAffectedRowsResult(result.columns || []);
  const messageText = (result.messages || []).join('\n')
    || (isAffectedRowsResult(result.columns || []) ? String(result.rows?.[0]?.affectedRows ?? '') : '');
  if (isMessage) return <textarea className="gn-native-detached-message" readOnly value={messageText} />;

  return (
    <DataGrid
      data={result.rows || []}
      columnNames={result.columns || []}
      loading={false}
      tableName={result.tableName}
      pkColumns={result.pkColumns || []}
      editLocator={result.editLocator as any}
      readOnly={result.readOnly !== false}
      connectionId={result.executionConnectionId || windowState.connectionId}
      connectionParamsOverride={result.executionConnectionParams}
      dbName={result.metadataDbName ?? result.executionDbName ?? windowState.dbName ?? ''}
      ddlDbName={result.ddlDbName}
      ddlTableName={result.ddlTableName}
      resultSql={result.exportSql || result.sql}
      exportScope="queryResult"
      showRowNumberColumn={result.showRowNumberColumn}
      onDataChange={updateRows}
      isActive
      {...sharedGridProps}
    />
  );
};

export default NativeDetachedQueryResult;
