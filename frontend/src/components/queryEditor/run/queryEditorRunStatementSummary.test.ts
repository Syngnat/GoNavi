import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { setCurrentLanguage } from '../../../i18n';
import { loadAllCatalogs } from '../../../i18n/catalog';
import type { QueryEditorResultSet } from '../../QueryEditorResultsPanel';
import {
    aggregateQueryEditorStatementResults,
    buildQueryEditorStatementSummaryEntriesFromExecutionResults,
    buildQueryEditorStatementSummaryFailureEntries,
    buildQueryEditorStatementSummaryCopyText,
    collectQueryEditorStatementSummaryEntries,
    countQueryEditorAffectedRowResults,
    isQueryEditorRowCountMeaninglessStatement,
    isQueryEditorStatementSummary,
} from './queryEditorRunStatementSummary';

const affectedResult = (statementIndex: number, affectedRows: number, key = `result-${statementIndex}`): QueryEditorResultSet => ({
    key,
    sql: `dml ${statementIndex}`,
    sourceStatementIndex: statementIndex,
    rows: [{ affectedRows }],
    columns: ['affectedRows'],
    pkColumns: [],
    readOnly: true,
});

const gridResult = (statementIndex: number, key = `grid-${statementIndex}`): QueryEditorResultSet => ({
    key,
    sql: 'select 1',
    sourceStatementIndex: statementIndex,
    rows: [{ value: 1 }],
    columns: ['value'],
    pkColumns: [],
    readOnly: true,
});

const buildEntries = (
    resultSets: QueryEditorResultSet[],
    statements: string[],
    dbType = 'mysql',
) => collectQueryEditorStatementSummaryEntries({
    resultSets,
    statementAt: (statementIndex) => statements[statementIndex - 1] || '',
    dbType,
});

describe('queryEditorRunStatementSummary', () => {
    beforeEach(async () => {
        await loadAllCatalogs();
        setCurrentLanguage('zh-CN');
    });

    afterEach(() => {
        setCurrentLanguage('zh-CN');
    });

    it('treats DDL and TRUNCATE as statements without row-count semantics', () => {
        expect(isQueryEditorRowCountMeaninglessStatement('CREATE TABLE t (id int)')).toBe(true);
        expect(isQueryEditorRowCountMeaninglessStatement('ALTER TABLE t ADD COLUMN c int')).toBe(true);
        expect(isQueryEditorRowCountMeaninglessStatement('DROP INDEX idx ON t')).toBe(true);
        expect(isQueryEditorRowCountMeaninglessStatement('TRUNCATE TABLE t')).toBe(true);
        expect(isQueryEditorRowCountMeaninglessStatement('UPDATE t SET c = 1')).toBe(false);
        expect(isQueryEditorRowCountMeaninglessStatement('DELETE FROM t WHERE id = 1')).toBe(false);
    });

    it('keeps affected rows only for DML entries', () => {
        const statements = ['CREATE TABLE t (id int)', 'UPDATE t SET id = 1'];
        const entries = buildEntries([affectedResult(1, 0), affectedResult(2, 3)], statements);
        expect(entries).toEqual([
            {
                statementIndex: 1,
                statement: statements[0],
                status: 'success',
                rowCountMeaningless: true,
            },
            {
                statementIndex: 2,
                statement: statements[1],
                status: 'success',
                affectedRows: 3,
                rowCountMeaningless: false,
            },
        ]);
    });

    it('keeps structured per-statement execution statuses', () => {
        const statements = ['UPDATE t SET c = 1', 'UPDATE t SET c = 2', 'UPDATE t SET c = 3'];
        const entries = buildQueryEditorStatementSummaryEntriesFromExecutionResults({
            results: [
                { statementIndex: 1, status: 'success', affectedRows: 2 },
                { statementIndex: 2, status: 'failed', error: 'duplicate key' },
                { statementIndex: 3, status: 'skipped' },
            ],
            statementAt: (statementIndex) => statements[statementIndex - 1] || '',
            dbType: 'mysql',
        });

        expect(entries.map((entry) => entry.status)).toEqual(['success', 'failed', 'skipped']);
        expect(entries[0].affectedRows).toBe(2);
        expect(entries[1].error).toBe('duplicate key');
    });

    it('copies every statement with status and error text', () => {
        const copyText = buildQueryEditorStatementSummaryCopyText([
            {
                statementIndex: 1,
                statement: 'UPDATE t SET c = 1',
                status: 'success',
                affectedRows: 2,
                rowCountMeaningless: false,
            },
            {
                statementIndex: 2,
                statement: 'UPDATE t SET c = 2',
                status: 'failed',
                rowCountMeaningless: false,
                error: 'duplicate key',
            },
        ]);

        expect(copyText).toContain('✓ 1. UPDATE t SET c = 1');
        expect(copyText).toContain('影响行数：2');
        expect(copyText).toContain('✗ 2. UPDATE t SET c = 2');
        expect(copyText).toContain('[失败]');
        expect(copyText).toContain('duplicate key');
    });

    it('builds a reliable fallback summary when a later statement fails', () => {
        const statements = ['UPDATE t SET c = 1', 'UPDATE t SET c = 2', 'UPDATE t SET c = 3'];
        const entries = buildQueryEditorStatementSummaryFailureEntries({
            sourceStatements: statements,
            executedCount: 1,
            failedIndex: 2,
            errorText: 'duplicate key',
            outcomeUnknown: false,
            dbType: 'mysql',
        });

        expect(entries.map((entry) => entry.status)).toEqual(['success', 'failed', 'skipped']);
        expect(entries[1].error).toBe('duplicate key');
    });

    it('does not guess per-statement status when the failed index is out of range', () => {
        expect(buildQueryEditorStatementSummaryFailureEntries({
            sourceStatements: ['UPDATE t SET c = 1', 'UPDATE t SET c = 2'],
            executedCount: 1,
            failedIndex: 0,
            errorText: 'failed',
            outcomeUnknown: false,
            dbType: 'mysql',
        })).toEqual([]);
    });

    it('marks every statement unknown when a batch outcome is unknown without an index', () => {
        const entries = buildQueryEditorStatementSummaryFailureEntries({
            sourceStatements: ['UPDATE t SET c = 1', 'UPDATE t SET c = 2'],
            executedCount: 0,
            failedIndex: 0,
            errorText: 'connection closed',
            outcomeUnknown: true,
            dbType: 'mysql',
        });
        expect(entries.map((entry) => entry.status)).toEqual(['unknown', 'unknown']);
    });

    it('merges hundreds of DDL results into one summary result set', () => {
        const statements = Array.from({ length: 342 }, (_, index) => `ALTER TABLE t_${index} ADD COLUMN c int`);
        const resultSets = statements.map((_, index) => affectedResult(index + 1, 0));
        const entries = buildEntries(resultSets, statements);
        const next = aggregateQueryEditorStatementResults({
            resultSets,
            entries,
            affectedResultCount: countQueryEditorAffectedRowResults(resultSets),
            exportSql: statements.join(';\n'),
            executionDbName: 'main',
        });

        expect(next).toHaveLength(1);
        expect(isQueryEditorStatementSummary(next[0])).toBe(true);
        expect(next[0].summaryStatementCount).toBe(342);
        expect(next[0].summaryEntries).toHaveLength(342);
        expect(next[0].summaryEntries?.every((entry) => entry.status === 'success')).toBe(true);
        expect(next[0].messages?.[0]).toBe('342 条语句执行成功：');
        expect(next[0].messages?.some((line) => line.includes('影响行数：0'))).toBe(false);
        expect(next[0].messages?.[next[0].messages!.length - 1]).toContain('结构变更已直接生效');
    });

    it('keeps real result sets next to the aggregated summary', () => {
        const statements = ['ALTER TABLE t ADD COLUMN c int', 'SELECT 1', 'UPDATE t SET c = 2'];
        const resultSets = [affectedResult(1, 0, 'result-1'), gridResult(2, 'result-2'), affectedResult(3, 1, 'result-3')];
        const next = aggregateQueryEditorStatementResults({
            resultSets,
            entries: buildEntries(resultSets, statements),
            affectedResultCount: countQueryEditorAffectedRowResults(resultSets),
            exportSql: statements.join(';\n'),
            executionDbName: 'main',
        });

        expect(next.map((result) => result.key)).toEqual(['result-1', 'result-2']);
        expect(isQueryEditorStatementSummary(next[0])).toBe(true);
        expect(next[1].columns).toEqual(['value']);
    });

    it('leaves a single DML result untouched so its row count stays visible', () => {
        const resultSets = [affectedResult(1, 7)];
        const next = aggregateQueryEditorStatementResults({
            resultSets,
            entries: buildEntries(resultSets, ['UPDATE t SET c = 1']),
            affectedResultCount: countQueryEditorAffectedRowResults(resultSets),
            exportSql: 'UPDATE t SET c = 1',
            executionDbName: 'main',
        });

        expect(next).toBe(resultSets);
        expect(next[0].columns).toEqual(['affectedRows']);
    });

    it('does not aggregate when a statement already returned concrete rows', () => {
        const statements = ['EXEC p_select', 'UPDATE t SET c = 1'];
        const resultSets = [gridResult(1, 'result-1'), affectedResult(2, 1, 'result-2')];
        const next = aggregateQueryEditorStatementResults({
            resultSets,
            entries: buildEntries(resultSets, statements, 'sqlserver'),
            affectedResultCount: countQueryEditorAffectedRowResults(resultSets),
            exportSql: statements.join(';\n'),
            executionDbName: 'main',
        });

        expect(next).toBe(resultSets);
    });

    it('deduplicates repeated affected results for one expanded statement', () => {
        const entries = buildEntries(
            [affectedResult(1, 2), affectedResult(1, 3)],
            ['BEGIN DELETE FROM t; END;'],
        );
        expect(entries).toHaveLength(1);
        expect(entries[0].affectedRows).toBe(5);
    });

    it('keeps identical statements at different indexes as separate rows', () => {
        const statements = ['UPDATE t SET c = 1', 'UPDATE t SET c = 1'];
        const entries = buildEntries(
            [affectedResult(1, 2), affectedResult(2, 3)],
            statements,
        );
        expect(entries).toHaveLength(2);
        expect(entries.map((entry) => entry.affectedRows)).toEqual([2, 3]);
    });
});
