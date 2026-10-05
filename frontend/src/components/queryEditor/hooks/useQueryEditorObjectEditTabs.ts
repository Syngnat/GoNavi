import { useCallback } from 'react';
import { type QueryEditorNavigationTarget, normalizeMetadataDialect } from '../QueryEditorHelpers';
import { t as translate } from '../../../i18n';
import {
    buildQueryEditorRoutineEditFallbackSql,
    escapeQueryEditorObjectEditSqlLiteral,
    getQueryEditorObjectEditRawValue,
    normalizeQueryEditorRoutineDefinitionForEdit,
    buildQueryEditorQualifiedObjectName,
    buildQueryEditorEditableDefinitionSql,
} from '../queryEditorObjectEditSql';
import { splitSidebarQualifiedName } from '../../../utils/sidebarLocate';
import { buildSqlServerObjectDefinitionQueries } from '../../../utils/sqlServerObjectDefinition';
import { DBQuery, DBShowCreateTable, DBGetTriggers } from '../../../../wailsjs/go/app/App';
import { buildRpcConnectionConfig } from '../../../utils/connectionRpcConfig';
import {
    buildQueryEditorViewDefinitionQueries,
    buildQueryEditorSequenceDefinitionQueries,
    buildQueryEditorPackageDefinitionQueries,
    buildQueryEditorObjectDefinitionConnectionConfig,
    runQueryEditorObjectDefinitionCandidates,
    extractQueryEditorViewDefinition,
    extractQueryEditorSequenceDefinition,
    extractQueryEditorPackageDefinition,
    buildQueryEditorTriggerDefinitionQueries,
    extractQueryEditorTriggerDefinition,
} from '../queryEditorObjectDefinitionQueries';
import { formatDdlForDisplay } from '../../../utils/ddlFormat';
import { findTriggerDefinitionStatement } from '../../../utils/triggerDefinition';
import {
    buildTableDesignerTriggerRestoreSql,
    shouldDropTableDesignerTriggerBeforeReplace,
    buildTableDesignerTriggerDropSql,
} from '../../../utils/tableDesignerTriggerSql';
import { buildEditableTriggerSql } from '../../../utils/triggerEditSql';
import type { QueryEditorConnectionContextApi } from './useQueryEditorConnectionContext';
import type { QueryEditorProps } from '../../QueryEditor';
import { buildPgRoutineDefinitionQuery } from '../../../utils/pgRoutineDefinition';
import { usesDriverObjectDefinition } from '../../definitionViewerDialect';

export interface UseQueryEditorObjectEditTabsInput {
    tab: QueryEditorProps['tab'];
    connectionsRef: QueryEditorConnectionContextApi['connectionsRef'];
    addTab: QueryEditorConnectionContextApi['addTab'];
}

export const useQueryEditorObjectEditTabs = ({ tab, connectionsRef, addTab }: UseQueryEditorObjectEditTabsInput) => {
    const openRoutineObjectEditTab = useCallback(async (
        navigationTarget: Extract<QueryEditorNavigationTarget, { type: 'routine' }>,
        connectionId: string,
        targetDbName: string,
    ) => {
        const targetRoutineName = String(navigationTarget.routineName || '').trim();
        if (!targetRoutineName) return;

        const normalizedRoutineType = String(navigationTarget.routineType || 'FUNCTION').trim().toUpperCase().includes('PROC')
            ? 'PROCEDURE'
            : 'FUNCTION';
        const routineTypeLabel = normalizedRoutineType === 'PROCEDURE'
            ? translate('sidebar.object.procedure')
            : translate('sidebar.object.function');
        const sqlTemplateHeader = `-- ${translate('sidebar.sql_template.edit_routine', {
            type: routineTypeLabel,
            name: targetRoutineName,
        })}`;
        let editSql = `${sqlTemplateHeader}\n-- ${translate('sidebar.sql_template.modify_then_execute')}\n${buildQueryEditorRoutineEditFallbackSql(targetRoutineName, normalizedRoutineType)}`;

        const conn = connectionsRef.current.find((item) => item.id === connectionId);
        const parsedRoutine = splitSidebarQualifiedName(targetRoutineName);
        const targetSchemaName = String(navigationTarget.schemaName || parsedRoutine.schemaName || '').trim();
        if (conn) {
            const dialect = normalizeMetadataDialect(conn);
            const routineObjectName = parsedRoutine.objectName || targetRoutineName;
            const routineSchemaName = targetSchemaName;
            const safeName = escapeQueryEditorObjectEditSqlLiteral(routineObjectName);
            const safeSchema = escapeQueryEditorObjectEditSqlLiteral(routineSchemaName);
            const safeDbName = escapeQueryEditorObjectEditSqlLiteral(targetDbName);
            const config = {
                ...conn.config,
                port: Number(conn.config?.port),
                password: conn.config?.password || '',
                database: conn.config?.database || '',
                useSSH: conn.config?.useSSH || false,
                ssh: conn.config?.ssh || { host: '', port: 22, user: '', password: '', keyPath: '' },
            };
            const queries = (() => {
                switch (dialect) {
                    case 'mysql':
                    case 'starrocks':
                        return [
                            `SHOW CREATE ${normalizedRoutineType} \`${routineObjectName.replace(/`/g, '``')}\``,
                            safeDbName
                                ? `SELECT ROUTINE_DEFINITION AS routine_definition FROM information_schema.routines WHERE routine_schema = '${safeDbName}' AND routine_name = '${safeName}' AND UPPER(routine_type) = '${normalizedRoutineType}' LIMIT 1`
                                : '',
                        ].filter(Boolean);
                    case 'postgres':
                    case 'kingbase':
                    case 'highgo':
                    case 'vastbase':
                    case 'opengauss':
                    case 'gaussdb': {
                        const schemaRef = safeSchema || 'public';
                        return [buildPgRoutineDefinitionQuery(dialect, schemaRef, safeName)];
                    }
                    case 'sqlserver':
                        return buildSqlServerObjectDefinitionQueries('routine', targetRoutineName, targetDbName, 'routine_definition');
                    case 'oracle':
                    case 'dm':
                    case 'dameng': {
                        const owner = safeSchema || safeDbName;
                        return [
                            owner
                                ? `SELECT TEXT FROM ALL_SOURCE WHERE OWNER = '${owner.toUpperCase()}' AND NAME = '${safeName.toUpperCase()}' AND TYPE = '${normalizedRoutineType}' ORDER BY LINE`
                                : `SELECT TEXT FROM USER_SOURCE WHERE NAME = '${safeName.toUpperCase()}' AND TYPE = '${normalizedRoutineType}' ORDER BY LINE`,
                        ];
                    }
                    case 'duckdb': {
                        const schemaRef = safeSchema || 'main';
                        return [
                            `SELECT schema_name, function_name, parameters, macro_definition FROM duckdb_functions() WHERE internal = false AND lower(function_type) = 'macro' AND schema_name = '${schemaRef}' AND function_name = '${safeName}' LIMIT 1`,
                        ];
                    }
                    default:
                        return [];
                }
            })();

            if (usesDriverObjectDefinition(conn)) {
                const result = await DBShowCreateTable(buildRpcConnectionConfig(config) as any, targetDbName, routineObjectName);
                if (result.success && String(result.data || '').trim()) editSql = `${sqlTemplateHeader}\n${String(result.data)}`;
            }
            for (const queryText of usesDriverObjectDefinition(conn) ? [] : queries) {
                try {
                    const result = await DBQuery(buildRpcConnectionConfig(config) as any, targetDbName, queryText);
                    if (!result.success || !Array.isArray(result.data) || result.data.length === 0) {
                        continue;
                    }
                    let definition = '';
                    if (dialect === 'oracle' || dialect === 'dm' || dialect === 'dameng') {
                        definition = result.data.map((row: any) => row.text || row.TEXT || Object.values(row)[0] || '').join('');
                    } else if (dialect === 'duckdb') {
                        const row = result.data[0] as Record<string, any>;
                        const schemaName = String(getQueryEditorObjectEditRawValue(row, ['schema_name']) || routineSchemaName || '').trim();
                        const functionName = String(getQueryEditorObjectEditRawValue(row, ['function_name', 'routine_name', 'name']) || routineObjectName || '').trim();
                        const parametersRaw = getQueryEditorObjectEditRawValue(row, ['parameters']);
                        const macroDefinition = String(getQueryEditorObjectEditRawValue(row, ['macro_definition']) || '').trim();
                        const parameters = Array.isArray(parametersRaw)
                            ? parametersRaw.map((item) => String(item ?? '').trim()).filter(Boolean).join(', ')
                            : String(parametersRaw ?? '').replace(/^\[|\]$/g, '').trim();
                        const qualifiedName = schemaName ? `${schemaName}.${functionName}` : functionName;
                        if (qualifiedName && macroDefinition) {
                            definition = macroDefinition.startsWith('(')
                                ? `CREATE OR REPLACE MACRO ${qualifiedName}(${parameters}) AS ${macroDefinition};`
                                : `CREATE OR REPLACE MACRO ${qualifiedName}(${parameters}) AS TABLE ${macroDefinition};`;
                        }
                    } else if (dialect === 'sqlserver') {
                        definition = result.data
                            .map((row: any) => getQueryEditorObjectEditRawValue(row, ['routine_definition', 'definition', 'text', 'Text']) ?? '')
                            .map((value) => String(value))
                            .join('');
                    } else {
                        const row = result.data[0] as Record<string, any>;
                        const direct = getQueryEditorObjectEditRawValue(row, ['routine_definition', 'definition']);
                        if (direct !== undefined && direct !== null && String(direct).trim()) {
                            definition = String(direct);
                        } else {
                            const createKey = Object.keys(row).find((key) => /create\s+(function|procedure)/i.test(key));
                            definition = createKey ? String(row[createKey] || '') : '';
                        }
                    }

                    const normalizedDefinition = normalizeQueryEditorRoutineDefinitionForEdit(
                        definition,
                        targetRoutineName,
                        normalizedRoutineType,
                    );
                    if (normalizedDefinition) {
                        editSql = `${sqlTemplateHeader}\n${normalizedDefinition}`;
                        break;
                    }
                } catch {
                    // 查询最新定义失败时保留可编辑模板。
                }
            }
        }

        addTab({
            id: `query-edit-routine-${connectionId}-${targetDbName}${targetSchemaName ? `-${targetSchemaName}` : ''}-${targetRoutineName}-${Date.now()}`,
            title: translate('sidebar.tab.edit_routine', {
                type: routineTypeLabel,
                name: targetRoutineName,
            }),
            type: 'query',
            connectionId,
            dbName: targetDbName,
            schemaName: targetSchemaName || undefined,
            query: editSql,
            queryMode: 'object-edit',
            routineName: targetRoutineName,
            routineType: normalizedRoutineType,
            returnToTabId: tab.id || undefined,
        });
    }, [addTab, tab.id]);

    const openDefinitionObjectEditTab = useCallback(async (
        navigationTarget: Extract<QueryEditorNavigationTarget, { type: 'view' | 'materialized-view' | 'sequence' | 'package' }>,
        connectionId: string,
        targetDbName: string,
    ) => {
        const targetSchemaName = String(navigationTarget.schemaName || '').trim();
        const conn = connectionsRef.current.find((item) => item.id === connectionId);
        const dialect = conn ? normalizeMetadataDialect(conn) : '';
        let targetObjectName = '';
        let objectEditName = '';
        let objectLabel = '';
        let definitionTabType: 'view-def' | 'sequence-def' | 'package-def' = 'view-def';
        let definitionQueries: string[] = [];
        let collectAllDefinitionRows = false;
        let latestDefinition = '';

        if (navigationTarget.type === 'view' || navigationTarget.type === 'materialized-view') {
            targetObjectName = String(navigationTarget.viewName || '').trim();
            if (!targetObjectName) return;
            definitionTabType = 'view-def';
            objectEditName = buildQueryEditorQualifiedObjectName(targetObjectName, targetSchemaName);
            objectLabel = navigationTarget.type === 'materialized-view'
                ? translate('definition_viewer.object.materialized_view')
                : translate('definition_viewer.object.view');
            definitionQueries = conn
                ? buildQueryEditorViewDefinitionQueries(
                    dialect,
                    targetObjectName,
                    targetDbName,
                    targetSchemaName,
                    navigationTarget.type === 'materialized-view' ? 'materialized' : 'view',
                )
                : [];
        } else if (navigationTarget.type === 'sequence') {
            targetObjectName = String(navigationTarget.sequenceName || '').trim();
            if (!targetObjectName) return;
            definitionTabType = 'sequence-def';
            objectEditName = buildQueryEditorQualifiedObjectName(targetObjectName, targetSchemaName);
            objectLabel = translate('definition_viewer.object.sequence');
            definitionQueries = conn
                ? buildQueryEditorSequenceDefinitionQueries(dialect, targetObjectName, targetDbName, targetSchemaName)
                : [];
        } else {
            targetObjectName = String(navigationTarget.packageName || '').trim();
            if (!targetObjectName) return;
            definitionTabType = 'package-def';
            objectEditName = buildQueryEditorQualifiedObjectName(targetObjectName, targetSchemaName);
            objectLabel = translate('definition_viewer.object.package');
            collectAllDefinitionRows = true;
            definitionQueries = conn
                ? buildQueryEditorPackageDefinitionQueries(dialect, targetObjectName, targetDbName, targetSchemaName)
                : [];
        }

        if (conn && definitionTabType === 'view-def' && dialect === 'oracle') {
            const result = await DBShowCreateTable(
                buildRpcConnectionConfig(buildQueryEditorObjectDefinitionConnectionConfig(conn)) as any,
                targetDbName,
                objectEditName,
            );
            if (result?.success && String(result.data || '').trim()) {
                  latestDefinition = formatDdlForDisplay(String(result.data), dialect, {
                      oceanBaseProtocol: conn?.config?.oceanBaseProtocol,
                  });
            }
        } else if (conn && definitionQueries.length > 0) {
            const rows = await runQueryEditorObjectDefinitionCandidates(
                buildQueryEditorObjectDefinitionConnectionConfig(conn),
                targetDbName,
                definitionQueries,
                collectAllDefinitionRows,
            );
            if (definitionTabType === 'view-def') {
                latestDefinition = extractQueryEditorViewDefinition(dialect, rows);
            } else if (definitionTabType === 'sequence-def') {
                latestDefinition = extractQueryEditorSequenceDefinition(rows, targetObjectName, targetSchemaName);
            } else {
                latestDefinition = extractQueryEditorPackageDefinition(rows);
            }
        }

        addTab({
            id: `query-edit-object-${connectionId}-${targetDbName}${targetSchemaName ? `-${targetSchemaName}` : ''}-${objectEditName}-${Date.now()}`,
            title: translate('definition_viewer.edit.tab_title', {
                object: objectLabel,
                name: objectEditName,
            }),
            type: 'query',
            connectionId,
            dbName: targetDbName,
            schemaName: targetSchemaName || undefined,
            query: buildQueryEditorEditableDefinitionSql(
                definitionTabType,
                latestDefinition,
                objectEditName,
                objectLabel,
            ),
            queryMode: 'object-edit',
            ...(navigationTarget.type === 'view' || navigationTarget.type === 'materialized-view'
                ? {
                    viewName: targetObjectName,
                    viewKind: (navigationTarget.type === 'materialized-view' ? 'materialized' : 'view') as 'view' | 'materialized',
                    objectType: (navigationTarget.type === 'materialized-view' ? 'materialized-view' : 'view') as 'view' | 'materialized-view',
                }
                : navigationTarget.type === 'sequence'
                    ? { sequenceName: targetObjectName }
                    : navigationTarget.type === 'package'
                        ? { packageName: targetObjectName }
                        : {}),
            returnToTabId: tab.id || undefined,
        });
    }, [addTab, tab.id]);

    const openTriggerObjectEditTab = useCallback(async (
        navigationTarget: Extract<QueryEditorNavigationTarget, { type: 'trigger' }>,
        connectionId: string,
        targetDbName: string,
    ) => {
        const targetTriggerName = String(navigationTarget.triggerName || '').trim();
        if (!targetTriggerName) return;

        const conn = connectionsRef.current.find((item) => item.id === connectionId);
        const dialect = conn ? normalizeMetadataDialect(conn) : '';
        const triggerTableName = String(navigationTarget.tableName || '').trim();
        const targetSchemaName = String(navigationTarget.schemaName || '').trim();
        let latestDefinition = '';
        if (conn) {
            const connectionConfig = buildQueryEditorObjectDefinitionConnectionConfig(conn);
            if (dialect === 'oracle') {
                if (triggerTableName) {
                    try {
                        const result = await DBGetTriggers(connectionConfig as any, targetDbName, triggerTableName);
                        if (result.success) {
                            latestDefinition = findTriggerDefinitionStatement(result.data, targetTriggerName);
                        }
                    } catch {
                        latestDefinition = '';
                    }
                }
            } else {
                const rows = await runQueryEditorObjectDefinitionCandidates(
                    connectionConfig,
                    targetDbName,
                    buildQueryEditorTriggerDefinitionQueries(
                        dialect,
                        targetTriggerName,
                        targetDbName,
                        navigationTarget.schemaName,
                        triggerTableName,
                    ),
                );
                latestDefinition = extractQueryEditorTriggerDefinition(dialect, rows);
            }
        }

        const triggerRollbackSql = buildTableDesignerTriggerRestoreSql(
            { name: targetTriggerName, statement: latestDefinition },
            triggerTableName,
            dialect,
            navigationTarget.schemaName,
        );
        const triggerDropSql = shouldDropTableDesignerTriggerBeforeReplace(triggerRollbackSql, dialect)
            ? buildTableDesignerTriggerDropSql(targetTriggerName, triggerTableName, dialect, navigationTarget.schemaName)
            : '';

        addTab({
            id: `query-edit-trigger-${connectionId}-${targetDbName}${targetSchemaName ? `-${targetSchemaName}` : ''}-${targetTriggerName}-${Date.now()}`,
            title: translate('trigger_viewer.tab.edit_trigger_title', { name: targetTriggerName }),
            type: 'query',
            connectionId,
            dbName: targetDbName,
            schemaName: targetSchemaName || undefined,
            query: buildEditableTriggerSql(targetTriggerName, latestDefinition, {
                dropSql: triggerDropSql,
                dbType: dialect,
                translate,
            }),
            triggerName: targetTriggerName,
            triggerTableName: triggerTableName || undefined,
            triggerRollbackSql: triggerRollbackSql || undefined,
            queryMode: 'object-edit',
            returnToTabId: tab.id || undefined,
        });
    }, [addTab, tab.id]);
    return {
        openRoutineObjectEditTab, openDefinitionObjectEditTab, openTriggerObjectEditTab,
    };
};

export type QueryEditorObjectEditTabsApi = ReturnType<typeof useQueryEditorObjectEditTabs>;
