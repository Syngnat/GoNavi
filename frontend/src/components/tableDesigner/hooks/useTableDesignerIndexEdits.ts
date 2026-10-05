import { message } from 'antd';
import { useMemo } from 'react';
import type {
    SchemaExecutionOptions,
    SchemaExecutionResult,
    IndexDisplayRow,
    IndexFormState,
    IndexKind,
} from '../tableDesignerTypes';
import { t } from '../../../i18n';
import {
    splitSchemaExecutionStatements,
    executeTableDesignerSchemaStatements,
} from '../../tableDesignerExecutionSql';
import { dispatchSidebarDatabaseRefresh } from '../../../utils/sidebarDatabaseRefresh';
import { findPotentiallyMutatingConnectionStatements } from '../../../utils/connectionReadOnly';
import { confirmProductionRisk } from '../../../utils/productionRiskConfirm';
import { DBQueryAudited } from '../../../../wailsjs/go/app/App';
import { buildRpcConnectionConfig } from '../../../utils/connectionRpcConfig';
import {
    normalizeIndexFormFromRow,
    type IndexDisplaySnapshot,
    shouldRestoreOriginalIndex,
    replaceIndexDefinitionsFromForm,
    applyPrimaryIndexToColumnKeys,
    hasIndexFormChanged,
} from '../../tableDesignerIndexUtils';
import { buildAlterTableCommentSql } from '../../tableDesignerTableCommentSql';
import { buildIndexCreateSqlPreview } from '../../tableDesignerIndexSql';
import { getRegistryIndexDesign } from '../../../utils/dataSourceRegistry/indexDesign';
import type { TableDesignerStateApi } from './useTableDesignerState';
import type { TableDesignerTriggerListApi } from './useTableDesignerTriggerList';
import type { TableDesignerDialectSupportApi } from './useTableDesignerDialectSupport';
import type { TableDesignerDataLoadApi } from './useTableDesignerDataLoad';
import type { TableDesignerColumnEditsApi } from './useTableDesignerColumnEdits';
import type { TableDesignerProps } from '../../TableDesigner';

export interface UseTableDesignerIndexEditsInput {
    tab: TableDesignerProps['tab'];
    connections: TableDesignerStateApi['connections'];
    i18nLanguage: TableDesignerStateApi['i18nLanguage'];
    resolveTableInfo: TableDesignerStateApi['resolveTableInfo'];
    supportsTableDesignerSchemaSelection: TableDesignerTriggerListApi['supportsTableDesignerSchemaSelection'];
    designerSchemaTitle: TableDesignerStateApi['designerSchemaTitle'];
    getIndexKindOptions: TableDesignerDialectSupportApi['getIndexKindOptions'];
    fetchData: TableDesignerDataLoadApi['fetchData'];
    setTableCommentDraft: TableDesignerStateApi['setTableCommentDraft'];
    tableComment: TableDesignerStateApi['tableComment'];
    setIsTableCommentModalOpen: TableDesignerStateApi['setIsTableCommentModalOpen'];
    supportsTableCommentOps: TableDesignerDialectSupportApi['supportsTableCommentOps'];
    isNewTable: TableDesignerStateApi['isNewTable'];
    setTableComment: TableDesignerStateApi['setTableComment'];
    tableCommentDraft: TableDesignerStateApi['tableCommentDraft'];
    setTableCommentSaving: TableDesignerStateApi['setTableCommentSaving'];
    setIndexModalMode: TableDesignerStateApi['setIndexModalMode'];
    setIndexForm: TableDesignerStateApi['setIndexForm'];
    setIsIndexModalOpen: TableDesignerStateApi['setIsIndexModalOpen'];
    selectedIndex: TableDesignerColumnEditsApi['selectedIndex'];
    resolvePreviewTableInfo: TableDesignerStateApi['resolvePreviewTableInfo'];
    isIndexModalOpen: TableDesignerStateApi['isIndexModalOpen'];
    indexForm: TableDesignerStateApi['indexForm'];
    newTableName: TableDesignerStateApi['newTableName'];
    schemaSelectionOverride: TableDesignerStateApi['schemaSelectionOverride'];
    selectedSchema: TableDesignerStateApi['selectedSchema'];
    selectedIndexKeys: TableDesignerStateApi['selectedIndexKeys'];
    tableHeight: TableDesignerStateApi['tableHeight'];
    isMysqlLikeDialect: TableDesignerStateApi['isMysqlLikeDialect'];
    quoteIdentifierPartByDialect: TableDesignerStateApi['quoteIdentifierPartByDialect'];
    isSqlServerDialect: TableDesignerStateApi['isSqlServerDialect'];
    isPgLikeDialect: TableDesignerStateApi['isPgLikeDialect'];
    isOracleLikeDialect: TableDesignerStateApi['isOracleLikeDialect'];
    quoteIdentifierPathByDialect: TableDesignerStateApi['quoteIdentifierPathByDialect'];
    isNonRelationalDialect: TableDesignerStateApi['isNonRelationalDialect'];
    setIndexes: TableDesignerStateApi['setIndexes'];
    setColumns: TableDesignerStateApi['setColumns'];
    indexModalMode: TableDesignerStateApi['indexModalMode'];
    supportsIndexSchemaOps: TableDesignerDialectSupportApi['supportsIndexSchemaOps'];
    groupedIndexes: TableDesignerColumnEditsApi['groupedIndexes'];
    setIndexSaving: TableDesignerStateApi['setIndexSaving'];
}

export const useTableDesignerIndexEdits = ({
    tab, connections, i18nLanguage, resolveTableInfo, supportsTableDesignerSchemaSelection,
    designerSchemaTitle, getIndexKindOptions, fetchData, setTableCommentDraft, tableComment,
    setIsTableCommentModalOpen, supportsTableCommentOps, isNewTable, setTableComment,
    tableCommentDraft, setTableCommentSaving, setIndexModalMode, setIndexForm, setIsIndexModalOpen,
    selectedIndex, resolvePreviewTableInfo, isIndexModalOpen, indexForm, newTableName,
    schemaSelectionOverride, selectedSchema, selectedIndexKeys, tableHeight, isMysqlLikeDialect,
    quoteIdentifierPartByDialect, isSqlServerDialect, isPgLikeDialect, isOracleLikeDialect,
    quoteIdentifierPathByDialect, isNonRelationalDialect, setIndexes, setColumns, indexModalMode,
    supportsIndexSchemaOps, groupedIndexes, setIndexSaving,
}: UseTableDesignerIndexEditsInput) => {
    const executeSchemaStatements = async (
        sqlText: string,
        options: SchemaExecutionOptions = {},
    ): Promise<SchemaExecutionResult> => {
        const conn = connections.find(c => c.id === tab.connectionId);
        if (!conn) {
            return { ok: false, message: t('table_designer.message.connection_not_found', undefined, i18nLanguage), statementCount: 0 };
        }
        const config = {
            ...conn.config,
            port: Number(conn.config.port),
            password: conn.config.password || "",
            database: conn.config.database || "",
            useSSH: conn.config.useSSH || false,
            ssh: conn.config.ssh || { host: "", port: 22, user: "", password: "", keyPath: "" }
        };
        const dbType = resolveTableInfo().dbType;
        const statements = options.splitStatements === false
            ? (String(sqlText || '').trim() && splitSchemaExecutionStatements(sqlText, dbType).length > 0 ? [sqlText] : [])
            : splitSchemaExecutionStatements(sqlText, dbType);
        const refreshSchemaConsumers = () => {
            dispatchSidebarDatabaseRefresh({
                connectionId: tab.connectionId,
                dbName: tab.dbName || '',
            });
        };
        if (
            !options.skipProductionRiskConfirm
            && findPotentiallyMutatingConnectionStatements(conn.config, sqlText).length > 0
        ) {
            const approved = await confirmProductionRisk({
                connection: conn,
                action: t('connection.production_risk.action.execute_sql'),
                target: [tab.dbName, supportsTableDesignerSchemaSelection ? designerSchemaTitle : '', tab.tableName].filter(Boolean).join(' / '),
                translate: (key, params) => t(key, params, i18nLanguage),
            });
            if (!approved) {
                return { ok: false, cancelled: true, statementCount: statements.length };
            }
        }
        const result = await executeTableDesignerSchemaStatements({
            sqlText,
            dbType,
            execute: (statement) => DBQueryAudited(
                buildRpcConnectionConfig(config) as any,
                tab.dbName || '',
                statement,
                'table_designer',
            ),
            refreshSchemaConsumers,
            emptySqlMessage: t('table_designer.message.no_sql_statement', undefined, i18nLanguage),
            splitStatements: options.splitStatements,
        });
        if (result.ok) return result;

        const failedStatementIndex = result.failedStatementIndex ?? 0;
        const prefix = statements.length > 1
            ? t('table_designer.message.statement_execution_failed_prefix', {
                current: failedStatementIndex + 1,
                total: statements.length,
            }, i18nLanguage)
            : t('table_designer.message.execution_failed_prefix', undefined, i18nLanguage);
        return {
            ...result,
            rawMessage: result.message,
            message: prefix + String(result.message || ''),
        };
    };

    const buildIndexFormFromRow = (row: IndexDisplayRow): IndexFormState => {
        return normalizeIndexFormFromRow(
            row as IndexDisplaySnapshot,
            getIndexKindOptions().map(item => item.value as IndexKind),
        );
    };

    const executeIndexEditSql = async (dropSql: string, addSql: string, previousIndex: IndexDisplayRow): Promise<boolean> => {
        const result = await executeSchemaStatements(`${dropSql}\n${addSql}`);
        if (result.cancelled) return false;
        if (result.ok) {
            await fetchData();
            message.success(t('table_designer.message.index_updated', undefined, i18nLanguage));
            return true;
        }

        const oldCreateSql = buildIndexCreateSql(buildIndexFormFromRow(previousIndex));
        if (!oldCreateSql) {
            message.error(t('table_designer.message.index_restore_unavailable', { detail: result.message || t('table_designer.message.execution_failed_plain', undefined, i18nLanguage) }, i18nLanguage));
            await fetchData();
            return false;
        }

        if (!shouldRestoreOriginalIndex(result)) {
            message.error(result.message || t('table_designer.message.execution_failed_plain', undefined, i18nLanguage));
            if (result.schemaMayHaveChanged) await fetchData();
            return false;
        }

        const restoreResult = await executeSchemaStatements(oldCreateSql, {
            skipProductionRiskConfirm: true,
        });
        if (restoreResult.ok) {
            message.error(t('table_designer.message.index_restored_after_failure', { detail: result.message || t('table_designer.message.execution_failed_plain', undefined, i18nLanguage) }, i18nLanguage));
        } else {
            message.error(t('table_designer.message.index_restore_failed', {
                detail: result.message || t('table_designer.message.execution_failed_plain', undefined, i18nLanguage),
                restoreDetail: restoreResult.message || t('table_designer.fallback.unknown_error', undefined, i18nLanguage),
            }, i18nLanguage));
        }
        await fetchData();
        return false;
    };

    const executeSchemaSql = async (sql: string, successMessage: string): Promise<boolean> => {
        try {
            const result = await executeSchemaStatements(sql);
            if (!result.ok) {
                if (result.cancelled) return false;
                message.error(result.message || t('table_designer.message.execution_failed_plain', undefined, i18nLanguage));
                if (result.schemaMayHaveChanged) await fetchData();
                return false;
            }
            await fetchData();
            message.success(successMessage);
            return true;
        } catch (e: any) {
            message.error(t('table_designer.message.execution_failed', { detail: e?.message || String(e) }, i18nLanguage));
            return false;
        }
    };

    const openTableCommentModal = () => {
        setTableCommentDraft(tableComment || '');
        setIsTableCommentModalOpen(true);
    };

    const buildTableCommentSql = (nextComment: string): string | null => {
        const tableInfo = resolveTableInfo();
        return buildAlterTableCommentSql({
            dbType: tableInfo.dbType,
            tableRef: tableInfo.tableRef,
            schema: tableInfo.schema,
            table: tableInfo.table,
        }, nextComment);
    };

    const handleSaveTableComment = async () => {
        if (!supportsTableCommentOps()) {
            message.warning(t('table_designer.message.table_comment_unsupported', undefined, i18nLanguage));
            return;
        }
        if (isNewTable) {
            setTableComment(tableCommentDraft);
            setIsTableCommentModalOpen(false);
            message.success(t('table_designer.message.table_comment_saved_draft', undefined, i18nLanguage));
            return;
        }
        if (!tab.tableName) return;
        const sql = buildTableCommentSql(tableCommentDraft);
        if (!sql) {
            message.warning(t('table_designer.message.table_comment_unsupported', undefined, i18nLanguage));
            return;
        }
        setTableCommentSaving(true);
        const ok = await executeSchemaSql(sql, t('table_designer.message.table_comment_updated', undefined, i18nLanguage));
        setTableCommentSaving(false);
        if (ok) {
            setTableComment(tableCommentDraft);
            setIsTableCommentModalOpen(false);
        }
    };

    const openCreateIndexModal = () => {
        setIndexModalMode('create');
        const registryDesign = getRegistryIndexDesign(connections.find(c => c.id === tab.connectionId)?.config?.type);
        setIndexForm({
            name: '',
            columnNames: [],
            kind: 'NORMAL',
            indexType: registryDesign?.methods[0] ?? 'DEFAULT',
        });
        setIsIndexModalOpen(true);
    };

    const openEditIndexModal = () => {
        if (!selectedIndex) {
            message.warning(t('table_designer.message.select_one_index', undefined, i18nLanguage));
            return;
        }
        setIndexModalMode('edit');
        setIndexForm(buildIndexFormFromRow(selectedIndex));
        setIsIndexModalOpen(true);
    };

    const getIndexCreateSqlResult = (form: IndexFormState) => {
        const tableInfo = resolvePreviewTableInfo();
        return buildIndexCreateSqlPreview({
            dbType: tableInfo.dbType,
            tableRef: tableInfo.tableRef,
            name: form.name,
            columnNames: form.columnNames,
            kind: form.kind,
            indexType: form.indexType,
            translate: (key, params) => t(key, params, i18nLanguage),
        });
    };

    const buildIndexCreateSql = (form: IndexFormState): string | null => {
        const result = getIndexCreateSqlResult(form);
        if (!result.sql) {
            if (result.severity === 'warning') {
                message.warning(result.message || t('table_designer.message.index_create_sql_unavailable', undefined, i18nLanguage));
            } else {
                message.error(result.message || t('table_designer.message.index_create_sql_unavailable', undefined, i18nLanguage));
            }
            return null;
        }
        return result.sql;
    };

    const indexCreatePreviewSql = useMemo(() => {
        if (!isIndexModalOpen) return '';
        const result = getIndexCreateSqlResult(indexForm);
        return result.sql || `-- ${result.message || 'Index CREATE SQL placeholder unavailable'}`;
    }, [connections, i18nLanguage, indexForm, isIndexModalOpen, isNewTable, newTableName, schemaSelectionOverride, selectedSchema, tab.connectionId, tab.dbName, tab.tableName]);

    const selectedIndexCreateSql = useMemo(() => {
        if (!selectedIndex || selectedIndexKeys.length !== 1) return '';
        const result = getIndexCreateSqlResult(buildIndexFormFromRow(selectedIndex));
        return result.sql || `-- ${result.message || 'Index CREATE SQL unavailable'}`;
    }, [connections, i18nLanguage, isNewTable, newTableName, schemaSelectionOverride, selectedIndex, selectedIndexKeys.length, selectedSchema, tab.connectionId, tab.dbName, tab.tableName]);

    const indexTableHeight = selectedIndexCreateSql ? Math.max(180, tableHeight - 220) : tableHeight;

    const buildIndexDropSql = (indexName: string): string | null => {
        const tableInfo = resolveTableInfo();
        const dbType = tableInfo.dbType;
        const name = String(indexName || '').trim();
        if (!name) return null;

        if (isMysqlLikeDialect(dbType)) {
            if (name.toUpperCase() === 'PRIMARY') {
                return `ALTER TABLE ${tableInfo.tableRef}\nDROP PRIMARY KEY;`;
            }
            const indexRef = quoteIdentifierPartByDialect(name, dbType);
            return `DROP INDEX ${indexRef} ON ${tableInfo.tableRef};`;
        }

        if (isSqlServerDialect(dbType)) {
            const indexRef = quoteIdentifierPartByDialect(name, dbType);
            return `DROP INDEX ${indexRef} ON ${tableInfo.tableRef};`;
        }

        if (isPgLikeDialect(dbType) || isOracleLikeDialect(dbType) || dbType === 'sqlite') {
            const fullIndexName = name.includes('.') || !tableInfo.schema
                ? name
                : `${tableInfo.schema}.${name}`;
            const indexRef = quoteIdentifierPathByDialect(fullIndexName, dbType);
            return `DROP INDEX ${indexRef};`;
        }

        if (isNonRelationalDialect(dbType)) {
            return null;
        }
        const fullIndexName = name.includes('.') || !tableInfo.schema
            ? name
            : `${tableInfo.schema}.${name}`;
        const indexRef = quoteIdentifierPathByDialect(fullIndexName, dbType);
        return `DROP INDEX ${indexRef};`;
    };

    const commitNewTableIndexDraft = (nextForm: IndexFormState, previousName?: string) => {
        setIndexes((previous) => replaceIndexDefinitionsFromForm(previous, previousName, nextForm));
        if (nextForm.kind === 'PRIMARY' || String(previousName || '').toUpperCase() === 'PRIMARY') {
            setColumns((previous) => applyPrimaryIndexToColumnKeys(
                previous,
                nextForm.kind === 'PRIMARY' ? nextForm.columnNames : [],
            ));
        }
        setIsIndexModalOpen(false);
        message.success(indexModalMode === 'create'
            ? t('table_designer.message.index_saved_draft', undefined, i18nLanguage)
            : t('table_designer.message.index_updated_draft', undefined, i18nLanguage));
    };

    const handleSubmitIndex = async () => {
        if (!supportsIndexSchemaOps()) {
            message.warning(t('table_designer.message.index_maintenance_unsupported', undefined, i18nLanguage));
            return;
        }
        if (!isNewTable && !tab.tableName) return;
        const supportedKinds = new Set(getIndexKindOptions().map(item => item.value));
        if (!supportedKinds.has(indexForm.kind)) {
            message.warning(t('table_designer.message.index_kind_unsupported', undefined, i18nLanguage));
            return;
        }
        const nextName = indexForm.kind === 'PRIMARY' ? 'PRIMARY' : String(indexForm.name || '').trim();
        if (indexForm.kind !== 'PRIMARY' && !nextName) {
            message.error(t('table_designer.message.index_name_required', undefined, i18nLanguage));
            return;
        }
        if (indexForm.columnNames.length === 0) {
            message.error(t('table_designer.message.select_at_least_one_column', undefined, i18nLanguage));
            return;
        }

        const upperName = nextName.toUpperCase();
        const duplicate = groupedIndexes.some(idx => {
            if (indexModalMode === 'edit' && selectedIndex && idx.key === selectedIndex.key) return false;
            return idx.name.toUpperCase() === upperName;
        });
        if (duplicate) {
            message.error(t('table_designer.message.index_name_exists', { name: nextName }, i18nLanguage));
            return;
        }

        const nextForm: IndexFormState = {
            name: indexForm.kind === 'PRIMARY' ? 'PRIMARY' : nextName,
            columnNames: [...indexForm.columnNames],
            kind: indexForm.kind,
            indexType: indexForm.kind === 'NORMAL' || indexForm.kind === 'UNIQUE'
                ? (String(indexForm.indexType || '').trim().toUpperCase() || 'DEFAULT')
                : 'DEFAULT',
        };

        if (isNewTable) {
            const preview = getIndexCreateSqlResult({ ...indexForm, name: nextName });
            if (!preview.sql) {
                if (preview.severity === 'warning') {
                    message.warning(preview.message || t('table_designer.message.index_create_sql_unavailable', undefined, i18nLanguage));
                } else {
                    message.error(preview.message || t('table_designer.message.index_create_sql_unavailable', undefined, i18nLanguage));
                }
                return;
            }
            if (indexModalMode === 'edit' && selectedIndex) {
                if (!hasIndexFormChanged(buildIndexFormFromRow(selectedIndex), nextForm)) {
                    message.info(t('table_designer.message.no_index_changes', undefined, i18nLanguage));
                    return;
                }
            }
            commitNewTableIndexDraft(nextForm, indexModalMode === 'edit' && selectedIndex ? selectedIndex.name : undefined);
            return;
        }

        setIndexSaving(true);
        const addSql = buildIndexCreateSql({ ...indexForm, name: nextName });
        if (!addSql) {
            setIndexSaving(false);
            return;
        }
        let sql = addSql;

        if (indexModalMode === 'edit' && selectedIndex) {
            const previousForm = buildIndexFormFromRow(selectedIndex);
            if (!hasIndexFormChanged(previousForm, nextForm)) {
                setIndexSaving(false);
                message.info(t('table_designer.message.no_index_changes', undefined, i18nLanguage));
                return;
            }
            const dropSql = buildIndexDropSql(selectedIndex.name);
            if (!dropSql) {
                setIndexSaving(false);
                message.warning(t('table_designer.message.index_delete_unsupported', undefined, i18nLanguage));
                return;
            }
            const ok = await executeIndexEditSql(dropSql, addSql, selectedIndex);
            setIndexSaving(false);
            if (ok) {
                setIsIndexModalOpen(false);
            }
            return;
        }

        const ok = await executeSchemaSql(
            sql,
            indexModalMode === 'create'
                ? t('table_designer.message.index_created', undefined, i18nLanguage)
                : t('table_designer.message.index_updated', undefined, i18nLanguage),
        );
        setIndexSaving(false);
        if (ok) {
            setIsIndexModalOpen(false);
        }
    };
    return {
        executeSchemaStatements, executeSchemaSql, openTableCommentModal, handleSaveTableComment,
        openCreateIndexModal, openEditIndexModal, indexCreatePreviewSql, selectedIndexCreateSql,
        indexTableHeight, buildIndexDropSql, handleSubmitIndex,
    };
};

export type TableDesignerIndexEditsApi = ReturnType<typeof useTableDesignerIndexEdits>;
