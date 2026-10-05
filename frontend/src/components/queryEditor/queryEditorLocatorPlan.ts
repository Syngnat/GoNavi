import type { ColumnDefinition, IndexDefinition } from '../../types';
import { DBGetColumns, DBGetIndexes } from '../../../wailsjs/go/app/App';
import { buildRpcConnectionConfig } from '../../utils/connectionRpcConfig';
import { isOracleLikeDialect } from '../../utils/sqlDialect';
import { extractQueryResultTableRef } from '../../utils/queryResultTable';
import {
    buildAllColumnsLocator,
    type EditRowLocator,
    ORACLE_ROWID_LOCATOR_COLUMN,
    DUCKDB_ROWID_LOCATOR_COLUMN,
} from '../../utils/rowLocator';
import {
    resolveSqlEditorOperationKeyword,
    hasTopLevelSqlEditorForUpdate,
} from '../../utils/sqlEditorTransaction';
import { getColumnDefinitionName, getColumnDefinitionKey } from '../../utils/columnDefinition';
import { buildIndexedColumnMetadata } from '../dataGridColumnTypeMarker';
import { t as translate } from '../../i18n';
import {
    type QueryStatementPlan,
    isSystemMetadataQueryResult,
    buildQueryReadOnlyLocator,
    withSoftTimeout,
} from './queryEditorResultMessages';
import { resolveOracleLikeExecutionSchemaName } from './queryEditorIdentifierPaths';
import {
    parseSimpleSelectInfo,
    rewriteOracleDuplicateSelectColumns,
    resolveMetadataColumnName,
    findWritableResultColumnForSource,
    buildQueryLocatorAlias,
    buildQueryLocatorColumnExpression,
    buildQueryRowIDExpression,
    buildDuckDBRowIDExpression,
    rewriteOracleSelectAllWithExpressions,
    appendQuerySelectExpressions,
} from './queryEditorSelectRewrite';

export const resolveQueryLocatorPlan = async ({
    statement,
    originalStatement,
    dbType,
    currentDb,
    config,
    forceReadOnly,
    allowOracleRowID = true,
}: {
    statement: string;
    originalStatement?: string;
    dbType: string;
    currentDb: string;
    config: any;
    forceReadOnly: boolean;
    allowOracleRowID?: boolean;
}): Promise<QueryStatementPlan> => {
    const plan: QueryStatementPlan = {
        originalSql: originalStatement || statement,
        executedSql: statement,
        pkColumns: [],
    };
    if (resolveSqlEditorOperationKeyword(statement, dbType) !== 'select') {
        return plan;
    }
    const defaultSchema = isOracleLikeDialect(dbType)
        ? resolveOracleLikeExecutionSchemaName(config, currentDb)
        : '';
    // 即使只读也要解析 tableRef：结果页列类型/注释依赖 metadataDbName + tableName
    try {
        const previewTableRef = extractQueryResultTableRef(statement, dbType, currentDb, defaultSchema);
        if (previewTableRef) {
            plan.tableRef = previewTableRef;
        }
    } catch {
        // ignore parse errors; keep bare plan
    }
    if (forceReadOnly) return plan;

    try {
        let tableRef = plan.tableRef || extractQueryResultTableRef(statement, dbType, currentDb, defaultSchema);
        if (!tableRef) return plan;
        plan.tableRef = tableRef;
        if (isSystemMetadataQueryResult(tableRef, dbType)) {
            plan.editLocator = buildQueryReadOnlyLocator(translate('query_editor.message.read_only_system_metadata'));
            return plan;
        }

        const selectInfo = parseSimpleSelectInfo(statement);
        if (!selectInfo) {
            // 聚合、函数和表达式结果天然无法安全回写到单行，静默保持只读即可。
            return plan;
        }
        if (!selectInfo.selectsAll && Object.keys(selectInfo.writableColumns).length === 0) {
            return plan;
        }

        if (isOracleLikeDialect(dbType) && defaultSchema && !String(tableRef.tableName || '').includes('.')) {
            tableRef = {
                ...tableRef,
                tableName: `${tableRef.metadataDbName}.${tableRef.metadataTableName}`,
            };
            plan.tableRef = tableRef;
        }

        const [resCols, resIndexes] = await Promise.all([
            withSoftTimeout(
                DBGetColumns(buildRpcConnectionConfig(config) as any, tableRef.metadataDbName, tableRef.metadataTableName),
                () => ({ success: false, message: 'Timed out while loading columns', data: [] }),
            ),
            withSoftTimeout(
                DBGetIndexes(buildRpcConnectionConfig(config) as any, tableRef.metadataDbName, tableRef.metadataTableName)
                    .catch((error: any) => ({ success: false, message: String(error?.message || error || 'Failed to load indexes'), data: [] })),
                () => ({ success: false, message: 'Timed out while loading indexes', data: [] }),
            ),
        ]);
        if (!resCols?.success || !Array.isArray(resCols.data)) {
            plan.editLocator = buildAllColumnsLocator([], { translate });
            return plan;
        }

        const tableColumns = resCols.data as ColumnDefinition[];
        const tableColumnNames = tableColumns.map(getColumnDefinitionName).filter(Boolean);
        if (tableColumnNames.length === 0) {
            plan.editLocator = isOracleLikeDialect(dbType)
                && selectInfo.selectsAll
                && hasTopLevelSqlEditorForUpdate(statement, dbType)
                ? buildAllColumnsLocator([], { translate })
                : buildQueryReadOnlyLocator(translate('query_editor.message.read_only_system_metadata'));
            return plan;
        }
        let executableStatement = statement;
        if (isOracleLikeDialect(dbType) && selectInfo.selectsAll) {
            const rewritten = rewriteOracleDuplicateSelectColumns(executableStatement, tableColumnNames);
            if (rewritten) executableStatement = rewritten;
        }
        const primaryKeys = tableColumns
            .filter((column: any) => getColumnDefinitionKey(column) === 'PRI')
            .map(getColumnDefinitionName)
            .filter(Boolean);
        const indexedMetadata = buildIndexedColumnMetadata(tableColumns,
            resIndexes?.success && Array.isArray(resIndexes.data) ? resIndexes.data as IndexDefinition[] : undefined);
        Object.assign(plan, indexedMetadata);
        const uniqueKeyGroups = indexedMetadata.uniqueKeyGroups || [];
        const writableColumns: Record<string, string> = selectInfo.selectsAll
            ? Object.fromEntries(tableColumnNames.map((column) => [column, column]))
            : {};
        Object.entries(selectInfo.writableColumns).forEach(([resultColumn, sourceColumn]) => {
            const metadataColumn = resolveMetadataColumnName(tableColumnNames, sourceColumn);
            if (metadataColumn) writableColumns[resultColumn] = metadataColumn;
        });
        const appendExpressions: string[] = [];
        const hiddenColumns: string[] = [];
        let needsOracleRowIDExpression = false;
        let needsDuckDBRowIDExpression = false;

        const buildColumnLocator = (strategy: 'primary-key' | 'unique-key', locatorColumns: string[]): EditRowLocator => {
            const valueColumns = locatorColumns.map((column, index) => {
                const selectedColumn = findWritableResultColumnForSource(writableColumns, column);
                if (selectedColumn) return selectedColumn;
                const alias = buildQueryLocatorAlias(column, index + 1);
                appendExpressions.push(buildQueryLocatorColumnExpression(dbType, column, alias));
                hiddenColumns.push(alias);
                return alias;
            });
            return {
                strategy,
                columns: locatorColumns,
                valueColumns,
                hiddenColumns: hiddenColumns.length > 0 ? [...hiddenColumns] : undefined,
                writableColumns,
                readOnly: false,
            };
        };

        if (primaryKeys.length > 0) {
            plan.pkColumns = primaryKeys;
            plan.editLocator = buildColumnLocator('primary-key', primaryKeys);
        } else {
            const uniqueKeyGroup = uniqueKeyGroups.find((group) => group.length > 0);
            if (uniqueKeyGroup) {
                plan.editLocator = buildColumnLocator('unique-key', uniqueKeyGroup);
            } else if (allowOracleRowID && isOracleLikeDialect(dbType)) {
                needsOracleRowIDExpression = true;
                plan.editLocator = {
                    strategy: 'oracle-rowid',
                    columns: ['ROWID'],
                    valueColumns: [ORACLE_ROWID_LOCATOR_COLUMN],
                    hiddenColumns: [ORACLE_ROWID_LOCATOR_COLUMN],
                    writableColumns,
                    readOnly: false,
                };
            } else if (String(dbType || '').trim().toLowerCase() === 'duckdb') {
                needsDuckDBRowIDExpression = true;
                plan.editLocator = {
                    strategy: 'duckdb-rowid',
                    columns: ['rowid'],
                    valueColumns: [DUCKDB_ROWID_LOCATOR_COLUMN],
                    hiddenColumns: [DUCKDB_ROWID_LOCATOR_COLUMN],
                    writableColumns,
                    readOnly: false,
                };
            } else {
                plan.editLocator = buildAllColumnsLocator(tableColumnNames, { writableColumns, translate });
            }
        }

        const executableAppendExpressions = [
            ...(needsOracleRowIDExpression ? [buildQueryRowIDExpression(dbType)] : []),
            ...(needsDuckDBRowIDExpression ? [buildDuckDBRowIDExpression(dbType)] : []),
            ...appendExpressions,
        ];

        if (executableAppendExpressions.length > 0 && isOracleLikeDialect(dbType) && selectInfo.selectsBareAll) {
            const rewritten = rewriteOracleSelectAllWithExpressions(executableStatement, executableAppendExpressions);
            if (rewritten) {
                plan.executedSql = rewritten;
                return plan;
            }

            plan.editLocator = buildAllColumnsLocator(tableColumnNames, { writableColumns, translate });
            return plan;
        }

        plan.executedSql = appendQuerySelectExpressions(executableStatement, executableAppendExpressions);
        return plan;
    } catch {
        plan.editLocator = buildAllColumnsLocator([], { translate });
        return plan;
    }
};
