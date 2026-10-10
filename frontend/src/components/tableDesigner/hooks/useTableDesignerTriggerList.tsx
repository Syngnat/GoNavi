import { useEffect } from 'react';
import { ExclamationCircleOutlined } from '@ant-design/icons';
import { message } from 'antd';
import {
    supportsTableDesignerSchemaSelection as supportsRequestedTableDesignerSchemaSelection,
    resolveLoadedTableDesignerSchema,
} from '../../tableDesignerSchemaContext';
import { stripIdentifierQuotes, splitQualifiedNameLast } from '../../../utils/qualifiedName';
import {
    buildQueryEditorSessionMetadataKey,
    buildQueryEditorSessionMetadataScope,
    queryEditorSchemaContextSession,
    type QueryEditorSchemaContext,
} from '../../queryEditor/metadata/queryEditorSessionMetadataStore';
import { fetchQueryEditorSchemaContext } from '../../queryEditor/metadata/queryEditorSchemaContextFetch';
import Modal from '../../common/ResizableDraggableModal';
import { t } from '../../../i18n';
import {
    buildTableDesignerTriggerTemplate,
    removeTriggerDraftByName,
} from '../../tableDesignerTriggerDraft';
import {
    buildTableDesignerTriggerDropSql,
    buildTableDesignerTriggerRestoreSql,
    shouldDropTableDesignerTriggerBeforeReplace,
} from '../../../utils/tableDesignerTriggerSql';
import { buildEditableTriggerSql } from '../../../utils/triggerEditSql';
import { confirmProductionRisk } from '../../../utils/productionRiskConfirm';
import type { SchemaExecutionOptions, SchemaExecutionResult } from '../tableDesignerTypes';
import type { TableDesignerDataLoadApi } from './useTableDesignerDataLoad';
import type { TableDesignerStateApi } from './useTableDesignerState';
import type { TableDesignerProps } from '../../TableDesigner';

export interface UseTableDesignerTriggerListInput {
    normalizeDbType: TableDesignerDataLoadApi['normalizeDbType'];
    getDbType: TableDesignerStateApi['getDbType'];
    tab: TableDesignerProps['tab'];
    schemaLoadSeqRef: TableDesignerStateApi['schemaLoadSeqRef'];
    schemaContextKeyRef: TableDesignerStateApi['schemaContextKeyRef'];
    latestSelectedSchemaRef: TableDesignerStateApi['latestSelectedSchemaRef'];
    setSchemaOptions: TableDesignerStateApi['setSchemaOptions'];
    setSelectedSchema: TableDesignerStateApi['setSelectedSchema'];
    setSchemaSelectionOverride: TableDesignerStateApi['setSchemaSelectionOverride'];
    setSchemaReady: TableDesignerStateApi['setSchemaReady'];
    setSchemaLoading: TableDesignerStateApi['setSchemaLoading'];
    connections: TableDesignerStateApi['connections'];
    tableDesignerSchemaByConnection: TableDesignerStateApi['tableDesignerSchemaByConnection'];
    setTableDesignerSchema: TableDesignerStateApi['setTableDesignerSchema'];
    selectedSchema: TableDesignerStateApi['selectedSchema'];
    isNewTable: TableDesignerStateApi['isNewTable'];
    setColumns: TableDesignerStateApi['setColumns'];
    setOriginalColumns: TableDesignerStateApi['setOriginalColumns'];
    setIndexes: TableDesignerStateApi['setIndexes'];
    setFks: TableDesignerStateApi['setFks'];
    setTriggers: TableDesignerStateApi['setTriggers'];
    setDdl: TableDesignerStateApi['setDdl'];
    setSelectedColumnRowKeys: TableDesignerStateApi['setSelectedColumnRowKeys'];
    hasUnsavedDraftChanges: TableDesignerStateApi['hasUnsavedDraftChanges'];
    i18nLanguage: TableDesignerStateApi['i18nLanguage'];
    resolvePreviewTableInfo: TableDesignerStateApi['resolvePreviewTableInfo'];
    resolveTableInfo: TableDesignerStateApi['resolveTableInfo'];
    setTriggerEditMode: TableDesignerStateApi['setTriggerEditMode'];
    setTriggerEditSql: TableDesignerStateApi['setTriggerEditSql'];
    setIsTriggerEditModalOpen: TableDesignerStateApi['setIsTriggerEditModalOpen'];
    selectedTrigger: TableDesignerStateApi['selectedTrigger'];
    setActiveContext: TableDesignerStateApi['setActiveContext'];
    addTab: TableDesignerStateApi['addTab'];
    setSelectedTrigger: TableDesignerStateApi['setSelectedTrigger'];
    executeSchemaStatements: (sqlText: string, options?: SchemaExecutionOptions) => Promise<SchemaExecutionResult>;
    fetchData: TableDesignerDataLoadApi['fetchData'];
}

export const useTableDesignerTriggerList = ({
    normalizeDbType, getDbType, tab, schemaLoadSeqRef, schemaContextKeyRef, latestSelectedSchemaRef,
    setSchemaOptions, setSelectedSchema, setSchemaSelectionOverride, setSchemaReady,
    setSchemaLoading, connections, tableDesignerSchemaByConnection, setTableDesignerSchema,
    selectedSchema, isNewTable, setColumns, setOriginalColumns, setIndexes, setFks, setTriggers,
    setDdl, setSelectedColumnRowKeys, hasUnsavedDraftChanges, i18nLanguage, resolvePreviewTableInfo,
    resolveTableInfo, setTriggerEditMode, setTriggerEditSql, setIsTriggerEditModalOpen,
    selectedTrigger, setActiveContext, addTab, setSelectedTrigger, executeSchemaStatements,
    fetchData,
}: UseTableDesignerTriggerListInput) => {
    const inferDialectFromCustomDriver = (driver: string): string => {
        const customDriver = normalizeDbType(driver);
        if (!customDriver) return 'custom';
        if (
            customDriver === 'mariadb'
            || customDriver === 'diros'
            || customDriver === 'sphinx'
            || customDriver === 'tidb'
            || customDriver === 'oceanbase'
            || customDriver.includes('mysql')
        ) {
            return 'mysql';
        }
        if (customDriver === 'starrocks') return 'starrocks';
        if (customDriver === 'dameng') return 'dm';
        return customDriver;
    };

    const supportsTableDesignerSchemaSelection = supportsRequestedTableDesignerSchemaSelection(getDbType());

    useEffect(() => {
        if (!supportsTableDesignerSchemaSelection) {
            schemaLoadSeqRef.current += 1;
            schemaContextKeyRef.current = '';
            latestSelectedSchemaRef.current = '';
            setSchemaOptions([]);
            setSelectedSchema('');
            setSchemaSelectionOverride(false);
            setSchemaReady(true);
            setSchemaLoading(false);
            return;
        }

        const conn = connections.find(c => c.id === tab.connectionId);
        const dbName = String(tab.dbName || '').trim();
        if (!conn || !dbName) {
            setSchemaReady(false);
            return;
        }

        const requestSeq = schemaLoadSeqRef.current + 1;
        schemaLoadSeqRef.current = requestSeq;
        const explicitSchema = stripIdentifierQuotes(
            splitQualifiedNameLast(tab.tableName || '').parentPath || tab.schemaName || '',
        );
        const rememberedSchema = tableDesignerSchemaByConnection[tab.connectionId] || '';
        const contextKey = [tab.connectionId, dbName, tab.tableName || 'new'].join('::');
        if (schemaContextKeyRef.current !== contextKey) {
            schemaContextKeyRef.current = contextKey;
            latestSelectedSchemaRef.current = explicitSchema;
            setSelectedSchema(explicitSchema);
            setSchemaSelectionOverride(false);
            setSchemaOptions(explicitSchema ? [{ label: explicitSchema, value: explicitSchema }] : []);
        }

        let cancelled = false;
        const applySchemaContext = (context: QueryEditorSchemaContext) => {
            const schemaNames = Array.from(new Map(
                context.schemaNames
                    .map(schema => String(schema || '').trim())
                    .filter(Boolean)
                    .map(schema => [schema.toLocaleLowerCase(), schema] as const),
            ).values());
            const resolved = resolveLoadedTableDesignerSchema({
                requestSeq,
                currentRequestSeq: schemaLoadSeqRef.current,
                latestSelectedSchema: latestSelectedSchemaRef.current,
                explicitSchema,
                rememberedSchema,
                currentSchema: context.defaultSchema,
                schemaNames,
            });
            if (!resolved) return;
            latestSelectedSchemaRef.current = resolved.selectedSchema;
            setSelectedSchema(resolved.selectedSchema);
            setSchemaOptions(resolved.schemaNames.map(schema => ({ label: schema, value: schema })));
            if (resolved.selectedSchema) {
                setTableDesignerSchema?.(tab.connectionId, resolved.selectedSchema);
            }
        };

        // schema 列表与查询页共用同一份会话缓存：已经加载过就直接用，不再转圈也不再发请求；
        // 过期的先用着，后台刷新。
        const schemaSessionKey = buildQueryEditorSessionMetadataKey(tab.connectionId, { ...conn.config, schemaVisibilityByDatabase: conn.schemaVisibilityByDatabase }, dbName);
        const cachedSchemaContext = queryEditorSchemaContextSession.read(schemaSessionKey);
        if (cachedSchemaContext) {
            applySchemaContext(cachedSchemaContext.value);
            setSchemaReady(true);
            setSchemaLoading(false);
            if (!cachedSchemaContext.stale) {
                return () => {
                    cancelled = true;
                };
            }
        } else {
            setSchemaReady(false);
            setSchemaLoading(true);
        }
        const blocksOnSchemaLoad = !cachedSchemaContext;

        void queryEditorSchemaContextSession.load({
            key: schemaSessionKey,
            scope: buildQueryEditorSessionMetadataScope(tab.connectionId, dbName),
            fetch: () => fetchQueryEditorSchemaContext(conn, dbName),
        }).promise
            .then((result) => {
                if (cancelled || !result) return;
                applySchemaContext(result.value);
            })
            .catch(() => {
                if (cancelled || !blocksOnSchemaLoad || requestSeq !== schemaLoadSeqRef.current) return;
                const fallback = latestSelectedSchemaRef.current || explicitSchema;
                setSelectedSchema(fallback);
                setSchemaOptions(fallback ? [{ label: fallback, value: fallback }] : []);
            })
            .finally(() => {
                if (blocksOnSchemaLoad && !cancelled && requestSeq === schemaLoadSeqRef.current) {
                    setSchemaReady(true);
                    setSchemaLoading(false);
                }
            });

        return () => {
            cancelled = true;
        };
    }, [connections, supportsTableDesignerSchemaSelection, tab.connectionId, tab.dbName, tab.schemaName, tab.tableName]);

    const handleSchemaChange = (schemaName: string) => {
        const nextSchema = String(schemaName || '').trim();
        if (!nextSchema || nextSchema === selectedSchema) return;
        const applySchema = () => {
            if (!isNewTable) {
                setColumns([]);
                setOriginalColumns([]);
                setIndexes([]);
                setFks([]);
                setTriggers([]);
                setDdl('');
                setSelectedColumnRowKeys([]);
            }
            latestSelectedSchemaRef.current = nextSchema;
            setSelectedSchema(nextSchema);
            setSchemaSelectionOverride(!isNewTable);
            setTableDesignerSchema?.(tab.connectionId, nextSchema);
        };
        if (hasUnsavedDraftChanges) {
            Modal.confirm({
                title: t('table_designer.modal.unsaved_changes_title', undefined, i18nLanguage),
                icon: <ExclamationCircleOutlined />,
                content: t('table_designer.modal.unsaved_changes_content', undefined, i18nLanguage),
                okText: t('table_designer.action.refresh_anyway', undefined, i18nLanguage),
                cancelText: t('table_designer.action.cancel', undefined, i18nLanguage),
                onOk: applySchema,
            });
            return;
        }
        applySchema();
    };

    const generateTriggerTemplate = (): string => {
      const preview = resolvePreviewTableInfo();
      return buildTableDesignerTriggerTemplate(getDbType(), preview.tableRef);
    };

    const buildDropTriggerSql = (triggerName: string): string => {
      const dbType = getDbType();
      const tableInfo = resolveTableInfo();
      const tblName = tableInfo.tableRef || (
          supportsRequestedTableDesignerSchemaSelection(dbType)
            ? tableInfo.qualifiedName
            : (tab.tableName || '')
      );

      return buildTableDesignerTriggerDropSql(triggerName, tblName, dbType, tableInfo.schema);
    };

    const handleCreateTrigger = () => {
      setTriggerEditMode('create');
      setTriggerEditSql(generateTriggerTemplate());
      setIsTriggerEditModalOpen(true);
    };

    const handleEditTrigger = () => {
      if (!selectedTrigger) return;
      if (isNewTable) {
        setTriggerEditMode('edit');
        setTriggerEditSql(selectedTrigger.statement || generateTriggerTemplate());
        setIsTriggerEditModalOpen(true);
        return;
      }
      const dbType = getDbType();
      const tableInfo = resolveTableInfo();
      const tblName = tableInfo.tableRef || (
          supportsRequestedTableDesignerSchemaSelection(dbType)
            ? tableInfo.qualifiedName
            : (tab.tableName || '')
      );
      let createSql = '';

      const triggerRollbackSql = buildTableDesignerTriggerRestoreSql(selectedTrigger, tblName, dbType, tableInfo.schema);
      createSql = triggerRollbackSql
        || selectedTrigger.statement
        || '-- Trigger definition unavailable';
      const triggerDropSql = shouldDropTableDesignerTriggerBeforeReplace(triggerRollbackSql, dbType)
        ? buildDropTriggerSql(selectedTrigger.name)
        : '';

      const dbName = String(tab.dbName || '').trim();
      const schemaName = String(selectedSchema || tab.schemaName || '').trim();
      setActiveContext({
        connectionId: tab.connectionId,
        dbName,
        schemaName: schemaName || undefined,
      });
      addTab({
        id: `query-edit-trigger-${tab.connectionId}-${dbName}-${tab.tableName || ''}-${selectedTrigger.name}-${Date.now()}`,
        title: t('table_designer.tab.edit_trigger_title', { name: selectedTrigger.name }, i18nLanguage),
        type: 'query',
        connectionId: tab.connectionId,
        dbName,
        schemaName: schemaName || undefined,
        query: buildEditableTriggerSql(selectedTrigger.name, createSql, {
          dropSql: triggerDropSql,
          dbType,
        }),
        triggerName: selectedTrigger.name,
        triggerTableName: tblName,
        triggerRollbackSql: triggerRollbackSql || undefined,
        queryMode: 'object-edit',
      });
    };

    const handleDeleteTrigger = () => {
      if (!selectedTrigger) return;

      Modal.confirm({
        title: t('table_designer.modal.delete_trigger_title', undefined, i18nLanguage),
        icon: <ExclamationCircleOutlined />,
        content: t('table_designer.modal.delete_trigger_content', { name: selectedTrigger.name }, i18nLanguage),
        okText: t('table_designer.action.delete', undefined, i18nLanguage),
        okType: 'danger',
        cancelText: t('table_designer.action.cancel', undefined, i18nLanguage),
        onOk: async () => {
          if (isNewTable) {
            setTriggers((previous) => removeTriggerDraftByName(previous, selectedTrigger.name));
            setSelectedTrigger(null);
            message.success(t('table_designer.message.trigger_deleted_draft', undefined, i18nLanguage));
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
            target: [tab.dbName, selectedTrigger.name].filter(Boolean).join(' / '),
            translate: (key, params) => t(key, params, i18nLanguage),
          });
          if (!approved) return;

          const dropSql = buildDropTriggerSql(selectedTrigger.name);

          try {
            const result = await executeSchemaStatements(dropSql, {
              skipProductionRiskConfirm: true,
            });
            if (result.ok) {
              setSelectedTrigger(null);
              await fetchData();
              message.success(t('table_designer.message.trigger_deleted', undefined, i18nLanguage));
            } else {
              if (result.schemaMayHaveChanged) await fetchData();
              message.error(t('table_designer.message.delete_failed', {
                detail: result.rawMessage || result.message,
              }, i18nLanguage));
            }
          } catch (e: any) {
            message.error(t('table_designer.message.delete_failed', { detail: e?.message || String(e) }, i18nLanguage));
          }
        }
      });
    };
    return {
        supportsTableDesignerSchemaSelection, handleSchemaChange, buildDropTriggerSql,
        handleCreateTrigger, handleEditTrigger, handleDeleteTrigger,
    };
};

export type TableDesignerTriggerListApi = ReturnType<typeof useTableDesignerTriggerList>;
