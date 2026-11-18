import {
    collectSharedColumnsForTableIdents, buildQueryEditorMetadataIdentityKeys,
    buildCompletionColumnMetadataIdentityKey,
} from '../queryEditorCompletionColumns';
import {
    sharedAllColumnsData, sharedViewsData, sharedMaterializedViewsData, sharedSynonymsData,
    sharedRoutinesData, sharedVisibleDbs,
} from '../queryEditorCompletionState';
import {
    createBoundedQueryEditorCompletionCandidateBatch, rankQueryEditorCompletionCandidate,
    buildColumnCompletionDetail, buildColumnCompletionDocumentation,
    resolveQueryEditorCompletionFilterText, findCompletionTablesByDatabase,
    getCompletionTableSchemaCounts, type CompletionTableMeta, normalizeCommentText,
    buildCompletionDocumentation, type CompletionViewMeta, selectUnqualifiedCompletionSynonyms,
    materializeBoundedQueryEditorCompletionBatches, QUERY_EDITOR_COMPLETION_SUGGESTION_LIMIT,
    type CompletionColumnMeta,
} from '../QueryEditorHelpers';
import { t as translate } from '../../../i18n';
import { buildQueryEditorMetadataIdentityKey } from '../queryEditorCompletionTables';
import { sqlKeywordPriority } from '../../../utils/sqlDialect';
import type { createSqlCompletionDialectContext } from './sqlCompletionDialectContext';
import type { createSqlCompletionSuggestionBuilders } from './sqlCompletionSuggestionBuilders';
import { buildCompletionDetailTypeLast } from './sqlCompletionDetailFormat';

export interface BuildSqlCompletionGlobalSuggestionsInput {
    expectsTableName: boolean;
    foundTables: Set<string>;
    // 表身份键 → 该表在当前语句中首次出现的位置；用于列候选的次级排序。
    tableReferenceOrder?: Map<string, number>;
    activeDialect: ReturnType<typeof createSqlCompletionDialectContext>['activeDialect'];
    referencedColumns: CompletionColumnMeta[];
    wordPrefix: string;
    isCurrentCompletionDatabase: (dbName: string) => boolean;
    sortGroups: { keyword: string; func: string; routineCurrent: string; routineOther: string; tableCurrent: string; tableOther: string; columnCurrent: string; columnOther: string; db: string; };
    monaco: any;
    quoteCompletionPart: ReturnType<typeof createSqlCompletionDialectContext>['quoteCompletionPart'];
    applyCompletionFragmentCase: ReturnType<typeof createSqlCompletionDialectContext>['applyCompletionFragmentCase'];
    rawWordPrefix: string;
    range: ReturnType<typeof createSqlCompletionDialectContext>['range'];
    currentDatabase: string;
    completionTables: CompletionTableMeta[];
    splitSchemaAndTable: ReturnType<typeof createSqlCompletionDialectContext>['splitSchemaAndTable'];
    buildDbQualifiedTableSuggestionMeta: ReturnType<typeof createSqlCompletionSuggestionBuilders>['buildDbQualifiedTableSuggestionMeta'];
    buildTableSuggestion: ReturnType<typeof createSqlCompletionSuggestionBuilders>['buildTableSuggestion'];
    appendTableSourceAlias: (insertText: string, tableName: string) => string;
    quoteCompletionPath: ReturnType<typeof createSqlCompletionDialectContext>['quoteCompletionPath'];
    getPrefixMatchRank: (...candidates: string[]) => string;
    buildViewSuggestionMeta: ReturnType<typeof createSqlCompletionSuggestionBuilders>['buildViewSuggestionMeta'];
    getViewTypeLabel: ReturnType<typeof createSqlCompletionSuggestionBuilders>['getViewTypeLabel'];
    getViewSuggestionScope: ReturnType<typeof createSqlCompletionSuggestionBuilders>['getViewSuggestionScope'];
    oracleLoginOwner: ReturnType<typeof createSqlCompletionDialectContext>['oracleLoginOwner'];
    buildSynonymSuggestion: ReturnType<typeof createSqlCompletionSuggestionBuilders>['buildSynonymSuggestion'];
    buildRoutineSuggestionMeta: ReturnType<typeof createSqlCompletionSuggestionBuilders>['buildRoutineSuggestionMeta'];
    expectsRoutineName: boolean;
    getRoutineTypeLabel: ReturnType<typeof createSqlCompletionSuggestionBuilders>['getRoutineTypeLabel'];
    dialectKeywords: ReturnType<typeof createSqlCompletionDialectContext>['dialectKeywords'];
    dialectFunctions: ReturnType<typeof createSqlCompletionDialectContext>['dialectFunctions'];
}

/** 去掉 `catalog.schema.table` 里的前缀，只留最后一段。 */
export const stripCompletionTableQualifiers = (tableName: string): string => {
    const text = String(tableName || '').trim();
    if (!text.includes('.')) return text;
    const parts = text.split('.');
    return parts[parts.length - 1].trim();
};

/** 去掉标识符两侧的 `"`、`` ` ``、`[]`，只用于去重键的比较。 */
export const stripCompletionIdentifierDelimiters = (identifier: string): string => {
    const text = String(identifier || '').trim();
    if (text.length < 2) return text;
    const first = text[0];
    const last = text[text.length - 1];
    if ((first === '"' && last === '"') || (first === '`' && last === '`')) {
        return text.slice(1, -1);
    }
    if (first === '[' && last === ']') return text.slice(1, -1);
    return text;
};

export const buildSqlCompletionGlobalSuggestions = ({
    expectsTableName, foundTables, tableReferenceOrder, activeDialect, referencedColumns, wordPrefix,
    isCurrentCompletionDatabase, sortGroups, monaco, quoteCompletionPart,
    applyCompletionFragmentCase, rawWordPrefix, range, currentDatabase, completionTables,
    splitSchemaAndTable, buildDbQualifiedTableSuggestionMeta, buildTableSuggestion,
    appendTableSourceAlias, quoteCompletionPath, getPrefixMatchRank, buildViewSuggestionMeta,
    getViewTypeLabel, getViewSuggestionScope, oracleLoginOwner, buildSynonymSuggestion,
    buildRoutineSuggestionMeta, expectsRoutineName, getRoutineTypeLabel, dialectKeywords,
    dialectFunctions,
}: BuildSqlCompletionGlobalSuggestionsInput) => {
    // 相关列提示：匹配 SQL 中引用的表（FROM/JOIN 等）
    // 权重最高，输入 WHERE 条件时优先显示
    // 先用索引把候选收敛到被引用表的列，避免整库列全量扫描。
    const preloadedRelevantColumns = expectsTableName || foundTables.size === 0
        ? []
        : collectSharedColumnsForTableIdents(sharedAllColumnsData, foundTables, activeDialect);
    // 预加载列（来自 sharedAllColumnsData 索引）与引用列（按别名解析得到）经常
    // 指向同一列：直接拼接会让同一列在补全列表里出现两次。按「库.表.列」的
    // 方言归一化身份键去重，保留先出现的那条（预加载列，权重更高）。
    const mergeRelevantColumns = (
        primary: CompletionColumnMeta[],
        secondary: CompletionColumnMeta[],
    ): CompletionColumnMeta[] => {
        if (primary.length === 0) return secondary;
        if (secondary.length === 0) return primary;
        const seen = new Set<string>();
        const merged: CompletionColumnMeta[] = [];
        for (const column of [...primary, ...secondary]) {
            // 同一张表在两个来源里的写法可能不同：DuckDB 附加库的 GetAllColumns 返回
            // `catalog.schema.table`，而别名解析出来的是 `schema.table`；SQL Server
            // 的目录元数据还会带方括号。只按 trim + 大小写归一化会让同一列算出两个
            // 键，去重失效，候选里出现重复项。
            //
            // 这里改用「表名最后一段 + 列名」：库名与 schema 前缀不参与，足以区分
            // 同一候选列表里实际会出现的列。
            const key = buildCompletionColumnMetadataIdentityKey(
                activeDialect,
                // 表名只取最后一段，并去掉各种定界符。
                '',
                stripCompletionTableQualifiers(column.tableName || ''),
                stripCompletionIdentifierDelimiters(column.name || ''),
            );
            if (key) {
                if (seen.has(key)) continue;
                seen.add(key);
            }
            merged.push(column);
        }
        return merged;
    };
    const relevantColumnCandidates = mergeRelevantColumns(
        preloadedRelevantColumns,
        referencedColumns,
    );
    // 列候选的排序前缀：当前语句 FROM/JOIN 引用的表优先，其次才是当前库。
    // 只按「当前库 vs 其他库」分组会让 WHERE 里两张表的同名列完全同序，
    // 结果按字母序把用户正在写的那张表排到后面（例如 fs_* 排在 wechat_* 之前）。
    //
    // 同一个候选在一次补全里会被 getMatchRank / getSelectionKey / buildSuggestion
    // 各问一次，identityKeys 的推导（含 splitQualifiedNameSegments）不便宜，
    // 按列对象缓存一次即可。
    const identityKeysByColumn = new WeakMap<CompletionColumnMeta, string[]>();
    const resolveColumnIdentityKeys = (column: CompletionColumnMeta): string[] => {
        const cached = identityKeysByColumn.get(column);
        if (cached) return cached;
        const keys = buildQueryEditorMetadataIdentityKeys(
            activeDialect,
            column.dbName || '',
            column.tableName || '',
        );
        identityKeysByColumn.set(column, keys);
        return keys;
    };
    const buildColumnSortPrefix = (column: CompletionColumnMeta): string => {
        const isCurrentDb = isCurrentCompletionDatabase(column.dbName || '');
        const identityKeys = resolveColumnIdentityKeys(column);
        const isReferencedTable = identityKeys.some((key) => foundTables.has(key));
        const groupPrefix = isCurrentDb ? sortGroups.columnCurrent : sortGroups.columnOther;
        if (!isReferencedTable) {
            // 未引用的表排在同库/跨库分组的最后。
            return `${groupPrefix}9`;
        }
        // 引用的表之间再按它在语句中的出现顺序分档：用户正在写的 FROM 表优先，
        // 后面的 JOIN 表依次靠后，避免同档内退化成字母序。
        //
        // 分档必须按真实下标而不是夹紧到 8：夹紧会让第 9 张起的表全部落进同一档，
        // 在子查询多的语句里重新退化成字母序。
        const order = identityKeys.reduce<number | null>((best, key) => {
            const index = tableReferenceOrder?.get(key);
            if (index === undefined) return best;
            return best === null || index < best ? index : best;
        }, null);
        const orderRank = order === null ? 0 : order;
        // 用定宽数字，保证 sortText 的字典序与数值序一致（'10' < '2' 是错的）。
        return `${groupPrefix}${String(Math.min(orderRank, 99)).padStart(2, '0')}`;
    };

    const relevantColumnBatch = createBoundedQueryEditorCompletionCandidateBatch({
        candidates: relevantColumnCandidates,
        prefix: wordPrefix,
        getMatchRank: (column, normalizedPrefix) => {
            if (!resolveColumnIdentityKeys(column).some((key) => foundTables.has(key))) {
                return null;
            }
            return rankQueryEditorCompletionCandidate(normalizedPrefix, [column.name]);
        },
        getSelectionKey: (column, _prefix, matchRank) => (
            buildColumnSortPrefix(column)
            + matchRank
            + column.name
        ),
        buildSuggestion: (column) => {
            return {
                label: column.name,
                kind: monaco.languages.CompletionItemKind.Field,
                insertText: quoteCompletionPart(applyCompletionFragmentCase(column.name, rawWordPrefix)),
                detail: buildColumnCompletionDetail(column),
                documentation: buildColumnCompletionDocumentation(column),
                filterText: resolveQueryEditorCompletionFilterText(wordPrefix, [column.name]) || column.name,
                range,
                sortText: `${buildColumnSortPrefix(column)}${rankQueryEditorCompletionCandidate(wordPrefix, [column.name]) ?? 9}${column.name}`,
            };
        },
    });

    // 表提示：当前库智能处理 schema.table 格式
    // 1. 构建纯表名到 schema 列表的映射，检测同名表
    const currentDatabaseTables = currentDatabase
        ? findCompletionTablesByDatabase(
            completionTables,
            currentDatabase,
            activeDialect,
        )
        : [];
    const tableNameToSchemaCount = getCompletionTableSchemaCounts(
        currentDatabaseTables,
        activeDialect,
    );

    const tableBatch = createBoundedQueryEditorCompletionCandidateBatch<CompletionTableMeta, any>({
        candidates: completionTables,
        prefix: wordPrefix,
        getMatchRank: (table, normalizedPrefix) => {
            const isCurrentDb = isCurrentCompletionDatabase(table.dbName || '');
            const parsed = splitSchemaAndTable(table.tableName || '', table.dbName);
            const pureTable = parsed.table || table.tableName || '';
            if (!isCurrentDb) {
                const meta = buildDbQualifiedTableSuggestionMeta(table.dbName || '', table.tableName || '');
                return rankQueryEditorCompletionCandidate(
                    normalizedPrefix,
                    [meta.dbQualifiedLabel, table.tableName, pureTable],
                );
            }
            return rankQueryEditorCompletionCandidate(normalizedPrefix, [table.tableName, pureTable]);
        },
        getSelectionKey: (table, _prefix, matchRank) => {
            const isCurrentDb = isCurrentCompletionDatabase(table.dbName || '');
            const parsed = splitSchemaAndTable(table.tableName || '', table.dbName);
            const pureTable = parsed.table || table.tableName || '';
            if (!isCurrentDb) {
                const meta = buildDbQualifiedTableSuggestionMeta(table.dbName || '', table.tableName || '');
                const label = meta.dbQualifiedLabel;
                return sortGroups.tableOther + matchRank + label;
            }
            return sortGroups.tableCurrent + matchRank + pureTable;
        },
        buildSuggestion: (table) => {
            const isCurrentDb = isCurrentCompletionDatabase(table.dbName || '');
            const parsed = splitSchemaAndTable(table.tableName || '', table.dbName);
            const pureTable = parsed.table || table.tableName || '';
            if (!isCurrentDb) {
                const meta = buildDbQualifiedTableSuggestionMeta(table.dbName || '', table.tableName || '');
                const label = meta.dbQualifiedLabel;
                return {
                    ...buildTableSuggestion(
                        label,
                        `${translate('query_editor.object_info.table')} (${table.dbName})`,
                        table.comment,
                        wordPrefix,
                        [label, table.tableName || '', pureTable],
                    ),
                    kind: monaco.languages.CompletionItemKind.Class,
                    insertText: appendTableSourceAlias(
                        quoteCompletionPath(applyCompletionFragmentCase(label, rawWordPrefix)),
                        table.tableName || label,
                    ),
                    detail: buildCompletionDetailTypeLast(`${translate('query_editor.object_info.table')} (${table.dbName})`, table.comment),
                    documentation: buildCompletionDocumentation(table.comment),
                    range,
                    sortText: sortGroups.tableOther + getPrefixMatchRank(label, table.tableName || '', pureTable) + label,
                };
            }
            const hasDuplicate = (
                tableNameToSchemaCount.get(
                    buildQueryEditorMetadataIdentityKey(activeDialect, pureTable),
                ) || 0
            ) > 1;
            const label = hasDuplicate ? table.tableName : pureTable;
            const schemaInfo = parsed.schema ? ` (${parsed.schema})` : '';
            return {
                ...buildTableSuggestion(
                    label,
                    `${translate('query_editor.object_info.table')}${schemaInfo}`,
                    table.comment,
                    wordPrefix,
                    [label, table.tableName || '', pureTable],
                ),
                kind: monaco.languages.CompletionItemKind.Class,
                insertText: appendTableSourceAlias(
                    quoteCompletionPath(applyCompletionFragmentCase(
                        hasDuplicate ? table.tableName : pureTable,
                        rawWordPrefix,
                    )),
                    pureTable,
                ),
                detail: buildCompletionDetailTypeLast(`${translate('query_editor.object_info.table')}${schemaInfo}`, table.comment),
                documentation: buildCompletionDocumentation(table.comment),
                range,
                sortText: sortGroups.tableCurrent + getPrefixMatchRank(table.tableName || '', pureTable) + pureTable,
            };
        },
    });

    const buildGlobalViewBatch = (views: CompletionViewMeta[], materialized: boolean) => (
        createBoundedQueryEditorCompletionCandidateBatch({
            candidates: views,
            prefix: wordPrefix,
            getMatchRank: (view, normalizedPrefix) => {
                if (expectsTableName && currentDatabase && !isCurrentCompletionDatabase(view.dbName || '')) return null;
                const meta = buildViewSuggestionMeta(view);
                return rankQueryEditorCompletionCandidate(
                    normalizedPrefix,
                    [meta.dbQualifiedLabel, meta.displayName, meta.objectName, view.viewName],
                );
            },
            getSelectionKey: (view, _prefix, matchRank) => {
                const meta = buildViewSuggestionMeta(view);
                const isCurrentDb = isCurrentCompletionDatabase(view.dbName || '');
                const label = isCurrentDb ? meta.displayName : meta.dbQualifiedLabel;
                return (isCurrentDb ? sortGroups.tableCurrent : sortGroups.tableOther)
                    + '1'
                    + matchRank
                    + label;
            },
            buildSuggestion: (view) => {
                const meta = buildViewSuggestionMeta(view);
                const isCurrentDb = isCurrentCompletionDatabase(view.dbName || '');
                const label = isCurrentDb ? meta.displayName : meta.dbQualifiedLabel;
                return {
                    label,
                    kind: monaco.languages.CompletionItemKind.Class,
                    insertText: meta.insertText,
                    detail: buildCompletionDetailTypeLast(`${getViewTypeLabel(materialized)} (${getViewSuggestionScope(view, meta)})`),
                    filterText: resolveQueryEditorCompletionFilterText(wordPrefix, [meta.dbQualifiedLabel, meta.displayName, meta.objectName, view.viewName])
                        || label,
                    range,
                    sortText: (isCurrentDb ? sortGroups.tableCurrent : sortGroups.tableOther)
                        + '1'
                        + getPrefixMatchRank(label, meta.displayName, meta.objectName, view.viewName || '')
                        + label,
                };
            },
        })
    );
    const viewBatch = buildGlobalViewBatch(sharedViewsData, false);
    const materializedViewBatch = buildGlobalViewBatch(sharedMaterializedViewsData, true);

    const synonymBatch = createBoundedQueryEditorCompletionCandidateBatch({
        candidates: selectUnqualifiedCompletionSynonyms(sharedSynonymsData, oracleLoginOwner),
        prefix: wordPrefix,
        getMatchRank: (synonym, normalizedPrefix) => (
            rankQueryEditorCompletionCandidate(normalizedPrefix, [synonym.synonymName])
        ),
        getSelectionKey: (synonym) => (
            sortGroups.tableCurrent + '05' + getPrefixMatchRank(synonym.synonymName || '') + synonym.synonymName
        ),
        buildSuggestion: (synonym) => buildSynonymSuggestion(
            synonym,
            sortGroups.tableCurrent + '05' + getPrefixMatchRank(synonym.synonymName || '') + synonym.synonymName,
        ),
    });

    const routineBatch = createBoundedQueryEditorCompletionCandidateBatch({
        candidates: sharedRoutinesData,
        prefix: wordPrefix,
        getMatchRank: (routine, normalizedPrefix) => {
            const meta = buildRoutineSuggestionMeta(routine);
            if (expectsRoutineName && meta.routineType !== 'PROCEDURE') return null;
            return rankQueryEditorCompletionCandidate(
                normalizedPrefix,
                [meta.dbQualifiedLabel, meta.displayName, meta.objectName, routine.routineName],
            );
        },
        getSelectionKey: (routine) => {
            const meta = buildRoutineSuggestionMeta(routine);
            const isCurrentDb = isCurrentCompletionDatabase(routine.dbName || '');
            return (isCurrentDb ? sortGroups.routineCurrent : sortGroups.routineOther)
                + getPrefixMatchRank(meta.dbQualifiedLabel, meta.displayName, meta.objectName, routine.routineName || '')
                + meta.dbQualifiedLabel;
        },
        buildSuggestion: (routine) => {
            const meta = buildRoutineSuggestionMeta(routine);
            const isCurrentDb = isCurrentCompletionDatabase(routine.dbName || '');
            const schemaInfo = meta.schemaName && meta.schemaName.toLowerCase() !== String(routine.dbName || '').toLowerCase()
                ? `.${meta.schemaName}`
                : '';
            return {
                label: meta.dbQualifiedLabel,
                kind: monaco.languages.CompletionItemKind.Function,
                insertText: meta.insertText,
                insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
                detail: buildCompletionDetailTypeLast(`${getRoutineTypeLabel(routine.routineType)} (${routine.dbName}${schemaInfo})`),
                range,
                sortText: (isCurrentDb ? sortGroups.routineCurrent : sortGroups.routineOther)
                    + getPrefixMatchRank(meta.dbQualifiedLabel, meta.displayName, meta.objectName, routine.routineName || '')
                    + meta.dbQualifiedLabel,
            };
        },
    });

    // 数据库提示
    const dbBatch = createBoundedQueryEditorCompletionCandidateBatch({
        candidates: sharedVisibleDbs,
        prefix: wordPrefix,
        getMatchRank: (db, normalizedPrefix) => rankQueryEditorCompletionCandidate(normalizedPrefix, [db], false),
        getSelectionKey: (db) => sortGroups.db + db,
        buildSuggestion: (db) => ({
            label: db,
            kind: monaco.languages.CompletionItemKind.Module,
            insertText: db,
            detail: translate('query_editor.object_info.database'),
            range,
            sortText: sortGroups.db + db,
        }),
    });

    // 关键字提示
    const keywordBatch = createBoundedQueryEditorCompletionCandidateBatch({
        candidates: dialectKeywords,
        prefix: wordPrefix,
        getMatchRank: (keyword, normalizedPrefix) => rankQueryEditorCompletionCandidate(normalizedPrefix, [keyword], false),
        getSelectionKey: (keyword) => sortGroups.keyword + keyword,
        buildSuggestion: (keyword) => ({
            label: keyword,
            kind: monaco.languages.CompletionItemKind.Keyword,
            insertText: keyword,
            // filterText 让 Monaco 二次过滤（incomplete 大写列表）按
            // 关键字原文匹配，短前缀候选不再被 fuzzy 规则吞掉（#1328）。
            filterText: keyword,
            range,
            // 组内按常用词权重排序，不再依赖字母序巧合（#1328）。
            sortText: sortGroups.keyword + sqlKeywordPriority(keyword) + keyword,
        }),
    });

    // 内置函数提示
    const funcBatch = createBoundedQueryEditorCompletionCandidateBatch({
        candidates: dialectFunctions,
        prefix: wordPrefix,
        getMatchRank: (func, normalizedPrefix) => rankQueryEditorCompletionCandidate(normalizedPrefix, [func.name], false),
        getSelectionKey: (func) => sortGroups.func + func.name,
        buildSuggestion: (func) => ({
            label: func.name,
            kind: monaco.languages.CompletionItemKind.Function,
            insertText: func.name + '($0)',
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            detail: func.detail,
            // 同关键字：让 Monaco 二次过滤按函数名匹配（#1328）。
            filterText: func.name,
            range,
            sortText: sortGroups.func + func.name,
        }),
    });

    const suggestions = materializeBoundedQueryEditorCompletionBatches([
        relevantColumnBatch,
        tableBatch,
        viewBatch,
        materializedViewBatch,
        synonymBatch,
        dbBatch,
        routineBatch,
        funcBatch,
        keywordBatch,
    ], QUERY_EDITOR_COMPLETION_SUGGESTION_LIMIT);
    return { suggestions };
};
