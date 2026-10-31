import type { ColumnDefinition, IndexDefinition } from '../../types';
import { DBGetColumns, DBGetIndexes } from '../../../wailsjs/go/app/App';
import { buildRpcConnectionConfig } from '../../utils/connectionRpcConfig';
import { isOracleLikeDialect } from '../../utils/sqlDialect';
import { extractQueryResultTableRef } from '../../utils/queryResultTable';
import {
    getQueryResultLocatorMetaCacheKey,
    resolveQueryResultBackfillDefaultSchema,
    resolveQueryResultColumnMetaByCandidateTables,
} from './queryEditorColumnMetaBackfill';
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
    getLocatorMetaCached,
    setLocatorMetaCached,
} from '../../utils/queryLocatorMetaCache';
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
    schemaName,
    allowOracleRowID = true,
    deferColumnMetaBackfill = false,
}: {
    statement: string;
    originalStatement?: string;
    dbType: string;
    currentDb: string;
    config: any;
    forceReadOnly: boolean;
    allowOracleRowID?: boolean;
    schemaName?: string;
    deferColumnMetaBackfill?: boolean;
}): Promise<QueryStatementPlan> => {
    const plan: QueryStatementPlan = {
        originalSql: originalStatement || statement,
        executedSql: statement,
        pkColumns: [],
    };
    if (resolveSqlEditorOperationKeyword(statement, dbType) !== 'select') {
        return plan;
    }
    const defaultSchema = resolveQueryResultBackfillDefaultSchema({
        dbType,
        currentDb,
        schemaName,
        config,
    });
    // 即使只读也要解析 tableRef：结果页列类型/注释依赖 metadataDbName + tableName
    try {
        const previewTableRef = extractQueryResultTableRef(statement, dbType, currentDb, defaultSchema);
        if (previewTableRef) {
            plan.tableRef = previewTableRef;
        }
    } catch {
        // ignore parse errors; keep bare plan
    }
    if (!plan.tableRef && !deferColumnMetaBackfill) {
        // 复杂 SQL（JOIN/GROUP BY/派生表/逗号多表）定位不到单表，但源表仍可知：
        // 按列名把类型和注释回填到结果列上，匹配不到的列自然不显示类型行。
        // 只服务显示，不设置 tableRef，因此不会解锁可写回定位。
        try {
            const fallbackColumnMetaMap = await resolveQueryResultColumnMetaByCandidateTables({
                statement,
                dbType,
                currentDb,
                defaultSchema,
                config,
            });
            if (fallbackColumnMetaMap) {
                plan.columnMetaMap = fallbackColumnMetaMap;
            }
        } catch {
            // 回填失败只影响表头的类型/注释，不影响执行本身
        }
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

        const selectInfo = parseSimpleSelectInfo(statement, dbType);
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

        // 元数据 TTL 缓存叠加：
        // 命中 → 直接用快照，省掉 DBGetColumns + DBGetIndexes 两次 IPC；
        // 未命中 → 仍走下面的两次调用，且**保留** withSoftTimeout 软超时兜底
        //（缓存不是替换它：超时语义与「执行不被元数据拖死」的保证完全不变）。
        const locatorMetaKey = getQueryResultLocatorMetaCacheKey(
            config,
            tableRef.metadataDbName,
            tableRef.metadataTableName,
        );
        const cachedMeta = getLocatorMetaCached(locatorMetaKey);
        let resCols: any;
        let resIndexes: any;
        if (cachedMeta) {
            resCols = cachedMeta.columns
                ? { success: true, data: cachedMeta.columns }
                : { success: false, message: 'columns not cached', data: [] };
            resIndexes = cachedMeta.indexes
                ? { success: true, data: cachedMeta.indexes }
                : { success: false, message: 'indexes not cached', data: [] };
        } else {
            const [freshCols, freshIndexes] = await Promise.all([
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
            resCols = freshCols;
            resIndexes = freshIndexes;
            // 只在列元数据确实成功时写缓存：软超时/失败返回 success:false，
            // 写进去会把一次失败固化成 120s 内的持续失败。
            // 索引失败时照写（indexes 置空），宁可退化到「全列定位」也不要丢掉列缓存；
            // 该退化窗口由 120s TTL + DDL 失效钩子收敛。
            if (freshCols?.success && Array.isArray(freshCols.data)) {
                setLocatorMetaCached(locatorMetaKey, {
                    columns: freshCols.data as ColumnDefinition[],
                    indexes: freshIndexes?.success && Array.isArray(freshIndexes.data)
                        ? freshIndexes.data as IndexDefinition[]
                        : undefined,
                });
            }
        }
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
            const rewritten = rewriteOracleDuplicateSelectColumns(executableStatement, tableColumnNames, dbType);
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
            const rewritten = rewriteOracleSelectAllWithExpressions(executableStatement, executableAppendExpressions, dbType);
            if (rewritten) {
                plan.executedSql = rewritten;
                return plan;
            }

            plan.editLocator = buildAllColumnsLocator(tableColumnNames, { writableColumns, translate });
            return plan;
        }

        plan.executedSql = appendQuerySelectExpressions(executableStatement, executableAppendExpressions, dbType);
        return plan;
    } catch {
        plan.editLocator = buildAllColumnsLocator([], { translate });
        return plan;
    }
};
