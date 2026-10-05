import {
    buildQueryEditorTableSuggestionLabel, normalizeQueryEditorTableSuggestionText,
} from '../queryEditorCompletionColumns';
import {
    appendCommentToDetail, resolveQueryEditorCompletionFilterText, type CompletionRoutineMeta,
    type CompletionViewMeta, type CompletionSynonymMeta,
} from '../QueryEditorHelpers';
import { t as translate } from '../../../i18n';
import { sharedCurrentConnectionId, sharedConnections } from '../queryEditorCompletionState';
import type { createSqlCompletionDialectContext } from './sqlCompletionDialectContext';

export interface CreateSqlCompletionSuggestionBuildersInput {
    splitSchemaAndTable: ReturnType<typeof createSqlCompletionDialectContext>['splitSchemaAndTable'];
    quoteCompletionPart: ReturnType<typeof createSqlCompletionDialectContext>['quoteCompletionPart'];
    quoteCompletionPath: ReturnType<typeof createSqlCompletionDialectContext>['quoteCompletionPath'];
    useStructuredCompletionLabel: boolean;
    getActiveCompletionDbName: ReturnType<typeof createSqlCompletionDialectContext>['getActiveCompletionDbName'];
    monaco: any;
    range: ReturnType<typeof createSqlCompletionDialectContext>['range'];
}

export const createSqlCompletionSuggestionBuilders = ({
    splitSchemaAndTable, quoteCompletionPart, quoteCompletionPath, useStructuredCompletionLabel,
    getActiveCompletionDbName, monaco, range,
}: CreateSqlCompletionSuggestionBuildersInput) => {
    const buildDbQualifiedTableSuggestionMeta = (dbName: string, tableName: string) => {
        const rawDbName = String(dbName || '').trim();
        const rawTableName = String(tableName || '').trim();
        const parsed = splitSchemaAndTable(rawTableName, rawDbName);
        const schemaMatchesDb = !!parsed.schema
            && !!parsed.table
            && parsed.schema.toLowerCase() === rawDbName.toLowerCase();
        const displayName = schemaMatchesDb ? parsed.table : rawTableName;
        const insertName = schemaMatchesDb ? parsed.table : rawTableName;
        const insertText = schemaMatchesDb
            ? quoteCompletionPart(insertName)
            : quoteCompletionPath(insertName);
        const dbQualifiedLabel = rawDbName
            ? `${rawDbName}.${displayName || rawTableName}`
            : (displayName || rawTableName);
        return {
            displayName: displayName || rawTableName,
            insertName,
            insertText,
            dbQualifiedLabel,
        };
    };
    const buildTableSuggestion = (
        label: string,
        detailPrefix: string,
        comment?: string,
        filterPrefix = '',
        filterCandidates: readonly string[] = [label],
    ) => ({
        label: buildQueryEditorTableSuggestionLabel(
            label,
            appendCommentToDetail(detailPrefix, comment),
            useStructuredCompletionLabel,
        ),
        filterText: resolveQueryEditorCompletionFilterText(filterPrefix, filterCandidates)
            || normalizeQueryEditorTableSuggestionText(label),
    });
    const normalizeRoutineType = (routineType: string) => (
        String(routineType || '').trim().toUpperCase().includes('PROC') ? 'PROCEDURE' : 'FUNCTION'
    );
    const getRoutineTypeLabel = (routineType: string) => (
        normalizeRoutineType(routineType) === 'PROCEDURE'
            ? translate('sidebar.object.procedure')
            : translate('sidebar.object.function')
    );
    const buildRoutineSuggestionMeta = (routine: CompletionRoutineMeta) => {
        const rawDbName = String(routine.dbName || '').trim();
        const rawRoutineName = String(routine.routineName || '').trim();
        const parsed = splitSchemaAndTable(rawRoutineName, rawDbName);
        const schemaName = String(routine.schemaName || parsed.schema || '').trim();
        const objectName = String(parsed.table || rawRoutineName).trim();
        const schemaMatchesDb = !!schemaName
            && !!rawDbName
            && schemaName.toLowerCase() === rawDbName.toLowerCase();
        const isCurrentDb = rawDbName.toLowerCase() === getActiveCompletionDbName().toLowerCase();
        const displayName = isCurrentDb && schemaMatchesDb
            ? objectName
            : (parsed.schema ? rawRoutineName : objectName);
        const dbQualifiedLabel = rawDbName && !isCurrentDb
            ? `${rawDbName}.${displayName}`
            : displayName;
        const insertName = rawDbName && !isCurrentDb
            ? dbQualifiedLabel
            : displayName;
        return {
            displayName,
            dbQualifiedLabel,
            insertText: `${quoteCompletionPath(insertName)}($0)`,
            objectName,
            schemaName,
            routineType: normalizeRoutineType(routine.routineType),
        };
    };
    const getViewTypeLabel = (materialized: boolean) => (
        materialized
            ? translate('query_editor.object_info.materialized_view')
            : translate('sidebar.object.view')
    );
    const buildViewSuggestionMeta = (view: CompletionViewMeta) => {
        const rawDbName = String(view.dbName || '').trim();
        const rawViewName = String(view.viewName || '').trim();
        const parsed = splitSchemaAndTable(rawViewName, rawDbName);
        const schemaName = String(view.schemaName || parsed.schema || '').trim();
        const objectName = String(parsed.table || rawViewName).trim();
        const schemaMatchesDb = !!schemaName
            && !!rawDbName
            && schemaName.toLowerCase() === rawDbName.toLowerCase();
        const isCurrentDb = rawDbName.toLowerCase() === getActiveCompletionDbName().toLowerCase();
        const schemaQualifiedName = schemaName && !schemaMatchesDb
            ? `${schemaName}.${objectName}`
            : objectName;
        const displayName = isCurrentDb && schemaMatchesDb
            ? objectName
            : schemaQualifiedName;
        const dbQualifiedLabel = rawDbName && !isCurrentDb
            ? `${rawDbName}.${displayName}`
            : displayName;
        const insertName = rawDbName && !isCurrentDb
            ? dbQualifiedLabel
            : displayName;
        return {
            displayName,
            dbQualifiedLabel,
            insertText: quoteCompletionPath(insertName),
            objectName,
            schemaName,
        };
    };
    const getViewSuggestionScope = (view: CompletionViewMeta, meta: ReturnType<typeof buildViewSuggestionMeta>) => {
        const dbName = String(view.dbName || '').trim();
        const schemaName = String(meta.schemaName || '').trim();
        if (!schemaName || schemaName.toLowerCase() === dbName.toLowerCase()) {
            return dbName;
        }
        return dbName ? `${dbName}.${schemaName}` : schemaName;
    };
    const getSynonymTargetName = (synonym: CompletionSynonymMeta) => {
        const targetSchemaName = String(synonym.targetSchemaName || '').trim();
        const targetName = String(synonym.targetName || '').trim();
        return targetSchemaName && targetName ? `${targetSchemaName}.${targetName}` : targetName;
    };
    const buildSynonymSuggestion = (synonym: CompletionSynonymMeta, sortText: string) => {
        const synonymName = String(synonym.synonymName || '').trim();
        const targetName = getSynonymTargetName(synonym);
        return {
            label: synonymName,
            kind: monaco.languages.CompletionItemKind.Class,
            insertText: quoteCompletionPath(synonymName),
            detail: targetName
                ? `${translate('query_editor.object_info.synonym')} (${targetName})`
                : translate('query_editor.object_info.synonym'),
            range,
            sortText,
        };
    };
    const buildConnConfig = () => {
        const connId = sharedCurrentConnectionId;
        const conn = sharedConnections.find(c => c.id === connId);
        if (!conn) return null;
        return {
            ...conn.config,
            port: Number(conn.config.port),
            password: conn.config.password || "",
            database: conn.config.database || "",
            useSSH: conn.config.useSSH || false,
            ssh: conn.config.ssh || { host: "", port: 22, user: "", password: "", keyPath: "" }
        };
    };
    return {
        buildDbQualifiedTableSuggestionMeta, buildTableSuggestion, getRoutineTypeLabel,
        buildRoutineSuggestionMeta, getViewTypeLabel, buildViewSuggestionMeta,
        getViewSuggestionScope, buildSynonymSuggestion, buildConnConfig,
    };
};
