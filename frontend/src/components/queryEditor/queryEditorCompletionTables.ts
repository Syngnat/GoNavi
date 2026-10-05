import { v4 as uuidv4 } from 'uuid';
import { DBQuery } from '../../../wailsjs/go/app/App';
import { buildRpcConnectionConfig } from '../../utils/connectionRpcConfig';
import { buildMetadataIdentityKey } from '../../utils/metadataIdentity';
import { extractTableNameFromMetadataRow } from '../../utils/tableMetadataRows';
import {
    queryEditorColumnsCache as boundedColumnsCache,
    clearQueryEditorMetadataCaches,
} from './queryEditorMetadataCaches';
import {
    normalizeCommentText,
    getCaseInsensitiveValue,
    splitCompletionSchemaAndTable,
    type CompletionTableMeta,
    buildCompletionTableCommentSQL,
} from './QueryEditorHelpers';
import {
    normalizeQueryEditorTableTargetName,
    sharedQueryEditorHoverDdlCache,
    sharedQueryEditorHoverDdlRequests,
    sharedQueryEditorHoverDdlRevisionByConnection,
} from './queryEditorHoverDdl';
import {
    setSharedQueryEditorMetadataGeneration,
    sharedQueryEditorMetadataGeneration,
    setSharedQueryEditorMetadataContextKey,
    setSharedQueryEditorMetadataConnectionConfig,
    setSharedCurrentDb,
    setSharedCurrentSchema,
    setSharedTablesData,
    setSharedAllColumnsData,
    setSharedVisibleDbs,
    setSharedViewsData,
    setSharedMaterializedViewsData,
    setSharedSynonymsData,
    setSharedTriggersData,
    setSharedRoutinesData,
    setSharedSequencesData,
    setSharedPackagesData,
    setSharedActiveEditorModelUri,
    sharedLazyTablesInFlight,
    sharedLazyTablesRevisionByKey,
} from './queryEditorCompletionState';
import { clearRecord } from './queryEditorLazyTablesCache';

export const isExactQueryEditorTableName = (
    left: string,
    right: string,
    metadataDialect = '',
): boolean => {
    const normalizedLeft = normalizeQueryEditorTableTargetName(left, metadataDialect);
    const normalizedRight = normalizeQueryEditorTableTargetName(right, metadataDialect);
    return Boolean(normalizedLeft && normalizedLeft === normalizedRight);
};

const getCompletionTableNameFromRow = (row: any): string => (
    normalizeCommentText(extractTableNameFromMetadataRow(row))
);

const getCompletionTableCommentFromRow = (row: any): string => (
    normalizeCommentText(getCaseInsensitiveValue(row, [
        'table_comment',
        'TABLE_COMMENT',
        'comment',
        'comments',
        'Comment',
        'COMMENTS',
        'description',
        'Description',
    ]))
);

export const buildQueryEditorMetadataIdentityKey = buildMetadataIdentityKey;

export const buildCompletionTableMetadataIdentityKey = (
    metadataDialect: string,
    dbName: string,
    tableName: string,
): string => buildQueryEditorMetadataIdentityKey(metadataDialect, dbName, tableName);

const getCompletionTableComment = (
    tableComments: Map<string, string>,
    tableName: string,
    metadataDialect: string,
    rowComment = '',
): string => {
    const parsed = splitCompletionSchemaAndTable(String(tableName || ''));
    return tableComments.get(buildQueryEditorMetadataIdentityKey(metadataDialect, tableName))
        ?? (parsed.table
            ? tableComments.get(buildQueryEditorMetadataIdentityKey(metadataDialect, parsed.table))
            : undefined)
        ?? normalizeCommentText(rowComment);
};

export const buildCompletionTableMeta = (
    dbName: string,
    row: any,
    tableComments: Map<string, string>,
    metadataDialect: string,
): CompletionTableMeta | null => {
    const tableName = getCompletionTableNameFromRow(row);
    if (!tableName) return null;
    return {
        dbName,
        tableName,
        comment: getCompletionTableComment(
            tableComments,
            tableName,
            metadataDialect,
            getCompletionTableCommentFromRow(row),
        ) || undefined,
    };
};

export const fetchCompletionTableCommentMap = async (
    config: any,
    dbName: string,
    metadataDialect: string,
): Promise<Map<string, string>> => {
    const tableComments = new Map<string, string>();
    const tableCommentSQL = buildCompletionTableCommentSQL(metadataDialect, dbName);
    if (!tableCommentSQL) return tableComments;

    try {
        const resTableComments = await DBQuery(buildRpcConnectionConfig(config) as any, dbName, tableCommentSQL);
        if (resTableComments.success && Array.isArray(resTableComments.data)) {
            resTableComments.data.forEach((row: any) => {
                const tableName = normalizeCommentText(getCaseInsensitiveValue(row, ['table_name', 'TABLE_NAME', 'name', 'Name']));
                if (!tableName) return;
                tableComments.set(
                    buildQueryEditorMetadataIdentityKey(metadataDialect, tableName),
                    getCompletionTableCommentFromRow(row),
                );
            });
        }
    } catch {
        // 表备注只是补全增强，失败时保留原有表名补全。
    }
    return tableComments;
};

const buildSqlSnippetVariableMap = (now: Date): Record<string, string> => {
    const pad = (value: number) => String(value).padStart(2, '0');
    return {
        CURRENT_YEAR: String(now.getFullYear()),
        CURRENT_MONTH: pad(now.getMonth() + 1),
        CURRENT_DATE: pad(now.getDate()),
        CURRENT_HOUR: pad(now.getHours()),
        CURRENT_MINUTE: pad(now.getMinutes()),
        CURRENT_SECOND: pad(now.getSeconds()),
        CURRENT_SECONDS_UNIX: String(Math.floor(now.getTime() / 1000)),
        UUID: uuidv4(),
        RANDOM: String(Math.floor(100000 + Math.random() * 900000)),
    };
};

export const materializeSqlSnippetText = (body: string): string => {
    const tabstopValues = new Map<string, string>();
    const variableMap = buildSqlSnippetVariableMap(new Date());
    return String(body || '')
        .replace(/\$\{(\d+)\|([^}]+)\|\}/g, (_match, index: string, rawChoices: string) => {
            const choice = String(rawChoices || '')
                .split(',')
                .map((item) => item.trim())
                .find(Boolean) || '';
            if (index !== '0') {
                tabstopValues.set(index, choice);
            }
            return choice;
        })
        .replace(/\$\{([A-Z_]+)\}/g, (match, variableName: string) => (
            Object.prototype.hasOwnProperty.call(variableMap, variableName)
                ? variableMap[variableName]
                : match
        ))
        .replace(/\$\{(\d+):([^}]+)\}/g, (_match, index: string, placeholder: string) => {
            const value = String(placeholder || '');
            if (index !== '0') {
                tabstopValues.set(index, value);
            }
            return value;
        })
        .replace(/\$(\d+)/g, (_match, index: string) => (
            index === '0' ? '' : (tabstopValues.get(index) ?? '')
        ));
};

export const resetSharedQueryEditorMetadata = (releaseHoverDdlState = false) => {
    setSharedQueryEditorMetadataGeneration(sharedQueryEditorMetadataGeneration + 1);
    setSharedQueryEditorMetadataContextKey('');
    setSharedQueryEditorMetadataConnectionConfig(null);
    setSharedCurrentDb('');
    setSharedCurrentSchema('');
    setSharedTablesData([]);
    setSharedAllColumnsData([]);
    setSharedVisibleDbs([]);
    setSharedViewsData([]);
    setSharedMaterializedViewsData([]);
    setSharedSynonymsData([]);
    setSharedTriggersData([]);
    setSharedRoutinesData([]);
    setSharedSequencesData([]);
    setSharedPackagesData([]);
    boundedColumnsCache.clear();
    setSharedActiveEditorModelUri('');
    clearQueryEditorMetadataCaches();
    clearRecord(sharedLazyTablesInFlight);
    clearRecord(sharedLazyTablesRevisionByKey);
    if (releaseHoverDdlState) {
        sharedQueryEditorHoverDdlCache.clear();
        sharedQueryEditorHoverDdlRequests.clear();
        sharedQueryEditorHoverDdlRevisionByConnection.clear();
    }
};
