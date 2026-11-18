import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setCurrentLanguage } from '../../../i18n';
import { loadAllCatalogs } from '../../../i18n/catalog';
import type { QueryEditorResultSet } from '../../QueryEditorResultsPanel';
import type { SavedConnection } from '../../../typeDefs/connectionTypes';
import type { TabData } from '../../../types';
import { handleQueryEditorRunFailure } from './queryEditorRunFailure';

describe('handleQueryEditorRunFailure', () => {
    beforeEach(async () => {
        await loadAllCatalogs();
        setCurrentLanguage('zh-CN');
    });

    afterEach(() => {
        setCurrentLanguage('zh-CN');
    });

    it('shows a structured multi-statement summary before clearing unpinned results', async () => {
        const showRunFailureSummary = vi.fn();
        const clearUnpinnedResultSets = vi.fn(() => [] as QueryEditorResultSet[]);
        const setExecutionError = vi.fn();

        await handleQueryEditorRunFailure({
            oracleCompileFailureMessage: '',
            res: {
                success: false,
                message: 'duplicate key',
                executedCount: 1,
                failedIndex: 2,
                statementResults: [
                    { statementIndex: 1, status: 'success', affectedRows: 1 },
                    { statementIndex: 2, status: 'failed', error: 'duplicate key' },
                    { statementIndex: 3, status: 'skipped' },
                ],
            },
            tab: { id: 'tab-1', type: 'query' } as TabData,
            normalizedDbType: 'postgres',
            sourceStatements: [
                'UPDATE users SET active = 1',
                'UPDATE users SET active = 2',
                'UPDATE users SET active = 3',
            ],
            executionConfig: {},
            executionDbName: 'main',
            isCurrentRun: () => true,
            conn: { id: 'conn-1', config: {} } as SavedConnection,
            clearUnpinnedResultSets,
            currentQueryIdRef: { current: 'query-1' } as React.MutableRefObject<string>,
            queryId: 'query-1',
            clearQueryId: vi.fn(),
            updateResultPanelVisibility: vi.fn(),
            setExecutionError,
            showRunFailureSummary,
        });

        expect(showRunFailureSummary).toHaveBeenCalledOnce();
        const summary = showRunFailureSummary.mock.calls[0][0] as QueryEditorResultSet;
        expect(summary.summaryKind).toBe('statements');
        expect(summary.summaryStatementCount).toBe(3);
        expect(summary.summaryEntries?.map((entry) => entry.status)).toEqual([
            'success',
            'failed',
            'skipped',
        ]);
        expect(clearUnpinnedResultSets).not.toHaveBeenCalledWith('__gonavi_sql_execution_log__');
        expect(setExecutionError).toHaveBeenCalledWith(expect.stringContaining('duplicate key'));
    });
});
