import { message } from 'antd';
import { useCallback, useMemo } from 'react';
import { flushSync } from 'react-dom';
import {
    splitSchemaExecutionStatements,
    containsTableDesignerTriggerCreateStatement,
} from '../../tableDesignerExecutionSql';
import { t } from '../../../i18n';
import { parseTriggerDraftFromSql, replaceTriggerDrafts } from '../../tableDesignerTriggerDraft';
import { confirmProductionRisk } from '../../../utils/productionRiskConfirm';
import {
    supportsTableDesignerSchemaSelection as supportsRequestedTableDesignerSchemaSelection,
} from '../../tableDesignerSchemaContext';
import {
    buildTableDesignerTriggerRestoreSql,
    shouldDropTableDesignerTriggerBeforeReplace,
} from '../../../utils/tableDesignerTriggerSql';
import type {
    SchemaExecutionOptions,
    SchemaExecutionResult,
    EditableColumn,
    IndexDisplayRow,
} from '../tableDesignerTypes';
import { isMySQLCharacterColumnType } from '../../../utils/columnDefinition';
import { useTableDesignerColumnClipboard } from '../../useTableDesignerColumnClipboard';
import type { TableDesignerStateApi } from './useTableDesignerState';
import type { TableDesignerTriggerListApi } from './useTableDesignerTriggerList';
import type { TableDesignerDataLoadApi } from './useTableDesignerDataLoad';
import type { TableDesignerProps } from '../../TableDesigner';

export interface UseTableDesignerColumnEditsInput {
    tab: TableDesignerProps['tab'];
    getDbType: TableDesignerStateApi['getDbType'];
    triggerEditSql: TableDesignerStateApi['triggerEditSql'];
    i18nLanguage: TableDesignerStateApi['i18nLanguage'];
    isNewTable: TableDesignerStateApi['isNewTable'];
    triggers: TableDesignerStateApi['triggers'];
    setTriggers: TableDesignerStateApi['setTriggers'];
    triggerEditMode: TableDesignerStateApi['triggerEditMode'];
    selectedTrigger: TableDesignerStateApi['selectedTrigger'];
    setSelectedTrigger: TableDesignerStateApi['setSelectedTrigger'];
    setIsTriggerEditModalOpen: TableDesignerStateApi['setIsTriggerEditModalOpen'];
    connections: TableDesignerStateApi['connections'];
    setTriggerExecuting: TableDesignerStateApi['setTriggerExecuting'];
    resolveTableInfo: TableDesignerStateApi['resolveTableInfo'];
    buildDropTriggerSql: TableDesignerTriggerListApi['buildDropTriggerSql'];
    executeSchemaStatements: (sqlText: string, options?: SchemaExecutionOptions) => Promise<SchemaExecutionResult>;
    fetchData: TableDesignerDataLoadApi['fetchData'];
    setColumns: TableDesignerStateApi['setColumns'];
    commentEditorColumnKey: TableDesignerStateApi['commentEditorColumnKey'];
    closeCommentEditor: TableDesignerStateApi['closeCommentEditor'];
    commentEditorColumnType: TableDesignerStateApi['commentEditorColumnType'];
    columnDefaultEnabled: TableDesignerStateApi['columnDefaultEnabled'];
    columnDefaultValue: TableDesignerStateApi['columnDefaultValue'];
    commentEditorValue: TableDesignerStateApi['commentEditorValue'];
    columnCharset: TableDesignerStateApi['columnCharset'];
    columnCollation: TableDesignerStateApi['columnCollation'];
    columns: TableDesignerStateApi['columns'];
    setSelectedColumnRowKeys: TableDesignerStateApi['setSelectedColumnRowKeys'];
    pendingFocusColumnKeyRef: TableDesignerStateApi['pendingFocusColumnKeyRef'];
    selectedColumnRowKeys: TableDesignerStateApi['selectedColumnRowKeys'];
    setIsCopyColumnsModalOpen: TableDesignerStateApi['setIsCopyColumnsModalOpen'];
    readOnly: TableDesignerStateApi['readOnly'];
    activeKey: TableDesignerStateApi['activeKey'];
    indexes: TableDesignerStateApi['indexes'];
    selectedIndexKeys: TableDesignerStateApi['selectedIndexKeys'];
}

export const useTableDesignerColumnEdits = ({
    tab, getDbType, triggerEditSql, i18nLanguage, isNewTable, triggers, setTriggers,
    triggerEditMode, selectedTrigger, setSelectedTrigger, setIsTriggerEditModalOpen, connections,
    setTriggerExecuting, resolveTableInfo, buildDropTriggerSql, executeSchemaStatements, fetchData,
    setColumns, commentEditorColumnKey, closeCommentEditor, commentEditorColumnType,
    columnDefaultEnabled, columnDefaultValue, commentEditorValue, columnCharset, columnCollation,
    columns, setSelectedColumnRowKeys, pendingFocusColumnKeyRef, selectedColumnRowKeys,
    setIsCopyColumnsModalOpen, readOnly, activeKey, indexes, selectedIndexKeys,
}: UseTableDesignerColumnEditsInput) => {
    const handleExecuteTriggerSql = async () => {
      const dbType = getDbType();
      if (
        !String(triggerEditSql || '').trim()
        || splitSchemaExecutionStatements(triggerEditSql, dbType).length === 0
      ) {
        message.error(t('table_designer.message.no_sql_statement', undefined, i18nLanguage));
        return;
      }
      if (!containsTableDesignerTriggerCreateStatement(triggerEditSql, dbType)) {
        message.error(t('trigger_viewer.edit_sql.empty_definition', undefined, i18nLanguage));
        return;
      }

      if (isNewTable) {
        const parsed = parseTriggerDraftFromSql(triggerEditSql);
        if (!parsed?.name) {
          message.error(t('table_designer.message.trigger_name_required', undefined, i18nLanguage));
          return;
        }
        const duplicate = triggers.some((item) => {
          if (triggerEditMode === 'edit' && selectedTrigger && item.name === selectedTrigger.name) return false;
          return item.name.toUpperCase() === parsed.name.toUpperCase();
        });
        if (duplicate) {
          message.error(t('table_designer.message.trigger_name_exists', { name: parsed.name }, i18nLanguage));
          return;
        }
        setTriggers((previous) => replaceTriggerDrafts(
          previous,
          triggerEditMode === 'edit' ? selectedTrigger?.name : undefined,
          parsed,
        ));
        setSelectedTrigger(parsed);
        setIsTriggerEditModalOpen(false);
        message.success(triggerEditMode === 'create'
          ? t('table_designer.message.trigger_saved_draft', undefined, i18nLanguage)
          : t('table_designer.message.trigger_updated_draft', undefined, i18nLanguage));
        return;
      }

      const conn = connections.find(c => c.id === tab.connectionId);
      if (!conn) {
        message.error(t('table_designer.message.connection_not_found', undefined, i18nLanguage));
        return;
      }

      const approved = await confirmProductionRisk({
        connection: conn,
        action: t('connection.production_risk.action.execute_sql'),
        target: [tab.dbName, selectedTrigger?.name].filter(Boolean).join(' / '),
        translate: (key, params) => t(key, params, i18nLanguage),
      });
      if (!approved) return;

      setTriggerExecuting(true);

      try {
        let triggerSchemaMayHaveChanged = false;
        const tableInfo = resolveTableInfo();
        const restoreTableName = tableInfo.tableRef || (
          supportsRequestedTableDesignerSchemaSelection(dbType)
            ? tableInfo.qualifiedName
            : (tab.tableName || '')
        );
        const restoreSql = triggerEditMode === 'edit' && selectedTrigger
          ? buildTableDesignerTriggerRestoreSql(selectedTrigger, restoreTableName, dbType, tableInfo.schema)
          : '';
        const shouldDropExistingTrigger = triggerEditMode === 'edit'
          && Boolean(selectedTrigger)
          && shouldDropTableDesignerTriggerBeforeReplace(restoreSql, dbType);
        // 如果是编辑模式，先删除旧触发器
        if (shouldDropExistingTrigger && selectedTrigger) {
          const dropSql = buildDropTriggerSql(selectedTrigger.name);
          const dropResult = await executeSchemaStatements(dropSql, {
            skipProductionRiskConfirm: true,
          });
          if (!dropResult.ok) {
            const failureDetail = dropResult.rawMessage || dropResult.message;
            if (dropResult.outcomeUnknown) {
              await fetchData();
              message.error(t('table_designer.message.trigger_outcome_unknown', {
                detail: failureDetail,
              }, i18nLanguage));
            } else if (dropResult.schemaMayHaveChanged && restoreSql) {
              const restoreResult = await executeSchemaStatements(restoreSql, {
                skipProductionRiskConfirm: true,
                splitStatements: false,
              });
              await fetchData();
              message.error(restoreResult.ok
                ? t('table_designer.message.trigger_restored_after_failure', {
                  detail: failureDetail,
                }, i18nLanguage)
                : t('table_designer.message.trigger_restore_failed', {
                  detail: failureDetail,
                  restoreDetail: restoreResult.rawMessage || restoreResult.message,
                }, i18nLanguage));
            } else {
              if (dropResult.schemaMayHaveChanged) await fetchData();
              message.error(t('table_designer.message.drop_old_trigger_failed', {
                detail: failureDetail,
              }, i18nLanguage));
            }
            return;
          }
          triggerSchemaMayHaveChanged = true;
        }

        // 执行创建语句
        const result = await executeSchemaStatements(triggerEditSql, {
          skipProductionRiskConfirm: true,
          splitStatements: false,
        });
        if (result.ok) {
          setIsTriggerEditModalOpen(false);
          setSelectedTrigger(null);
          await fetchData();
          message.success(triggerEditMode === 'create'
              ? t('table_designer.message.trigger_created', undefined, i18nLanguage)
              : t('table_designer.message.trigger_updated', undefined, i18nLanguage));
        } else {
          if (triggerSchemaMayHaveChanged || result.schemaMayHaveChanged) await fetchData();
          const failureDetail = result.rawMessage || result.message;
          if (result.outcomeUnknown) {
            message.error(t('table_designer.message.trigger_outcome_unknown', {
              detail: failureDetail,
            }, i18nLanguage));
          } else if (triggerSchemaMayHaveChanged && restoreSql) {
            const restoreResult = await executeSchemaStatements(restoreSql, {
              skipProductionRiskConfirm: true,
              splitStatements: false,
            });
            if (restoreResult.ok) {
              await fetchData();
              message.error(t('table_designer.message.trigger_restored_after_failure', {
                detail: failureDetail,
              }, i18nLanguage));
            } else {
              await fetchData();
              message.error(t('table_designer.message.trigger_restore_failed', {
                detail: failureDetail,
                restoreDetail: restoreResult.rawMessage || restoreResult.message,
              }, i18nLanguage));
            }
          } else if (triggerSchemaMayHaveChanged) {
            message.error(t('table_designer.message.trigger_restore_unavailable', {
              detail: failureDetail,
            }, i18nLanguage));
          } else {
            message.error(t('table_designer.message.execution_failed', {
              detail: failureDetail,
            }, i18nLanguage));
          }
        }
      } catch (e: any) {
        message.error(t('table_designer.message.execution_failed', { detail: e?.message || String(e) }, i18nLanguage));
      } finally {
        setTriggerExecuting(false);
      }
    };

    // --- Handlers ---

    const handleColumnChange = (key: string, field: keyof EditableColumn, value: any) => {
        setColumns(prev => prev.map(col => {
            if (col._key === key) {
                const newCol = { ...col, [field]: value };
                if (field === 'key' && value === 'PRI') newCol.nullable = 'NO';
                if (field === 'isAutoIncrement' && value === true) {
                    newCol.key = 'PRI';
                    newCol.nullable = 'NO';
                    newCol.type = 'int'; // Suggest INT
                }
                if (field === 'type' && getDbType() === 'mysql' && !isMySQLCharacterColumnType(String(value))) {
                    newCol.charset = undefined;
                    newCol.collation = undefined;
                }
                return newCol;
            }
            return col;
        }));
    };

    const handleSaveColumnOptions = () => {
        if (!commentEditorColumnKey) {
            closeCommentEditor();
            return;
        }

        const isMySQL = getDbType() === 'mysql';
        const supportsCharacterOptions = isMySQL && isMySQLCharacterColumnType(commentEditorColumnType);
        const hasDefault = columnDefaultEnabled && (
            columnDefaultValue.length > 0 || isMySQLCharacterColumnType(commentEditorColumnType)
        );
        setColumns(prev => prev.map(col => {
            if (col._key !== commentEditorColumnKey) return col;
            return {
                ...col,
                comment: commentEditorValue,
                hasDefault,
                default: hasDefault ? columnDefaultValue : undefined,
                ...(isMySQL ? {
                    charset: supportsCharacterOptions ? columnCharset : undefined,
                    collation: supportsCharacterOptions ? columnCollation : undefined,
                } : {}),
            };
        }));
        closeCommentEditor();
    };

    const createNewColumn = useCallback((indexHint: number): EditableColumn => ({
        name: isNewTable ? 'new_column' : `new_col_${indexHint}`,
        type: 'varchar(255)',
        nullable: 'YES',
        key: '',
        extra: '',
        comment: '',
        default: undefined,
        hasDefault: false,
        _key: `new-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        isNew: true,
        isAutoIncrement: false
    }), [isNewTable]);

    const handleAddColumn = useCallback((insertAfterKey?: string) => {
        const newCol = createNewColumn(columns.length + 1);
        setColumns(prev => {
            const next = [...prev];
            if (insertAfterKey) {
                const insertIndex = next.findIndex(col => col._key === insertAfterKey);
                if (insertIndex >= 0) {
                    next.splice(insertIndex + 1, 0, newCol);
                    return next;
                }
            }
            next.push(newCol);
            return next;
        });
        setSelectedColumnRowKeys([newCol._key]);
        pendingFocusColumnKeyRef.current = newCol._key;
    }, [columns.length, createNewColumn]);

    const handleAddColumnAfterSelected = useCallback(() => {
        const selectedSet = new Set(selectedColumnRowKeys);
        const anchor = columns.find(col => selectedSet.has(col._key));
        if (!anchor) {
            message.warning(t('table_designer.message.select_column_before_insert', undefined, i18nLanguage));
            return;
        }
        handleAddColumn(anchor._key);
    }, [columns, handleAddColumn, i18nLanguage, selectedColumnRowKeys]);

    const handleDeleteColumn = (key: string) => {
        setColumns(prev => prev.filter(c => c._key !== key));
    };

    const selectedColumns = useMemo(() => {
        if (selectedColumnRowKeys.length === 0) return [];
        const selectedSet = new Set(selectedColumnRowKeys);
        return columns.filter(col => selectedSet.has(col._key));
    }, [columns, selectedColumnRowKeys]);

    const openCopySelectedColumnsModal = () => {
        if (selectedColumns.length === 0) {
            message.warning(t('table_designer.message.select_columns_to_copy', undefined, i18nLanguage));
            return;
        }
        setIsCopyColumnsModalOpen(true);
    };

    const columnClipboard = useTableDesignerColumnClipboard({
        readOnly,
        language: i18nLanguage,
        columns,
        selectedColumns,
        setColumns: (updater) => {
            setColumns((previous) => updater(previous) as EditableColumn[]);
        },
        setSelectedColumnRowKeys,
        pendingFocusColumnKeyRef,
        onCopyToTable: openCopySelectedColumnsModal,
        shortcutEnabled: activeKey === 'columns' || activeKey === 'tdengine',
    });

    const handleColumnRowContextMenu = (record: EditableColumn) => {
        flushSync(() => {
            setSelectedColumnRowKeys((previous) => (
                previous.includes(record._key) ? previous : [record._key]
            ));
        });
    };

    const groupedIndexes = useMemo<IndexDisplayRow[]>(() => {
        type IndexFieldItem = {
            name: string;
            seq: number;
            order: number;
        };
        type IndexBucket = {
            key: string;
            name: string;
            indexType: string;
            nonUnique: number;
            order: number;
            fields: IndexFieldItem[];
        };

        const buckets = new Map<string, IndexBucket>();

        const safeIndexes = Array.isArray(indexes) ? indexes : [];
        safeIndexes.forEach((idx, order) => {
            const rawName = String(idx.name || '').trim();
            const key = rawName || `__unnamed_${order}`;
            const indexType = String(idx.indexType || '').trim() || '-';
            const displayName = rawName || t('table_designer.fallback.unnamed_index', undefined, i18nLanguage);

            if (!buckets.has(key)) {
                buckets.set(key, {
                    key,
                    name: displayName,
                    indexType,
                    nonUnique: idx.nonUnique === 0 ? 0 : 1,
                    order,
                    fields: [],
                });
            }

            const bucket = buckets.get(key);
            if (!bucket) return;

            if (bucket.indexType === '-' && indexType !== '-') {
                bucket.indexType = indexType;
            }
            if (idx.nonUnique === 0) {
                bucket.nonUnique = 0;
            }

            const columnName = String(idx.columnName || '').trim();
            if (!columnName) return;

            const rawSeq = Number(idx.seqInIndex);
            const seq = Number.isFinite(rawSeq) ? rawSeq : 0;
            bucket.fields.push({
                name: columnName,
                seq,
                order,
            });
        });

        return Array.from(buckets.values())
            .sort((a, b) => a.order - b.order)
            .map((bucket) => {
                const sortedFieldNames = bucket.fields
                    .slice()
                    .sort((a, b) => {
                        const aSeq = a.seq > 0 ? a.seq : Number.MAX_SAFE_INTEGER;
                        const bSeq = b.seq > 0 ? b.seq : Number.MAX_SAFE_INTEGER;
                        if (aSeq !== bSeq) return aSeq - bSeq;
                        return a.order - b.order;
                    })
                    .map(field => field.name);

                const uniqueFieldNames = Array.from(new Set(sortedFieldNames));

                return {
                    key: bucket.key,
                    name: bucket.name,
                    indexType: bucket.indexType,
                    nonUnique: bucket.nonUnique,
                    columnNames: uniqueFieldNames,
                };
            });
    }, [i18nLanguage, indexes]);

    const selectedIndex = useMemo(() => {
        if (selectedIndexKeys.length === 0) return null;
        return groupedIndexes.find(idx => selectedIndexKeys.includes(idx.key)) || null;
    }, [selectedIndexKeys, groupedIndexes]);

    const groupedIndexFieldCount = useMemo(
        () => groupedIndexes.reduce((total, row) => total + row.columnNames.length, 0),
        [groupedIndexes]
    );
    return {
        handleExecuteTriggerSql, handleColumnChange, handleSaveColumnOptions, handleAddColumn,
        handleAddColumnAfterSelected, handleDeleteColumn, selectedColumns,
        openCopySelectedColumnsModal, columnClipboard, handleColumnRowContextMenu, groupedIndexes,
        selectedIndex, groupedIndexFieldCount,
    };
};

export type TableDesignerColumnEditsApi = ReturnType<typeof useTableDesignerColumnEdits>;
