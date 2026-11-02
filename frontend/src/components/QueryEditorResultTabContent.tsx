import React from 'react';
import { Button, Segmented, Tag, message } from 'antd';
import { CopyOutlined, EyeInvisibleOutlined } from '@ant-design/icons';

import { filterColumnNamesByGlobalHiddenColumns } from '../utils/globalHiddenColumns';
import { buildQueryResultColumnPinScope } from '../utils/queryResultColumnPinScope';
import { t as defaultTranslate } from '../i18n';
import { useOptionalI18n } from '../i18n/provider';
import DataGrid from './DataGrid';
import {
    isQueryEditorRowCountMeaninglessStatement, isQueryEditorStatementSummary,
} from './queryEditor/run/queryEditorRunStatementSummary';
// Type-only import: erased at compile time, so this never becomes a runtime
// module cycle between the panel and its per-result content.
import type { QueryEditorResultSet } from './QueryEditorResultsPanel';

/** Stable empty list so `sortInfoExternal={rs.sortInfo || EMPTY_SORT_INFO}` stays memo-friendly. */
const EMPTY_SORT_INFO: never[] = [];

const messageTextareaKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== 'a') {
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.focus();
    event.currentTarget.select();
};

export type QueryEditorResultTabActions = {
    onHide: () => void;
    onResultPageChange: (key: string, page: number, pageSize: number) => void;
    onResultSort: (key: string, field: string, order: string) => void;
    onReloadResult: (
        key: string,
        sql: string,
        executionContext?: {
            executionConnectionId?: string;
            executionDbName?: string;
            executionConnectionParams?: string;
            statementResultIndex?: number;
        },
    ) => void;
    onRequestResultTotalCount?: (key: string) => void;
    onCancelResultTotalCount?: (key: string) => void;
};

export const resolveVisibleQueryResultColumns = (
    columns: string[],
    globalHiddenColumns: string[],
): string[] => {
    const visibleColumns = filterColumnNamesByGlobalHiddenColumns(columns, globalHiddenColumns);
    return visibleColumns.length > 0 || columns.length === 0 ? visibleColumns : columns;
};

export const isAffectedRowsResult = (result: Pick<QueryEditorResultSet, 'columns'>): boolean =>
    result.columns.length === 1 && result.columns[0] === 'affectedRows';

const QueryEditorResultTabContent: React.FC<{
    rs: QueryEditorResultSet;
    workbenchTabId?: string;
    /** True only while this result is the selected tab of the active editor. */
    isResultActive: boolean;
    darkMode: boolean;
    currentDb: string;
    currentConnectionId: string;
    maxRows?: number;
    globalHiddenColumns: string[];
    dataPreviewRequest?: { resultKey: string; requestId: string } | null;
    elasticsearchViewMode?: 'table' | 'raw';
    onElasticsearchViewModeChange?: (key: string, mode: 'table' | 'raw') => void;
    /**
     * Actions are read through a ref (not props) so every prop above stays
     * identity-stable. That is what lets React.memo skip untouched result grids
     * when the user switches between result tabs.
     */
    actionsRef: React.MutableRefObject<QueryEditorResultTabActions>;
}> = ({
    rs,
    workbenchTabId,
    isResultActive,
    darkMode,
    currentDb,
    currentConnectionId,
    maxRows,
    globalHiddenColumns,
    dataPreviewRequest,
    elasticsearchViewMode,
    onElasticsearchViewModeChange,
    actionsRef,
}) => {
    const i18n = useOptionalI18n();
    const t = i18n?.t ?? defaultTranslate;

    const handleCopyMessageText = async (text: string) => {
        const safeText = String(text || '');
        if (!safeText.trim()) return;
        try {
            if (typeof navigator?.clipboard?.writeText !== 'function') {
                throw new Error(t('query_editor.results_panel.message.copy_unsupported'));
            }
            await navigator.clipboard.writeText(safeText);
            message.success(t('data_grid.message.copied_to_clipboard'));
        } catch (error: any) {
            message.error(t('query_editor.results_panel.message.copy_failed', {
                detail: error?.message || t('common.unknown'),
            }));
        }
    };

    const renderMessageBlock = ({
        text,
        title,
        fontSize,
        fillHeight = false,
        compact = false,
        maxWidth,
        color,
        marginTop,
    }: {
        text: string;
        title?: string;
        fontSize: string;
        fillHeight?: boolean;
        compact?: boolean;
        maxWidth?: number;
        color: string;
        marginTop?: number;
    }) => (
        <div className={`query-result-message-block${compact ? ' is-compact' : ' is-full'}`} style={{
            display: 'flex', flexDirection: 'column', gap: compact ? 8 : 12, padding: compact ? 12 : 16,
            borderRadius: 8, border: darkMode ? '1px solid rgba(255,255,255,0.12)' : '1px solid rgba(0,0,0,0.08)',
            background: darkMode ? 'rgba(255,255,255,0.03)' : '#fff', textAlign: 'left', alignItems: 'stretch', marginTop,
            width: maxWidth ? `min(100%, ${maxWidth}px)` : '100%', flex: fillHeight ? 1 : undefined, minHeight: fillHeight ? 0 : undefined,
            boxSizing: 'border-box',
        }}>
            <div className="query-result-message-header" style={{
                display: 'flex', alignItems: 'center', justifyContent: title ? 'space-between' : 'flex-end', gap: 12,
                flex: '0 0 auto', minHeight: compact ? 28 : 32,
            }}>
                {title ? <span style={{ fontSize: 14, fontWeight: 600 }}>{title}</span> : <span />}
                <Button size="small" icon={<CopyOutlined />} onClick={() => { void handleCopyMessageText(text); }} disabled={!text.trim()}>
                    {t('query_editor.results_panel.message.action.copy')}
                </Button>
            </div>
            <div className="query-result-message-scroll-body" style={{
                flex: fillHeight ? 1 : '0 1 auto', display: 'flex', alignItems: 'stretch', width: '100%', minHeight: compact ? 72 : 0,
                maxHeight: compact ? 160 : undefined, overflow: 'hidden', minWidth: 0, borderRadius: 6,
                border: darkMode ? '1px solid rgba(255,255,255,0.14)' : '1px solid rgba(0,0,0,0.10)',
                background: darkMode ? 'rgba(0,0,0,0.18)' : 'rgba(0,0,0,0.018)',
            }}>
                <textarea
                    readOnly
                    wrap="off"
                    spellCheck={false}
                    aria-label={title || t('query_editor.results_panel.message.title')}
                    data-query-result-message-textarea={compact ? 'compact' : 'full'}
                    value={text}
                    onKeyDown={messageTextareaKeyDown}
                    style={{
                        display: 'block', flex: '1 1 auto', width: '100%', minWidth: 0, height: '100%', minHeight: compact ? 72 : 0,
                        padding: compact ? '8px 10px' : '10px 12px', margin: 0, border: 'none', resize: 'none', background: 'transparent',
                        color, fontFamily: 'var(--gn-font-mono)', fontSize, lineHeight: 1.6, whiteSpace: 'pre', outline: 'none', boxSizing: 'border-box', overflow: 'auto',
                    }}
                />
            </div>
        </div>
    );

    const renderHideAction = () => (
        <Button
            aria-label={t('query_editor.results_panel.aria.hide')}
            className="gn-v2-data-grid-toolbar-action gn-v2-query-result-toolbar-hide"
            icon={<EyeInvisibleOutlined />}
            onClick={() => actionsRef.current.onHide()}
        />
    );

    if (rs.resultType === 'message') {
        // 批量写语句的汇总结果：显示「执行摘要」，避免几百个结果标签
        const isStatementSummary = isQueryEditorStatementSummary(rs);
        return (
            <div className="gn-v2-query-success" style={{
                flex: 1, minHeight: 0, display: 'flex', justifyContent: 'flex-start', flexDirection: 'column', gap: 12,
                padding: 24, color: '#666', userSelect: 'text', alignItems: 'stretch', overflow: 'hidden',
            }}>
                {renderMessageBlock({
                    text: (rs.messages || []).join('\n'),
                    title: t(isStatementSummary
                        ? 'query_editor.results_panel.summary.title'
                        : 'query_editor.results_panel.message.title'),
                    fontSize: 'var(--gn-font-size-mono, 13px)',
                    fillHeight: true,
                    color: darkMode ? '#d4d4d4' : '#333',
                })}
            </div>
        );
    }

    if (rs.resultType === 'elasticsearch') {
        const hasTable = Array.isArray(rs.rows) && rs.rows.length > 0 && rs.columns.length > 0;
        const viewMode = hasTable ? (elasticsearchViewMode || 'table') : 'raw';
        const status = Number(rs.httpStatus || 0);
        const statusColor = status >= 200 && status < 300
            ? (rs.partialFailure ? 'orange' : 'green')
            : 'red';
        return (
            <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
                <div style={{
                    display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px',
                    borderBottom: darkMode ? '1px solid rgba(255,255,255,0.1)' : '1px solid rgba(0,0,0,0.08)',
                }}>
                    <span style={{ fontFamily: 'var(--gn-font-mono)', fontWeight: 600 }}>{rs.requestLabel || rs.sql}</span>
                    {status > 0 ? <Tag color={statusColor}>HTTP {status}</Tag> : null}
                    {rs.partialFailure ? <Tag color="orange">{t('query_editor.elasticsearch.partial')}</Tag> : null}
                    {rs.outcomeUnknown ? <Tag color="red">{t('query_editor.elasticsearch.outcome_unknown')}</Tag> : null}
                    <span style={{ flex: 1 }} />
                    {hasTable ? (
                        <Segmented
                            size="small"
                            value={viewMode}
                            options={[
                                { label: t('query_editor.elasticsearch.table'), value: 'table' },
                                { label: t('query_editor.elasticsearch.raw'), value: 'raw' },
                            ]}
                            onChange={(value) => onElasticsearchViewModeChange?.(rs.key, value as 'table' | 'raw')}
                        />
                    ) : null}
                    {isResultActive ? renderHideAction() : null}
                </div>
                {viewMode === 'raw' ? (
                    <div style={{ flex: 1, minHeight: 0, padding: 12, overflow: 'hidden' }}>
                        {renderMessageBlock({
                            text: String(rs.rawResponse || ''),
                            title: t('query_editor.elasticsearch.raw_response'),
                            fontSize: 'var(--gn-font-size-mono, 13px)',
                            fillHeight: true,
                            color: darkMode ? '#d4d4d4' : '#333',
                        })}
                    </div>
                ) : (
                    <DataGrid
                        workbenchTabId={workbenchTabId}
                        data={rs.rows}
                        columnNames={resolveVisibleQueryResultColumns(rs.columns, globalHiddenColumns)}
                        isActive={isResultActive}
                        loading={false}
                        columnPinScope={buildQueryResultColumnPinScope({ sql: rs.sql })}
                        exportScope="queryResult"
                        resultSql={rs.sql}
                        dbName={currentDb}
                        connectionId={currentConnectionId}
                        pkColumns={[]}
                        readOnly
                    />
                )}
            </div>
        );
    }

    if (isAffectedRowsResult(rs)) {
        const affected = Number(rs.rows[0]?.affectedRows ?? 0);
        // DDL / TRUNCATE 的受影响行数恒为 0，显示「影响行数：0」会被误读成语句没生效，
        // 改用结构变更说明（行数对这类语句没有语义）。
        const rowCountMeaningless = isQueryEditorRowCountMeaninglessStatement(rs.exportSql || rs.sql || '');
        const messageText = Array.isArray(rs.messages) ? rs.messages.join('\n') : '';
        return (
            <div className="gn-v2-query-success" style={{
                flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 8,
                color: '#666', userSelect: 'text',
            }}>
                <span style={{ fontSize: 36, color: '#52c41a' }}>✓</span>
                <span style={{ fontSize: 14, fontWeight: 500 }}>{t('query_editor.result.execution_success')}</span>
                <span style={{ fontSize: 13, color: '#999' }}>{rowCountMeaningless
                    ? t('query_editor.result.schema_change_applied')
                    : t('query_editor.result.affected_rows', { count: affected })}</span>
                {messageText
                    ? renderMessageBlock({ text: messageText, fontSize: 'var(--gn-font-size-mono, 12px)', compact: true, maxWidth: 720, color: darkMode ? '#d4d4d4' : '#666', marginTop: 8 })
                    : null}
            </div>
        );
    }

    const visibleColumns = resolveVisibleQueryResultColumns(rs.columns, globalHiddenColumns);
    const resultTableName = rs.tableName;
    return (
        <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            {Array.isArray(rs.messages) && rs.messages.length > 0 ? (
                <div style={{ flex: '0 0 auto', margin: '8px 8px 0' }}>
                    {renderMessageBlock({
                        text: rs.messages.join('\n'),
                        fontSize: 'var(--gn-font-size-mono, 12px)',
                        compact: true,
                        color: darkMode ? '#d4d4d4' : '#666',
                    })}
                </div>
            ) : null}
            <DataGrid
                workbenchTabId={workbenchTabId}
                data={rs.rows}
                columnNames={visibleColumns}
                isActive={isResultActive}
                loading={rs.page?.loading === true}
                tableName={resultTableName}
                columnPinScope={resultTableName ? undefined : buildQueryResultColumnPinScope({
                    sql: rs.exportSql || rs.sql,
                    sourceStatementIndex: rs.sourceStatementIndex,
                    statementResultIndex: rs.statementResultIndex,
                })}
                exportScope="queryResult"
                resultSql={rs.exportSql || rs.sql}
                resultExportAllSql={rs.page?.exportAllSql}
                dbName={rs.metadataDbName ?? rs.executionDbName ?? currentDb}
                ddlDbName={rs.ddlDbName}
                ddlTableName={rs.ddlTableName}
                connectionId={rs.executionConnectionId || currentConnectionId}
                connectionParamsOverride={rs.executionConnectionParams}
                queryMaxRows={rs.page ? maxRows : undefined}
                initialViewMode={dataPreviewRequest?.resultKey === rs.key ? 'table' : undefined}
                initialViewModeRequestId={dataPreviewRequest?.resultKey === rs.key ? dataPreviewRequest.requestId : undefined}
                initialViewModeScope={dataPreviewRequest?.resultKey === rs.key ? 'local' : undefined}
                pkColumns={rs.pkColumns}
                initialColumnMetaMap={rs.columnMetaMap}
                initialUniqueKeyGroups={rs.uniqueKeyGroups}
                editLocator={rs.editLocator}
                onReload={() => {
                    if (rs.page) {
                        return actionsRef.current.onResultPageChange(rs.key, rs.page.current, rs.page.pageSize);
                    }
                    // Reload must target the displayed result's own execution context: keys
                    // are positional and reused across runs, so resolving by key alone can
                    // pick up a different result (and the wrong transaction/database).
                    return actionsRef.current.onReloadResult(rs.key, rs.sql, {
                        executionConnectionId: rs.executionConnectionId,
                        executionDbName: rs.executionDbName,
                        executionConnectionParams: rs.executionConnectionParams,
                        statementResultIndex: rs.statementResultIndex,
                    });
                }}
                pagination={rs.page ? {
                    current: rs.page.current,
                    pageSize: rs.page.pageSize,
                    total: rs.page.total,
                    totalKnown: rs.page.totalKnown,
                    totalCountLoading: rs.page.totalCountLoading,
                    totalCountCancelled: rs.page.totalCountCancelled,
                } : undefined}
                onPageChange={rs.page ? ((page, size) => actionsRef.current.onResultPageChange(rs.key, page, size)) : undefined}
                onSort={(field, order) => actionsRef.current.onResultSort(rs.key, field, order)}
                sortInfoExternal={rs.sortInfo || EMPTY_SORT_INFO}
                onRequestTotalCount={rs.page && actionsRef.current.onRequestResultTotalCount
                    ? (() => actionsRef.current.onRequestResultTotalCount?.(rs.key))
                    : undefined}
                onCancelTotalCount={rs.page && actionsRef.current.onCancelResultTotalCount
                    ? (() => actionsRef.current.onCancelResultTotalCount?.(rs.key))
                    : undefined}
                readOnly={rs.readOnly}
                toolbarExtraActions={isResultActive ? renderHideAction() : null}
            />
        </div>
    );
};

QueryEditorResultTabContent.displayName = 'QueryEditorResultTabContent';

export default React.memo(QueryEditorResultTabContent);
