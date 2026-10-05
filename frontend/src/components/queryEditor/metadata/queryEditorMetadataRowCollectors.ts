import { message } from 'antd';
import {
    getCaseInsensitiveValue, getFirstRowValue, buildQualifiedCompletionName,
    type MetadataQueryResult, type CompletionPackageMeta, type CompletionSequenceMeta,
    type CompletionRoutineMeta, type CompletionTriggerMeta, type CompletionViewMeta,
    getMySQLShowTablesName, normalizeCommentText, type CompletionColumnMeta,
    type CompletionSynonymMeta,
} from '../QueryEditorHelpers';
import { splitSidebarQualifiedName } from '../../../utils/sidebarLocate';
import { buildQueryEditorMetadataIdentityKey } from '../queryEditorCompletionTables';
import { splitMetadataQualifiedName } from '../../../utils/qualifiedName';
import { normalizeSidebarViewName, isSidebarViewTableType } from '../../../utils/sidebarMetadata';
import {
    isTableMetadataIncomplete, getTableMetadataIssueDetail,
} from '../../../utils/tableMetadataResult';

export interface CollectQueryEditorPackageMetadataInput {
    packageResults: MetadataQueryResult[];
    metadataDialect: string;
    dbName: string;
    seenPackages: Set<string>;
    allPackages: CompletionPackageMeta[];
}

export const collectQueryEditorPackageMetadata = ({ packageResults, metadataDialect, dbName, seenPackages, allPackages }: CollectQueryEditorPackageMetadataInput) => {
    packageResults.forEach((queryResult) => {
        queryResult.rows.forEach((row) => {
            const rawPackageName = String(getCaseInsensitiveValue(row, ['package_name', 'object_name', 'name']) || '').trim() || getFirstRowValue(row);
            if (!rawPackageName) return;
            const schemaName = String(getCaseInsensitiveValue(row, ['schema_name', 'owner', 'db', 'database']) || '').trim();
            const packageParts = splitSidebarQualifiedName(rawPackageName);
            const resolvedSchemaName = String(schemaName || packageParts.schemaName || '').trim();
            const resolvedPackageName = String(packageParts.objectName || rawPackageName).trim();
            const qualifiedPackageName = buildQualifiedCompletionName(resolvedSchemaName, resolvedPackageName);
            if (!qualifiedPackageName) return;
            const uniqueKey = buildQueryEditorMetadataIdentityKey(
                metadataDialect,
                dbName,
                qualifiedPackageName,
            );
            if (seenPackages.has(uniqueKey)) return;
            seenPackages.add(uniqueKey);
            allPackages.push({
                dbName,
                packageName: qualifiedPackageName,
                schemaName: resolvedSchemaName || splitSidebarQualifiedName(qualifiedPackageName).schemaName || undefined,
            });
        });
    });
};

export interface CollectQueryEditorSequenceMetadataInput {
    sequenceResults: MetadataQueryResult[];
    metadataDialect: string;
    dbName: string;
    seenSequences: Set<string>;
    allSequences: CompletionSequenceMeta[];
}

export const collectQueryEditorSequenceMetadata = ({ sequenceResults, metadataDialect, dbName, seenSequences, allSequences }: CollectQueryEditorSequenceMetadataInput) => {
    sequenceResults.forEach((queryResult) => {
        queryResult.rows.forEach((row) => {
            const rawSequenceName = String(getCaseInsensitiveValue(row, ['sequence_name', 'name']) || '').trim() || getFirstRowValue(row);
            if (!rawSequenceName) return;
            const schemaName = String(getCaseInsensitiveValue(row, ['schema_name', 'sequence_owner', 'owner', 'db', 'database']) || '').trim();
            const sequenceParts = splitSidebarQualifiedName(rawSequenceName);
            const resolvedSchemaName = String(schemaName || sequenceParts.schemaName || '').trim();
            const resolvedSequenceName = String(sequenceParts.objectName || rawSequenceName).trim();
            const qualifiedSequenceName = buildQualifiedCompletionName(resolvedSchemaName, resolvedSequenceName);
            if (!qualifiedSequenceName) return;
            const uniqueKey = buildQueryEditorMetadataIdentityKey(
                metadataDialect,
                dbName,
                qualifiedSequenceName,
            );
            if (seenSequences.has(uniqueKey)) return;
            seenSequences.add(uniqueKey);
            allSequences.push({
                dbName,
                sequenceName: qualifiedSequenceName,
                schemaName: resolvedSchemaName || splitSidebarQualifiedName(qualifiedSequenceName).schemaName || undefined,
            });
        });
    });
};

export interface CollectQueryEditorRoutineMetadataInput {
    routineResults: MetadataQueryResult[];
    isMetadataRowForDatabase: (row: Record<string, any>, targetDbName: string, ownerKeys: string[]) => boolean;
    dbName: string;
    metadataDialect: string;
    seenRoutines: Set<string>;
    allRoutines: CompletionRoutineMeta[];
}

export const collectQueryEditorRoutineMetadata = ({
    routineResults, isMetadataRowForDatabase, dbName, metadataDialect, seenRoutines, allRoutines,
}: CollectQueryEditorRoutineMetadataInput) => {
    routineResults.forEach((queryResult) => {
        queryResult.rows.forEach((row) => {
            if (!isMetadataRowForDatabase(row, dbName, [
                'schema_name', 'nspname', 'owner', 'routine_schema', 'routine_owner',
            ])) return;
            const rawRoutineName = String(getCaseInsensitiveValue(row, ['routine_name', 'object_name', 'proname', 'name']) || '').trim();
            if (!rawRoutineName) return;
            const schemaName = String(getCaseInsensitiveValue(row, ['schema_name', 'nspname', 'owner', 'db', 'database']) || '').trim();
            const rawType = String(getCaseInsensitiveValue(row, ['routine_type', 'object_type', 'type']) || queryResult.inferredType || 'FUNCTION').trim();
            const normalizedType = rawType.toUpperCase().includes('PROC') ? 'PROCEDURE' : 'FUNCTION';
            const qualifiedRoutineName = buildQualifiedCompletionName(schemaName, rawRoutineName);
            if (!qualifiedRoutineName) return;
            const uniqueKey = buildQueryEditorMetadataIdentityKey(
                metadataDialect,
                dbName,
                qualifiedRoutineName,
                normalizedType,
            );
            if (seenRoutines.has(uniqueKey)) return;
            seenRoutines.add(uniqueKey);
            allRoutines.push({
                dbName,
                routineName: qualifiedRoutineName,
                routineType: normalizedType,
                schemaName: schemaName || splitSidebarQualifiedName(qualifiedRoutineName).schemaName || undefined,
            });
        });
    });
};

export interface CollectQueryEditorTriggerMetadataInput {
    triggerResults: MetadataQueryResult[];
    metadataDialect: string;
    dbName: string;
    seenTriggers: Set<string>;
    allTriggers: CompletionTriggerMeta[];
}

export const collectQueryEditorTriggerMetadata = ({ triggerResults, metadataDialect, dbName, seenTriggers, allTriggers }: CollectQueryEditorTriggerMetadataInput) => {
    triggerResults.forEach((queryResult) => {
        queryResult.rows.forEach((row) => {
            const rawTriggerName = String(getCaseInsensitiveValue(row, ['trigger_name', 'triggername', 'trigger', 'name']) || '').trim() || getFirstRowValue(row);
            if (!rawTriggerName) return;
            const rawSchemaName = String(getCaseInsensitiveValue(row, ['schema_name', 'schemaname', 'owner', 'event_object_schema', 'trigger_schema', 'db']) || '').trim();
            const rawTableName = String(getCaseInsensitiveValue(row, ['table_name', 'event_object_table', 'tbl_name', 'table']) || '').trim();
            const metadataSchemaHint = rawSchemaName;
            const triggerParts = splitMetadataQualifiedName(rawTriggerName, metadataSchemaHint);
            const tableParts = splitMetadataQualifiedName(rawTableName, metadataSchemaHint);
            const resolvedSchemaName = String(rawSchemaName || tableParts.parentPath || triggerParts.parentPath || '').trim();
            const resolvedTriggerName = String(triggerParts.objectName || rawTriggerName).trim();
            const resolvedTableName = buildQualifiedCompletionName(
                resolvedSchemaName,
                tableParts.objectName || rawTableName,
                metadataDialect,
            );
            const uniqueKey = (metadataDialect === 'mysql' || metadataDialect === 'starrocks')
                ? buildQueryEditorMetadataIdentityKey(
                    metadataDialect,
                    dbName,
                    resolvedSchemaName,
                    resolvedTriggerName,
                )
                : buildQueryEditorMetadataIdentityKey(
                    metadataDialect,
                    dbName,
                    resolvedSchemaName,
                    resolvedTriggerName,
                    resolvedTableName,
                );
            if (seenTriggers.has(uniqueKey)) return;
            seenTriggers.add(uniqueKey);
            allTriggers.push({
                dbName,
                triggerName: buildQualifiedCompletionName(
                    resolvedSchemaName,
                    resolvedTriggerName,
                    metadataDialect,
                ) || resolvedTriggerName,
                tableName: resolvedTableName || rawTableName,
                schemaName: resolvedSchemaName || undefined,
            });
        });
    });
};

export interface CollectQueryEditorMaterializedViewMetadataInput {
    materializedViewResults: MetadataQueryResult[];
    metadataDialect: string;
    dbName: string;
    seenMaterializedViews: Set<string>;
    allMaterializedViews: CompletionViewMeta[];
}

export const collectQueryEditorMaterializedViewMetadata = ({
    materializedViewResults, metadataDialect, dbName, seenMaterializedViews, allMaterializedViews,
}: CollectQueryEditorMaterializedViewMetadataInput) => {
    materializedViewResults.forEach((queryResult) => {
        queryResult.rows.forEach((row) => {
            const schemaName = String(getCaseInsensitiveValue(row, ['schema_name', 'table_schema', 'db', 'database']) || '').trim();
            const rawViewName = String(getCaseInsensitiveValue(row, ['object_name', 'view_name', 'table_name', 'name', 'materialized_view_name', 'mv_name']) || '').trim() || getFirstRowValue(row);
            const normalizedViewName = normalizeSidebarViewName(metadataDialect, dbName, schemaName, rawViewName);
            if (!normalizedViewName) return;
            const uniqueKey = buildQueryEditorMetadataIdentityKey(
                metadataDialect,
                dbName,
                normalizedViewName,
            );
            if (seenMaterializedViews.has(uniqueKey)) return;
            seenMaterializedViews.add(uniqueKey);
            const parsed = splitSidebarQualifiedName(normalizedViewName);
            allMaterializedViews.push({
                dbName,
                viewName: normalizedViewName,
                schemaName: schemaName || parsed.schemaName || undefined,
            });
        });
    });
};

export interface CollectQueryEditorViewMetadataInput {
    viewResults: MetadataQueryResult[];
    isMetadataRowForDatabase: (row: Record<string, any>, targetDbName: string, ownerKeys: string[]) => boolean;
    dbName: string;
    metadataDialect: string;
    seenViews: Set<string>;
    allViews: CompletionViewMeta[];
}

export const collectQueryEditorViewMetadata = ({
    viewResults, isMetadataRowForDatabase, dbName, metadataDialect, seenViews, allViews,
}: CollectQueryEditorViewMetadataInput) => {
    viewResults.forEach((queryResult) => {
        queryResult.rows.forEach((row) => {
            if (!isMetadataRowForDatabase(row, dbName, [
                'schema_name', 'schemaname', 'owner', 'view_schema', 'view_owner',
            ])) return;
            const tableType = getCaseInsensitiveValue(row, ['table_type', 'table type', 'type']);
            if (!isSidebarViewTableType(tableType)) return;
            const schemaName = String(getCaseInsensitiveValue(row, ['schema_name', 'schemaname', 'owner', 'table_schema', 'db']) || '').trim();
            const rawViewName = String(getCaseInsensitiveValue(row, ['view_name', 'viewname', 'table_name', 'name']) || '').trim()
                || getMySQLShowTablesName(row)
                || getFirstRowValue(row);
            const normalizedViewName = normalizeSidebarViewName(metadataDialect, dbName, schemaName, rawViewName);
            if (!normalizedViewName) return;
            const uniqueKey = buildQueryEditorMetadataIdentityKey(
                metadataDialect,
                dbName,
                normalizedViewName,
            );
            if (seenViews.has(uniqueKey)) return;
            seenViews.add(uniqueKey);
            const parsed = splitSidebarQualifiedName(normalizedViewName);
            allViews.push({
                dbName,
                viewName: normalizedViewName,
                schemaName: schemaName || parsed.schemaName || undefined,
            });
        });
    });
};

export interface CollectQueryEditorColumnMetadataInput {
    resCols: any;
    metadataDialect: string;
    dbName: string;
    incompleteColumnMetadataDbsRef: React.MutableRefObject<Set<string>>;
    allColumns: CompletionColumnMeta[];
}

export const collectQueryEditorColumnMetadata = ({
    resCols, metadataDialect, dbName, incompleteColumnMetadataDbsRef, allColumns,
}: CollectQueryEditorColumnMetadataInput) => {
    if (resCols?.success && Array.isArray(resCols.data)) {
        const normalizedMetadataDbName = buildQueryEditorMetadataIdentityKey(
            metadataDialect,
            dbName,
        );
        if (isTableMetadataIncomplete(resCols)) {
            message.warning(getTableMetadataIssueDetail(resCols));
            incompleteColumnMetadataDbsRef.current.add(normalizedMetadataDbName);
        } else {
            incompleteColumnMetadataDbsRef.current.delete(normalizedMetadataDbName);
        }
        resCols.data.forEach((col: any) => {
            allColumns.push({
                dbName,
                tableName: col.tableName,
                name: col.name,
                type: col.type,
                comment: normalizeCommentText(col.comment ?? col.Comment ?? col.COLUMN_COMMENT ?? col.column_comment ?? '')
            });
        });
    }
};

export interface CollectQueryEditorSynonymMetadataInput {
    synonymResults: MetadataQueryResult[];
    metadataDialect: string;
    seenSynonyms: Set<string>;
    allSynonyms: CompletionSynonymMeta[];
}

export const collectQueryEditorSynonymMetadata = ({ synonymResults, metadataDialect, seenSynonyms, allSynonyms }: CollectQueryEditorSynonymMetadataInput) => {
    synonymResults.forEach((queryResult) => {
        queryResult.rows.forEach((row) => {
            const rawSynonymName = String(getCaseInsensitiveValue(row, ['synonym_name', 'synonymname', 'name']) || '').trim()
                || getFirstRowValue(row);
            const synonymParts = splitSidebarQualifiedName(rawSynonymName);
            const synonymName = String(synonymParts.objectName || rawSynonymName).trim();
            if (!synonymName) return;

            const ownerName = String(getCaseInsensitiveValue(row, ['synonym_owner', 'owner', 'schema_name']) || synonymParts.schemaName || '').trim();
            const rawTargetName = String(getCaseInsensitiveValue(row, ['target_name', 'table_name', 'table']) || '').trim();
            const targetParts = splitSidebarQualifiedName(rawTargetName);
            const targetName = String(targetParts.objectName || rawTargetName).trim();
            if (!targetName) return;

            const targetSchemaName = String(getCaseInsensitiveValue(row, ['target_schema_name', 'table_owner', 'target_owner']) || targetParts.schemaName || '').trim();
            const uniqueKey = buildQueryEditorMetadataIdentityKey(
                metadataDialect,
                ownerName,
                synonymName,
            );
            if (seenSynonyms.has(uniqueKey)) return;
            seenSynonyms.add(uniqueKey);
            allSynonyms.push({
                ownerName,
                synonymName,
                targetSchemaName: targetSchemaName || undefined,
                targetName,
            });
        });
    });
};
