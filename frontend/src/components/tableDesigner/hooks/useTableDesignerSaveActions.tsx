import { message, Checkbox } from 'antd';
import { ExclamationCircleOutlined } from '@ant-design/icons';
import { arrayMove } from '@dnd-kit/sortable';
import { useMemo } from 'react';
import { t } from '../../../i18n';
import Modal from '../../common/ResizableDraggableModal';
import {
    removeIndexDefinitionsByNames,
    applyPrimaryIndexToColumnKeys,
    normalizeIndexFormFromRow,
} from '../../tableDesignerIndexUtils';
import type { ForeignKeyFormState, IndexKind } from '../tableDesignerTypes';
import {
    buildForeignKeyAddSql as buildForeignKeyAddSqlPreview,
    buildForeignKeyDropSql as buildForeignKeyDropSqlPreview,
} from '../../tableDesignerForeignKeySql';
import {
    replaceForeignKeyDefinitionsFromForm,
    removeForeignKeyDefinitionsByName,
    toForeignKeySqlForms,
} from '../../tableDesignerForeignKeyUtils';
import { summarizeDuckDbPrimaryKeyChange } from '../../tableDesignerDuckDbPrimaryKey';
import { buildAlterTablePreviewSql } from '../../tableDesignerSchemaSql';
import { qualifyTableDesignerCreateName } from '../../tableDesignerSchemaContext';
import type { TableDesignerStateApi } from './useTableDesignerState';
import type { TableDesignerDialectSupportApi } from './useTableDesignerDialectSupport';
import type { TableDesignerColumnEditsApi } from './useTableDesignerColumnEdits';
import type { TableDesignerIndexEditsApi } from './useTableDesignerIndexEdits';
import type { TableDesignerDataLoadApi } from './useTableDesignerDataLoad';
import type { TableDesignerTriggerListApi } from './useTableDesignerTriggerList';
import type { TableDesignerProps } from '../../TableDesigner';

export interface UseTableDesignerSaveActionsInput {
    selectedIndexKeys: TableDesignerStateApi['selectedIndexKeys'];
    setSelectedIndexKeys: TableDesignerStateApi['setSelectedIndexKeys'];
    i18nLanguage: TableDesignerStateApi['i18nLanguage'];
    supportsIndexSchemaOps: TableDesignerDialectSupportApi['supportsIndexSchemaOps'];
    groupedIndexes: TableDesignerColumnEditsApi['groupedIndexes'];
    isNewTable: TableDesignerStateApi['isNewTable'];
    setIndexes: TableDesignerStateApi['setIndexes'];
    setColumns: TableDesignerStateApi['setColumns'];
    buildIndexDropSql: TableDesignerIndexEditsApi['buildIndexDropSql'];
    executeSchemaSql: TableDesignerIndexEditsApi['executeSchemaSql'];
    setForeignKeyModalMode: TableDesignerStateApi['setForeignKeyModalMode'];
    setForeignKeyForm: TableDesignerStateApi['setForeignKeyForm'];
    setIsForeignKeyModalOpen: TableDesignerStateApi['setIsForeignKeyModalOpen'];
    selectedForeignKey: TableDesignerStateApi['selectedForeignKey'];
    resolvePreviewTableInfo: TableDesignerStateApi['resolvePreviewTableInfo'];
    supportsForeignKeySchemaOps: TableDesignerDialectSupportApi['supportsForeignKeySchemaOps'];
    tab: TableDesignerProps['tab'];
    foreignKeyForm: TableDesignerStateApi['foreignKeyForm'];
    groupedForeignKeys: TableDesignerDialectSupportApi['groupedForeignKeys'];
    foreignKeyModalMode: TableDesignerStateApi['foreignKeyModalMode'];
    setFks: TableDesignerStateApi['setFks'];
    setForeignKeySaving: TableDesignerStateApi['setForeignKeySaving'];
    setSelectedForeignKey: TableDesignerStateApi['setSelectedForeignKey'];
    newTableName: TableDesignerStateApi['newTableName'];
    isTDengineChildNewTable: TableDesignerDialectSupportApi['isTDengineChildNewTable'];
    tdengineStableName: TableDesignerStateApi['tdengineStableName'];
    tdengineChildTagDefs: TableDesignerStateApi['tdengineChildTagDefs'];
    tdengineChildTagValues: TableDesignerStateApi['tdengineChildTagValues'];
    tdengineTagValues: TableDesignerStateApi['tdengineTagValues'];
    columns: TableDesignerStateApi['columns'];
    isTDengineNewTable: TableDesignerStateApi['isTDengineNewTable'];
    tdengineTableKind: TableDesignerStateApi['tdengineTableKind'];
    tdengineTagDefinitions: TableDesignerStateApi['tdengineTagDefinitions'];
    buildCreateTableSql: TableDesignerDialectSupportApi['buildCreateTableSql'];
    charset: TableDesignerStateApi['charset'];
    collation: TableDesignerStateApi['collation'];
    tableComment: TableDesignerStateApi['tableComment'];
    getIndexKindOptions: TableDesignerDialectSupportApi['getIndexKindOptions'];
    triggers: TableDesignerStateApi['triggers'];
    setPreviewSql: TableDesignerStateApi['setPreviewSql'];
    setIsPreviewOpen: TableDesignerStateApi['setIsPreviewOpen'];
    resolveTableInfo: TableDesignerStateApi['resolveTableInfo'];
    originalColumns: TableDesignerStateApi['originalColumns'];
    hasUnsavedDraftChanges: TableDesignerStateApi['hasUnsavedDraftChanges'];
    fetchData: TableDesignerDataLoadApi['fetchData'];
    executeSchemaStatements: TableDesignerIndexEditsApi['executeSchemaStatements'];
    previewSql: TableDesignerStateApi['previewSql'];
    selectedSchema: TableDesignerStateApi['selectedSchema'];
    getDbType: TableDesignerStateApi['getDbType'];
    supportsTableDesignerSchemaSelection: TableDesignerTriggerListApi['supportsTableDesignerSchemaSelection'];
    designerSchemaTitle: TableDesignerStateApi['designerSchemaTitle'];
    tableColumns: TableDesignerStateApi['tableColumns'];
    handleResizeStart: TableDesignerDataLoadApi['handleResizeStart'];
    selectedColumnRowKeys: TableDesignerStateApi['selectedColumnRowKeys'];
    setSelectedColumnRowKeys: TableDesignerStateApi['setSelectedColumnRowKeys'];
}

export const useTableDesignerSaveActions = ({
    selectedIndexKeys, setSelectedIndexKeys, i18nLanguage, supportsIndexSchemaOps, groupedIndexes,
    isNewTable, setIndexes, setColumns, buildIndexDropSql, executeSchemaSql, setForeignKeyModalMode,
    setForeignKeyForm, setIsForeignKeyModalOpen, selectedForeignKey, resolvePreviewTableInfo,
    supportsForeignKeySchemaOps, tab, foreignKeyForm, groupedForeignKeys, foreignKeyModalMode,
    setFks, setForeignKeySaving, setSelectedForeignKey, newTableName, isTDengineChildNewTable,
    tdengineStableName, tdengineChildTagDefs, tdengineChildTagValues, tdengineTagValues, columns,
    isTDengineNewTable, tdengineTableKind, tdengineTagDefinitions, buildCreateTableSql, charset,
    collation, tableComment, getIndexKindOptions, triggers, setPreviewSql, setIsPreviewOpen,
    resolveTableInfo, originalColumns, hasUnsavedDraftChanges, fetchData, executeSchemaStatements,
    previewSql, selectedSchema, getDbType, supportsTableDesignerSchemaSelection,
    designerSchemaTitle, tableColumns, handleResizeStart, selectedColumnRowKeys,
    setSelectedColumnRowKeys,
}: UseTableDesignerSaveActionsInput) => {
    const handleDeleteIndex = () => {
        if (selectedIndexKeys.length === 0) {
            message.warning(t('table_designer.message.select_index_to_delete', undefined, i18nLanguage));
            return;
        }
        if (!supportsIndexSchemaOps()) {
            message.warning(t('table_designer.message.index_maintenance_unsupported', undefined, i18nLanguage));
            return;
        }
        // 根据选中的 key 找到对应的索引对象
        const toDelete = groupedIndexes.filter(idx => selectedIndexKeys.includes(idx.key));
        if (toDelete.length === 0) {
            message.warning(t('table_designer.message.select_index_to_delete', undefined, i18nLanguage));
            return;
        }
        const names = toDelete.map(idx => `"${idx.name}"`).join(', ');
        Modal.confirm({
            title: t('table_designer.modal.delete_index_title', undefined, i18nLanguage),
            icon: <ExclamationCircleOutlined />,
            content: toDelete.length === 1
                ? t('table_designer.modal.delete_index_one', { names }, i18nLanguage)
                : t('table_designer.modal.delete_index_many', { count: toDelete.length, names }, i18nLanguage),
            okText: t('table_designer.action.delete', undefined, i18nLanguage),
            okType: 'danger',
            cancelText: t('table_designer.action.cancel', undefined, i18nLanguage),
            onOk: async () => {
                if (isNewTable) {
                    setIndexes((previous) => removeIndexDefinitionsByNames(previous, toDelete.map(idx => idx.name)));
                    if (toDelete.some(idx => String(idx.name || '').toUpperCase() === 'PRIMARY')) {
                        setColumns((previous) => applyPrimaryIndexToColumnKeys(previous, []));
                    }
                    setSelectedIndexKeys([]);
                    message.success(toDelete.length === 1
                        ? t('table_designer.message.index_deleted_draft', undefined, i18nLanguage)
                        : t('table_designer.message.indexes_deleted_draft', { count: toDelete.length }, i18nLanguage));
                    return;
                }
                const sqls: string[] = [];
                for (const idx of toDelete) {
                    const sql = buildIndexDropSql(idx.name);
                    if (!sql) {
                        message.warning(t('table_designer.message.index_delete_named_unsupported', { name: idx.name }, i18nLanguage));
                        return;
                    }
                    sqls.push(sql);
                }
                const ok = await executeSchemaSql(
                    sqls.join('\n'),
                    toDelete.length === 1
                        ? t('table_designer.message.index_deleted', undefined, i18nLanguage)
                        : t('table_designer.message.indexes_deleted', { count: toDelete.length }, i18nLanguage),
                );
                if (ok) {
                    setSelectedIndexKeys([]);
                }
            }
        });
    };

    const openCreateForeignKeyModal = () => {
        setForeignKeyModalMode('create');
        setForeignKeyForm({
            constraintName: '',
            columnNames: [],
            refTableName: '',
            refColumnNames: [],
        });
        setIsForeignKeyModalOpen(true);
    };

    const openEditForeignKeyModal = () => {
        if (!selectedForeignKey) {
            message.warning(t('table_designer.message.select_one_foreign_key', undefined, i18nLanguage));
            return;
        }
        setForeignKeyModalMode('edit');
        setForeignKeyForm({
            constraintName: selectedForeignKey.constraintName,
            columnNames: [...selectedForeignKey.columnNames],
            refTableName: selectedForeignKey.refTableName === '-' ? '' : selectedForeignKey.refTableName,
            refColumnNames: [...selectedForeignKey.refColumnNames],
        });
        setIsForeignKeyModalOpen(true);
    };

    const buildForeignKeyAddSql = (form: ForeignKeyFormState): string | null => {
        const tableInfo = resolvePreviewTableInfo();
        if (!supportsForeignKeySchemaOps()) return null;
        return buildForeignKeyAddSqlPreview({
            dbType: tableInfo.dbType,
            tableRef: tableInfo.tableRef,
            schema: tableInfo.schema,
            form,
        });
    };

    const buildForeignKeyDropSql = (constraintName: string): string | null => {
        const tableInfo = resolvePreviewTableInfo();
        if (!supportsForeignKeySchemaOps()) return null;
        return buildForeignKeyDropSqlPreview({
            dbType: tableInfo.dbType,
            tableRef: tableInfo.tableRef,
            constraintName,
        });
    };

    const handleSubmitForeignKey = async () => {
        if (!supportsForeignKeySchemaOps()) {
            message.warning(t('table_designer.message.foreign_key_maintenance_unsupported', undefined, i18nLanguage));
            return;
        }
        if (!isNewTable && !tab.tableName) return;
        const nextConstraint = String(foreignKeyForm.constraintName || '').trim();
        const refTable = String(foreignKeyForm.refTableName || '').trim();
        const refCols = foreignKeyForm.refColumnNames.map(v => String(v || '').trim()).filter(Boolean);
        const localCols = foreignKeyForm.columnNames.map(v => String(v || '').trim()).filter(Boolean);

        if (!nextConstraint) {
            message.error(t('table_designer.message.foreign_key_name_required', undefined, i18nLanguage));
            return;
        }
        if (localCols.length === 0) {
            message.error(t('table_designer.message.select_local_columns', undefined, i18nLanguage));
            return;
        }
        if (!refTable) {
            message.error(t('table_designer.message.ref_table_required', undefined, i18nLanguage));
            return;
        }
        if (refCols.length === 0) {
            message.error(t('table_designer.message.ref_columns_required', undefined, i18nLanguage));
            return;
        }
        if (localCols.length !== refCols.length) {
            message.error(t('table_designer.message.foreign_key_column_count_mismatch', undefined, i18nLanguage));
            return;
        }

        const duplicate = groupedForeignKeys.some(item => {
            if (foreignKeyModalMode === 'edit' && selectedForeignKey && item.key === selectedForeignKey.key) return false;
            return item.constraintName.toUpperCase() === nextConstraint.toUpperCase();
        });
        if (duplicate) {
            message.error(t('table_designer.message.foreign_key_name_exists', { name: nextConstraint }, i18nLanguage));
            return;
        }

        const nextForm: ForeignKeyFormState = {
            constraintName: nextConstraint,
            columnNames: localCols,
            refTableName: refTable,
            refColumnNames: refCols,
        };
        const addSql = buildForeignKeyAddSql(nextForm);
        if (!addSql) {
            message.warning(t('table_designer.message.foreign_key_maintenance_unsupported', undefined, i18nLanguage));
            return;
        }

        if (isNewTable) {
            setFks((previous) => replaceForeignKeyDefinitionsFromForm(
                previous,
                foreignKeyModalMode === 'edit' && selectedForeignKey ? selectedForeignKey.constraintName : undefined,
                nextForm,
            ));
            setIsForeignKeyModalOpen(false);
            message.success(foreignKeyModalMode === 'create'
                ? t('table_designer.message.foreign_key_saved_draft', undefined, i18nLanguage)
                : t('table_designer.message.foreign_key_updated_draft', undefined, i18nLanguage));
            return;
        }

        setForeignKeySaving(true);
        let sql = addSql;
        if (foreignKeyModalMode === 'edit' && selectedForeignKey) {
            const dropSql = buildForeignKeyDropSql(selectedForeignKey.constraintName);
            if (!dropSql) {
                setForeignKeySaving(false);
                message.warning(t('table_designer.message.foreign_key_delete_unsupported', undefined, i18nLanguage));
                return;
            }
            sql = `${dropSql}\n${addSql}`;
        }

        const ok = await executeSchemaSql(
            sql,
            foreignKeyModalMode === 'create'
                ? t('table_designer.message.foreign_key_created', undefined, i18nLanguage)
                : t('table_designer.message.foreign_key_updated', undefined, i18nLanguage),
        );
        setForeignKeySaving(false);
        if (ok) {
            setIsForeignKeyModalOpen(false);
        }
    };

    const handleDeleteForeignKey = () => {
        if (!selectedForeignKey) {
            message.warning(t('table_designer.message.select_one_foreign_key', undefined, i18nLanguage));
            return;
        }
        if (!supportsForeignKeySchemaOps()) {
            message.warning(t('table_designer.message.foreign_key_maintenance_unsupported', undefined, i18nLanguage));
            return;
        }
        Modal.confirm({
            title: t('table_designer.modal.delete_foreign_key_title', undefined, i18nLanguage),
            icon: <ExclamationCircleOutlined />,
            content: t('table_designer.modal.delete_foreign_key_content', { name: selectedForeignKey.constraintName }, i18nLanguage),
            okText: t('table_designer.action.delete', undefined, i18nLanguage),
            okType: 'danger',
            cancelText: t('table_designer.action.cancel', undefined, i18nLanguage),
            onOk: async () => {
                if (isNewTable) {
                    setFks((previous) => removeForeignKeyDefinitionsByName(previous, selectedForeignKey.constraintName));
                    setSelectedForeignKey(null);
                    message.success(t('table_designer.message.foreign_key_deleted_draft', undefined, i18nLanguage));
                    return;
                }
                const sql = buildForeignKeyDropSql(selectedForeignKey.constraintName);
                if (!sql) {
                    message.warning(t('table_designer.message.foreign_key_delete_unsupported', undefined, i18nLanguage));
                    return;
                }
                await executeSchemaSql(sql, t('table_designer.message.foreign_key_deleted', undefined, i18nLanguage));
            }
        });
    };

    const onDragEnd = ({ active, over }: any) => {
      if (active.id !== over?.id) {
        setColumns((previous) => {
          const activeIndex = previous.findIndex((i) => i._key === active.id);
          const overIndex = previous.findIndex((i) => i._key === over?.id);
          return arrayMove(previous, activeIndex, overIndex);
        });
      }
    };

    const generateDDL = () => {
        if (isNewTable && !newTableName.trim()) {
            message.error(t('table_designer.message.table_name_required', undefined, i18nLanguage));
            return;
        }
        if (isNewTable && isTDengineChildNewTable) {
            if (!tdengineStableName.trim()) {
                message.error(t('table_designer.message.tdengine_stable_name_required', undefined, i18nLanguage));
                return;
            }
            if (tdengineChildTagDefs.length > 0) {
                const missing = tdengineChildTagDefs.filter(tag => !(tdengineChildTagValues[tag.name] ?? '').trim());
                if (missing.length > 0) {
                    message.error(t('table_designer.message.tdengine_tag_values_required', undefined, i18nLanguage));
                    return;
                }
            } else if (!tdengineTagValues.trim()) {
                message.error(t('table_designer.message.tdengine_tag_values_required', undefined, i18nLanguage));
                return;
            }
        } else if (columns.length === 0) {
            message.error(t('table_designer.message.add_at_least_one_column', undefined, i18nLanguage));
            return;
        }

        if (isNewTable && isTDengineNewTable && tdengineTableKind === 'stable') {
            if (tdengineTagDefinitions.length === 0) {
                message.error(t('table_designer.message.tdengine_tag_required', undefined, i18nLanguage));
                return;
            }
            if (tdengineTagDefinitions.some(tag => !tag.name.trim() || !tag.type.trim())) {
                message.error(t('table_designer.message.tdengine_tag_invalid', undefined, i18nLanguage));
                return;
            }
        }

        if (isNewTable) {
            // CREATE TABLE
            const sql = buildCreateTableSql(newTableName, columns, charset, collation, {
                comment: tableComment,
                indexes: groupedIndexes.map((row) => normalizeIndexFormFromRow(
                    row,
                    getIndexKindOptions().map((item) => item.value as IndexKind),
                )),
                foreignKeys: toForeignKeySqlForms(groupedForeignKeys),
                triggers,
            });
            setPreviewSql(sql);
            setIsPreviewOpen(true);
        } else {
            const tableInfo = resolveTableInfo();
            if (tableInfo.dbType === 'duckdb') {
                const pkChange = summarizeDuckDbPrimaryKeyChange(originalColumns, columns);
                if (pkChange.isUnsupportedChange) {
                    message.warning(t('table_designer.message.duckdb_primary_key_change_unsupported', undefined, i18nLanguage));
                    return;
                }
            }
            const sql = buildAlterTablePreviewSql({
                dbType: tableInfo.dbType,
                tableName: tableInfo.qualifiedName,
                originalColumns,
                columns,
                translate: (key, params) => t(key, params, i18nLanguage),
            });

            if (!sql.trim()) {
                message.info(t('table_designer.message.no_changes_detected', undefined, i18nLanguage));
                return;
            }
            setPreviewSql(sql);
            setIsPreviewOpen(true);
        }
    };

    const handleRefreshDesigner = () => {
        if (!hasUnsavedDraftChanges) {
            void fetchData();
            return;
        }

        Modal.confirm({
            title: t('table_designer.modal.unsaved_changes_title', undefined, i18nLanguage),
            icon: <ExclamationCircleOutlined />,
            content: t('table_designer.modal.unsaved_changes_content', undefined, i18nLanguage),
            okText: t('table_designer.action.refresh_anyway', undefined, i18nLanguage),
            cancelText: t('table_designer.action.cancel', undefined, i18nLanguage),
            onOk: async () => {
                await fetchData();
            },
        });
    };

    const handleExecuteSave = async () => {
        const result = await executeSchemaStatements(previewSql);
        if (!result.ok) {
            if (result.cancelled) return;
            message.error(result.message || t('table_designer.message.execution_failed_plain', undefined, i18nLanguage));
            if (result.schemaMayHaveChanged && !isNewTable) {
                await fetchData();
            }
            return;
        }
        setIsPreviewOpen(false);
        if (!isNewTable) {
                await fetchData();
            } else {
                const connectionId = String(tab.connectionId || '').trim();
                const dbName = String(tab.dbName || '').trim();
                if (connectionId && dbName) {
                    window.dispatchEvent(new CustomEvent('gonavi:sidebar-table-created', {
                        detail: {
                            connectionId,
                            dbName,
                            tableName: qualifyTableDesignerCreateName(
                                String(newTableName || '').trim(),
                                selectedSchema,
                                getDbType(),
                            ),
                            schemaName: supportsTableDesignerSchemaSelection ? designerSchemaTitle : undefined,
                        },
                    }));
                }
            }
        message.success(isNewTable
                ? t('table_designer.message.schema_saved_create', undefined, i18nLanguage)
                : t('table_designer.message.schema_saved_alter', undefined, i18nLanguage));
    };

    // Merge columns with resize handler
    const resizableColumns = useMemo(() => tableColumns.map((col, index) => ({
      ...col,
      onHeaderCell: (column: any) => ({
        width: column.width,
        onResizeStart: handleResizeStart(index),
      }),
    })), [tableColumns]);

    // 字段表 Checkbox 选择列（不参与 resize，支持全选）
    const allColumnKeys = useMemo(() => columns.map(c => c._key), [columns]);
    const isAllColumnsSelected = allColumnKeys.length > 0 && selectedColumnRowKeys.length === allColumnKeys.length;
    const isColumnsIndeterminate = selectedColumnRowKeys.length > 0 && selectedColumnRowKeys.length < allColumnKeys.length;

    const columnSelectCol = useMemo(() => ({
        title: () => (
            <div className="table-designer-select-check">
                <Checkbox
                    checked={isAllColumnsSelected}
                    indeterminate={isColumnsIndeterminate}
                    onChange={(e: any) => setSelectedColumnRowKeys(e.target.checked ? allColumnKeys : [])}
                    style={{ margin: 0 }}
                />
            </div>
        ),
        dataIndex: '_select',
        key: '_select',
        width: 44,
        className: 'table-designer-select-column',
        onHeaderCell: () => ({ className: 'table-designer-select-column' }),
        onCell: () => ({ className: 'table-designer-select-column' }),
        render: (_: any, record: any) => (
            <div className="table-designer-select-check">
                <Checkbox
                    checked={selectedColumnRowKeys.includes(record._key)}
                    onChange={(e: any) => {
                        e.stopPropagation();
                        setSelectedColumnRowKeys((prev: string[]) =>
                            e.target.checked
                                ? [...prev, record._key]
                                : prev.filter((k: string) => k !== record._key)
                        );
                    }}
                    style={{ margin: 0 }}
                />
            </div>
        ),
    }), [selectedColumnRowKeys, allColumnKeys, isAllColumnsSelected, isColumnsIndeterminate]);
    return {
        handleDeleteIndex, openCreateForeignKeyModal, openEditForeignKeyModal,
        handleSubmitForeignKey, handleDeleteForeignKey, onDragEnd, generateDDL,
        handleRefreshDesigner, handleExecuteSave, resizableColumns, columnSelectCol,
    };
};

export type TableDesignerSaveActionsApi = ReturnType<typeof useTableDesignerSaveActions>;
