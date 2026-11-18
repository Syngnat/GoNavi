import React from 'react';
import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { connection } from '../../../../wailsjs/go/models';
import { findSqlStatementRanges, stripLeadingSqlTrivia } from '../../../utils/sqlStatementSelection';
import { createIdleQueryEditorExecutionLifecycle } from '../queryEditorExecutionLifecycle';
import type { QueryEditorRunScope } from '../queryEditorRunHelpers';
import { useQueryEditorRun, type UseQueryEditorRunInput } from './useQueryEditorRun';

vi.mock('antd', async (importOriginal) => ({
    ...await importOriginal<typeof import('antd')>(),
    message: { info: vi.fn(), error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

vi.mock('../../QueryEditorResultsPanel', () => ({
    QUERY_EDITOR_SQL_LOG_TAB_KEY: '__gonavi_sql_execution_log__',
}));

vi.mock('../../../../wailsjs/go/app/App', async (importOriginal) => ({
    ...await importOriginal<typeof import('../../../../wailsjs/go/app/App')>(),
    GenerateQueryID: vi.fn(async () => 'context-regression-query'),
    DBGetColumns: vi.fn(async () => ({ success: true, data: [] })),
    DBGetIndexes: vi.fn(async () => ({ success: true, data: [] })),
}));

const SELECTED_DATABASE = 'mkefu_location_dev240';
const routine = `CREATE PROCEDURE inspect_months()
BEGIN
  SELECT table_name FROM information_schema.tables;
  SELECT index_name FROM information_schema.statistics;
END`;

function createParamsState(): UseQueryEditorRunInput['paramsState'] {
    return {
        analysis: null, analyzing: false, supported: true, hasParams: false, missingNames: [],
        values: {}, quotedPlaceholders: false,
        setValue: vi.fn(), applyValues: vi.fn(), applyAnalysis: vi.fn(), requestAnalysis: vi.fn(),
        setQuotedPlaceholders: vi.fn(), reanalyze: vi.fn(async () => null),
        analyzeNow: vi.fn(async () => null),
    };
}

function createRunInput(sql: string): UseQueryEditorRunInput {
    const savedConnection: NonNullable<UseQueryEditorRunInput['currentConnection']> = {
        id: 'dev240', name: 'Dev240', environmentType: 'development',
        config: { type: 'mysql', host: 'mock.invalid', port: 3306, user: 'test' },
    };
    const currentDbRef = { current: SELECTED_DATABASE };
    const currentQueryIdRef = { current: '' };
    return {
        tab: { id: 'query-context', title: 'Query', type: 'query', connectionId: savedConnection.id },
        isActive: true,
        isElasticsearchMode: false,
        handleElasticsearchRun: vi.fn(async () => undefined),
        canSelectQuerySchema: false,
        schemaLoading: false,
        getCurrentQuery: () => sql,
        getSelectedSQL: () => sql,
        getExecutableSQL: () => sql,
        clearUnpinnedResultSets: vi.fn(() => []),
        currentConnection: savedConnection,
        currentDbRef,
        currentSchemaRef: { current: '' },
        visibleDbsRef: { current: [SELECTED_DATABASE, 'information_schema', 'warehouse', 'archive'] },
        pendingSqlTransactionRef: { current: null },
        activatePendingSqlTransaction: vi.fn(),
        appendPendingSqlTransactionExecution: vi.fn(),
        queryContextLockRunSeqRef: { current: 0 },
        switchQueryContext: vi.fn((_connectionId, dbName) => {
            currentDbRef.current = dbName;
            return true;
        }),
        currentConnectionIdRef: { current: savedConnection.id },
        schemaContextKeyRef: { current: '' },
        latestSelectedSchemaRef: { current: '' },
        setCurrentSchema: vi.fn(),
        setSchemaList: vi.fn(),
        updateQueryTabDraft: vi.fn(),
        runSeqRef: { current: 0 },
        beginQueryEditorRunClock: vi.fn(),
        lockQueryContextForRun: vi.fn(),
        setLoading: vi.fn(),
        setExecutionError: vi.fn(),
        recordExecutionOrigin: vi.fn(),
        updateResultPanelVisibility: vi.fn(),
        rpcLostWithoutResultRef: { current: false },
        cancelResultTotalCountRequests: vi.fn(async () => undefined),
        resultTotalCountRequestsRef: { current: {} },
        currentQueryIdRef,
        clearQueryId: () => { currentQueryIdRef.current = ''; },
        connections: [savedConnection],
        currentConnectionId: savedConnection.id,
        buildSqlExecutionConnectionConfig: config => config,
        splitSQLStatements: (text, dialect) => findSqlStatementRanges(text, dialect).map(range => range.text),
        resultSets: [],
        setResultSets: vi.fn(),
        lastExecutedEditorQueryRef: { current: '' },
        normalizeExecutableStatementList: (statements, dialect) => statements.map(text => stripLeadingSqlTrivia(text, dialect)),
        queryOptions: {
            wordWrap: false, showColumnComment: false, showColumnType: false,
            alignNumericTemporalCellsRight: false, showQueryResultsPanel: true,
            showSqlExecutionLog: true, queryEditorEditorHeightRatio: 0.5,
        },
        setExecutionTimingActive: vi.fn(),
        setQueryId: id => { currentQueryIdRef.current = id; },
        invokeRequestScopedApp: (_method, _args, fallback) => fallback(),
        addSqlLog: vi.fn(),
        finishQueryEditorSqlClock: () => 1,
        mergeResultSets: (_previous, next) => next,
        activateExecutedResult: vi.fn(),
        metadataGenerationRef: { current: 0 },
        isQueryEditorMetadataRequestCurrent: () => true,
        tablesRef: { current: [] },
        containsOraclePlsqlDefinition: () => false,
        normalizeOracleSqlPlusSlashTerminators: text => text,
        paramsDialogState: { open: false, analysis: null },
        setParamsDialogState: vi.fn(),
        paramsState: createParamsState(),
        lastParamsRunScopeRef: { current: 'default' },
        executeSqlEditorMultiQuery: vi.fn(async () => new connection.QueryResult({ success: true, message: '', data: [] })),
        queryEditorUnmountedRef: { current: false },
        sqlEditorCommitMode: 'auto',
        sqlEditorAutoCommitDelayMs: 0,
        hasConcreteQueryResultSetData: () => false,
        isAffectedRowsResultSetData: () => false,
        executionLifecycleRef: { current: createIdleQueryEditorExecutionLifecycle() },
        unlockQueryContextForRun: vi.fn(),
        handleRunRef: { current: null },
        deferredContextRunSeqRef: { current: 0 },
        queryEditorActiveRef: { current: true },
        schemaLoadingRef: { current: false },
        pendingRunAfterSchemaLoadRef: { current: false },
        loading: false,
    };
}

function RunHarness({ input }: { input: UseQueryEditorRunInput }) {
    useQueryEditorRun(input);
    return null;
}

async function runSQL(sql: string, runScope: QueryEditorRunScope = 'all') {
    const input = createRunInput(sql);
    let renderer!: ReturnType<typeof create>;
    await act(async () => { renderer = create(<RunHarness input={input} />); });
    try {
        await act(async () => { await input.handleRunRef.current?.(runScope); });
        expect(input.executeSqlEditorMultiQuery).toHaveBeenCalledTimes(1);
        expect(input.setExecutionError).not.toHaveBeenCalledWith(expect.stringMatching(/\S/));
        return input;
    } finally {
        act(() => { renderer.unmount(); });
    }
}

describe('useQueryEditorRun execution context through the SQL execution path', () => {
    beforeEach(() => { vi.clearAllMocks(); });

    it.each([
        { name: 'unqualified procedure reading system catalogs', sql: routine },
        {
            name: 'qualified function with a definer and cross-database body',
            sql: "CREATE DEFINER = 'test'@'%' FUNCTION archive.count_orders() RETURNS INT READS SQL DATA\nRETURN (SELECT COUNT(*) FROM warehouse.orders)",
        },
        {
            name: 'DDL followed by a query against another database',
            sql: 'CREATE TABLE scratch (id INT);\nSELECT COUNT(*) FROM warehouse.orders',
        },
        {
            name: 'query followed by an explicit later USE',
            sql: 'SELECT COUNT(*) FROM warehouse.orders;\nUSE archive',
        },
    ])('retains the selected database for $name', async ({ sql }) => {
        const input = await runSQL(sql);
        const call = vi.mocked(input.executeSqlEditorMultiQuery).mock.calls[0];
        expect(call[1]).toBe(SELECTED_DATABASE);
        expect(call[2]).toBe(sql);
        expect(input.switchQueryContext).not.toHaveBeenCalled();
        expect(input.currentDbRef.current).toBe(SELECTED_DATABASE);
        expect(input.paramsState.analyzeNow).toHaveBeenCalledWith(sql, SELECTED_DATABASE);
    });

    it('keeps a leading USE authoritative over procedure body references', async () => {
        const sql = `USE archive;\n${routine}`;
        const input = await runSQL(sql);
        const call = vi.mocked(input.executeSqlEditorMultiQuery).mock.calls[0];
        expect(call[1]).toBe('archive');
        expect(call[2]).toBe(sql);
        expect(input.switchQueryContext).toHaveBeenCalledExactlyOnceWith('dev240', 'archive');
    });

    it.each(['default', 'selection'] as const)('protects the routine context for the %s run action', async (runScope) => {
        const input = await runSQL(routine, runScope);
        const call = vi.mocked(input.executeSqlEditorMultiQuery).mock.calls[0];
        expect(call[1]).toBe(SELECTED_DATABASE);
        expect(call[2]).toBe(routine);
        expect(call[4]).toEqual([routine]);
        expect(input.switchQueryContext).not.toHaveBeenCalled();
    });

    it('preserves automatic context selection for a single qualified SELECT', async () => {
        const sql = 'SELECT COUNT(*) FROM warehouse.orders';
        const input = await runSQL(sql);
        expect(input.switchQueryContext).toHaveBeenCalledExactlyOnceWith('dev240', 'warehouse');
        const call = vi.mocked(input.executeSqlEditorMultiQuery).mock.calls[0];
        expect(call[1]).toBe('warehouse');
        expect(call[2]).toBe(sql);
    });
});
