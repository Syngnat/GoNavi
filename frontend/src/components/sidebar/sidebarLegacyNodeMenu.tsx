import { Input, message, type MenuProps } from 'antd';
import Modal from '../common/ResizableDraggableModal';
import {
  AppstoreOutlined,
  CheckSquareOutlined,
  CloudOutlined,
  CodeOutlined,
  ConsoleSqlOutlined,
  CopyOutlined,
  DashboardOutlined,
  DatabaseOutlined,
  DeleteOutlined,
  DisconnectOutlined,
  EditOutlined,
  ExportOutlined,
  EyeOutlined,
  FileAddOutlined,
  FileTextOutlined,
  FolderAddOutlined,
  FolderOpenOutlined,
  FolderOutlined,
  KeyOutlined,
  LinkOutlined,
  PlusOutlined,
  ReloadOutlined,
  SaveOutlined,
  SendOutlined,
  SafetyCertificateOutlined,
  TableOutlined,
  ThunderboltOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { t } from '../../i18n';
import { useStore } from '../../store';
import type { SavedConnection, SavedQuery, SavedQueryGroup } from '../../types';
import { getDataSourceCapabilities } from '../../utils/dataSourceCapabilities';
import { resolveTableSelectQuery } from '../../utils/objectQueryTemplates';
import {
  buildSavedQueryGroupPath,
  getSavedQueryGroupOwnerIds,
} from '../../utils/savedQueryGroups';
import {
  MAX_REDIS_DB_ALIAS_LENGTH,
  buildRedisDbNodeLabel,
  getRedisDbAlias,
} from '../../utils/redisDbAlias';
import { buildRpcConnectionConfig } from '../../utils/connectionRpcConfig';
import { supportsTableTruncateAction } from '../tableDataDangerActions';
import { noAutoCapInputProps } from '../../utils/inputAutoCap';
import { confirmProductionMutation } from '../../utils/productionRiskConfirm';
import {
  buildNacosServicesTabData,
  resolveNacosNamespaceDiscoveryModeFromTreeNode,
  type NacosNamespaceDiscoveryMode,
} from '../sidebarV2Utils';
import { getConnectionHealthGroupConnectionIds } from '../../utils/connectionHealth';

type NacosNamespaceFormMode = 'create' | 'edit';

const isNacosNamespaceStructureRestricted = (config: SavedConnection['config'] | undefined) =>
  config?.readOnly === true || config?.protection?.restrictStructureEdit === true;

const resolveCurrentNacosConnection = (connection: SavedConnection): SavedConnection => {
  const current = useStore.getState().connections.find((item) => item.id === connection.id);
  return current || connection;
};

const assertNacosNamespaceStructureEditable = (connection: SavedConnection) => {
  const current = resolveCurrentNacosConnection(connection);
  if (!isNacosNamespaceStructureRestricted(current.config)) {
    return current;
  }
  const error = new Error(t('nacos.backend.error.read_only'));
  message.error(error.message);
  throw error;
};

const resolveCurrentNacosNamespaceDiscoveryMode = (
  connectionId: unknown,
  node: any,
  resolver?: (id: string) => unknown,
): NacosNamespaceDiscoveryMode | undefined => {
  const liveMode = resolver?.(String(connectionId || ''));
  if (liveMode === 'listed' || liveMode === 'configured') {
    return liveMode;
  }
  return resolveNacosNamespaceDiscoveryModeFromTreeNode(node);
};

const assertNacosNamespaceDiscoveryAllowsCrud = (
  isBlocked: (() => boolean) | undefined,
) => {
  if (!isBlocked?.()) return;
  const error = new Error(t('nacos.backend.error.read_only'));
  message.error(error.message);
  throw error;
};

const openNacosNamespaceFormModal = (options: {
  mode: NacosNamespaceFormMode;
  connection: SavedConnection;
  initial?: { id?: string; showName?: string; description?: string };
  onSuccess?: () => void | Promise<void>;
  isNamespaceManagementBlocked?: () => boolean;
}) => {
  if (
    options.isNamespaceManagementBlocked?.() ||
    isNacosNamespaceStructureRestricted(
      resolveCurrentNacosConnection(options.connection).config,
    )
  ) {
    return;
  }
  const draft = {
    id: String(options.initial?.id || ''),
    showName: String(options.initial?.showName || ''),
    description: String(options.initial?.description || ''),
  };
  const isEdit = options.mode === 'edit';
  Modal.confirm({
    title: isEdit ? t('nacos.namespace.menu.edit') : t('nacos.namespace.menu.create'),
    icon: null,
    width: 480,
    content: (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 8 }}>
        <div>
          <div style={{ marginBottom: 4 }}>{t('nacos.namespace.field.id')}</div>
          <Input
            {...noAutoCapInputProps}
            disabled={isEdit}
            defaultValue={draft.id}
            placeholder="optional"
            onChange={(event) => {
              draft.id = event.target.value;
            }}
          />
        </div>
        <div>
          <div style={{ marginBottom: 4 }}>{t('nacos.namespace.field.name')}</div>
          <Input
            {...noAutoCapInputProps}
            defaultValue={draft.showName}
            onChange={(event) => {
              draft.showName = event.target.value;
            }}
          />
        </div>
        <div>
          <div style={{ marginBottom: 4 }}>{t('nacos.namespace.field.desc')}</div>
          <Input.TextArea
            {...noAutoCapInputProps}
            rows={3}
            defaultValue={draft.description}
            onChange={(event) => {
              draft.description = event.target.value;
            }}
          />
        </div>
      </div>
    ),
    okText: t('common.confirm'),
    cancelText: t('common.cancel'),
    onOk: async () => {
      assertNacosNamespaceDiscoveryAllowsCrud(
        options.isNamespaceManagementBlocked,
      );
      const currentConnection = assertNacosNamespaceStructureEditable(options.connection);
      const showName = draft.showName.trim();
      if (!showName) {
        message.error(t('nacos.backend.error.namespace_name_required'));
        throw new Error('namespace name required');
      }
      const rpcConfig = buildRpcConnectionConfig(currentConnection.config as any);
      if (!await confirmProductionMutation(
        currentConnection,
        t('connection.production_risk.action.modify_configuration'),
        [draft.id.trim(), showName].filter(Boolean).join(' / '),
        t,
      )) return;
      if (isEdit) {
        const res = await (window as any).go.app.App.NacosUpdateNamespace(rpcConfig, {
          id: draft.id.trim(),
          showName,
          description: draft.description.trim(),
        });
        if (!res?.success) {
          message.error(res?.message || 'update failed');
          throw new Error(res?.message || 'update failed');
        }
      } else {
        const res = await (window as any).go.app.App.NacosCreateNamespace(rpcConfig, {
          id: draft.id.trim(),
          showName,
          description: draft.description.trim(),
        });
        if (!res?.success) {
          message.error(res?.message || 'create failed');
          throw new Error(res?.message || 'create failed');
        }
      }
      await options.onSuccess?.();
      message.success(t(isEdit
        ? 'nacos.namespace.message.update_success'
        : 'nacos.namespace.message.create_success'));
    },
  });
};

const updateRedisDbNodeAlias = (
  nodes: any[],
  targetKey: string,
  title: string,
  alias: string,
): any[] =>
  nodes.map((node) => {
    if (node.key === targetKey) {
      return {
        ...node,
        title,
        dataRef: {
          ...(node.dataRef || {}),
          redisDbAlias: alias,
        },
      };
    }
    if (Array.isArray(node.children)) {
      return { ...node, children: updateRedisDbNodeAlias(node.children, targetKey, title, alias) };
    }
    return node;
  });

const openRedisDbAliasModal = (
  node: any,
  context: SidebarLegacyNodeMenuContext,
): void => {
  const { id, redisDB } = node.dataRef;
  const { treeDataRef, setTreeData } = context;
  const currentAlias = getRedisDbAlias(
    useStore.getState().appearance.redisDbAliases,
    id,
    redisDB,
  );
  let draft = currentAlias;
  Modal.confirm({
    title: t('redis.db_alias.modal.title', { db: `db${redisDB}` }),
    icon: null,
    content: (
      <Input
        defaultValue={currentAlias}
        maxLength={MAX_REDIS_DB_ALIAS_LENGTH}
        placeholder={t('redis.db_alias.modal.placeholder')}
        onChange={(event) => {
          draft = event.target.value;
        }}
        onPressEnter={(event) => {
          draft = (event.target as HTMLInputElement).value;
        }}
      />
    ),
    okText: t('common.confirm'),
    cancelText: t('common.cancel'),
    onOk: () => {
      useStore.getState().setRedisDbAlias(id, redisDB, draft);
      if (treeDataRef?.current && typeof setTreeData === 'function') {
        const nextAlias = getRedisDbAlias(
          useStore.getState().appearance.redisDbAliases,
          id,
          redisDB,
        );
        const nextTitle = buildRedisDbNodeLabel(redisDB, nextAlias);
        const nextTree = updateRedisDbNodeAlias(treeDataRef.current, node.key, nextTitle, nextAlias);
        treeDataRef.current = nextTree;
        setTreeData(nextTree);
      }
    },
  });
};

type TreeNode = {
  type?: string;
  title?: string;
  key?: string;
  dataRef?: any;
  children?: TreeNode[];
  [key: string]: any;
};

export type SidebarLegacyNodeMenuContext = Record<string, any>;

export const buildSidebarLegacyNodeMenuItems = (
  node: any,
  context: SidebarLegacyNodeMenuContext,
): MenuProps['items'] => {
  const {
    addTab,
    getMetadataDialect,
    shouldHideSchemaPrefix,
    openSchemaVisibilitySettings,
    handleV2DatabaseContextMenuAction,
    isPostgresSchemaDialect,
    handleExportSchemaSQL,
    openRenameSchemaModal,
    loadTables,
    getDatabaseNodeRef,
    handleDeleteSchema,
    tableSortPreference,
    isStructureOnlyDbType,
    openNewTableDesign,
    handleTableGroupSortAction,
    openCreateView,
    openCreateStarRocksMaterializedView,
    openCreateRoutine,
    createTagForm,
    setRenameViewTarget,
    setIsCreateTagModalOpen,
    removeConnectionTag,
    onCreateConnectionInGroup,
    onOpenConnectionHealthForGroup,
    setExpandedKeys,
    setLoadedKeys,
    loadingNodesRef,
    loadDatabases,
    refreshConnectionResources: refreshConnectionResourcesFromContext,
    buildConnectionRootRedisCommandTabTitle,
    buildConnectionRootRedisMonitorTabTitle,
    onEditConnection,
    handleDuplicateConnection,
    disconnectConnectionNode,
    deleteConnectionNode,
    connectionTags,
    moveConnectionToTag,
    setTargetConnection,
    setIsCreateDbModalOpen,
    buildConnectionRootQueryTabTitle,
    handleRunSQLFile,
    openCreateStarRocksExternalCatalog,
    openEditView,
    renameViewForm,
    setIsRenameViewModalOpen,
    handleDropView,
    onDoubleClick,
    openViewDefinition,
    openRoutineDefinition,
    openEditRoutine,
    handleDropRoutine,
    handleCompileOracleObject,
    openEventDefinition,
    openEditEvent,
    openSequenceDefinition,
    openPackageDefinition,
    resolveMessagePublishTarget,
    openMessagePublishModal,
    openDesign,
    openCreateStarRocksRollup,
    handleCopyTableName,
    handleCopyTable,
    handleCopyStructure,
    handleExport,
    setRenameTableTarget,
    renameTableForm,
    setIsRenameTableModalOpen,
    handleTableDataDangerAction,
    handleDeleteTable,
    openExportDialog,
    openBatchTableWorkbench,
    openBatchDatabaseWorkbench,
    isSavedQueryUnmatched,
    connections,
    handleRebindSavedQuery,
    openRenameSavedQueryModal,
    handleRevealSavedQueryInFolder,
    resolveSavedQueryDisplayName,
    deleteQuery,
    savedQueryGroups,
    openSavedQueryGroupModal,
    deleteSavedQueryGroup,
    moveSavedQueryToGroup,
    treeDataRef,
    getNacosNamespaceDiscoveryMode,
    setTreeData,
    handleAddExternalSQLDirectory,
    openCreateExternalSQLFileModal,
    openCreateExternalSQLDirectoryModal,
    openRenameExternalSQLDirectoryModal,
    handleRefreshExternalSQLDirectory,
    handleDeleteExternalSQLDirectory,
    handleRemoveExternalSQLDirectory,
    openExternalSQLFile,
    openExternalSQLBindingModal,
    openRenameExternalSQLFileModal,
    handleDeleteExternalSQLFile,
    extractObjectName,
  } = context;
    const refreshConnectionResources = refreshConnectionResourcesFromContext || ((targetNode: any) => {
      loadDatabases(targetNode);
      return Promise.resolve();
    });
    const conn = node.dataRef as SavedConnection;
    const isRedis = conn?.config?.type === 'redis';
    const isNacos = conn?.config?.type === 'nacos';

    if (node.type === 'object-group' && node.dataRef?.groupKey === 'schema') {
        const dialect = getMetadataDialect(node.dataRef as SavedConnection);
        const schemaName = String(node?.dataRef?.schemaName || '').trim();
        if (!isPostgresSchemaDialect(dialect) || !schemaName) {
            return [];
        }
        return [
            {
                key: 'rename-schema',
                label: t('sidebar.menu.edit_schema'),
                icon: <EditOutlined />,
                onClick: () => openRenameSchemaModal(node)
            },
            {
                key: 'refresh-schema',
                label: t('sidebar.menu.refresh'),
                icon: <ReloadOutlined />,
                onClick: () => void loadTables(
                    getDatabaseNodeRef(node.dataRef, node.dataRef.dbName),
                    { ensureFresh: true },
                )
            },
            {
                key: 'export-schema',
                label: t('sidebar.menu.export_current_schema_sql'),
                icon: <ExportOutlined />,
                onClick: () => void handleExportSchemaSQL(node, false)
            },
            {
                key: 'backup-schema-sql',
                label: t('sidebar.menu.backup_current_schema_sql'),
                icon: <SaveOutlined />,
                onClick: () => void handleExportSchemaSQL(node, true)
            },
            { type: 'divider' },
            {
                key: 'drop-schema',
                label: t('sidebar.menu.delete_schema'),
                icon: <DeleteOutlined />,
                danger: true,
                onClick: () => handleDeleteSchema(node)
            },
        ];
    }

    // 表分组节点的右键菜单
    if (node.type === 'object-group' && node.dataRef?.groupKey === 'tables') {
        const groupData = node.dataRef; // { ...conn, dbName, groupKey }
        const sortPreferenceKey = `${groupData.id}-${groupData.dbName}`;
        const currentSort = tableSortPreference[sortPreferenceKey] || 'name';
        const canCreateTable = !isStructureOnlyDbType(String(groupData.id || ''));

        return [
            ...(canCreateTable ? [{
                key: 'new-table',
                label: t('sidebar.menu.new_table'),
                icon: <TableOutlined />,
                onClick: () => openNewTableDesign(node)
            }] : []),
            {
                key: 'refresh-tables',
                label: t('sidebar.menu.refresh'),
                icon: <ReloadOutlined />,
                onClick: () => {
                    const dbNode = {
                        key: `${groupData.id}-${groupData.dbName}`,
                        dataRef: groupData,
                    };
                    void loadTables(dbNode);
                },
            },
            { type: 'divider' },
            {
                key: 'sort-by-name',
                label: t('sidebar.menu.sort_by_name'),
                icon: currentSort === 'name' ? <CheckSquareOutlined /> : null,
                onClick: () => handleTableGroupSortAction(node, 'name')
            },
            {
                key: 'sort-by-frequency',
                label: t('sidebar.menu.sort_by_frequency'),
                icon: currentSort === 'frequency' ? <CheckSquareOutlined /> : null,
                onClick: () => handleTableGroupSortAction(node, 'frequency')
            }
        ];
    }

    // 视图分组节点的右键菜单
    if (node.type === 'object-group' && node.dataRef?.groupKey === 'views') {
        return [
            {
                key: 'create-view',
                label: t('sidebar.menu.create_view'),
                icon: <PlusOutlined />,
                onClick: () => openCreateView(node)
            },
        ];
    }

    if (node.type === 'object-group' && node.dataRef?.groupKey === 'materializedViews') {
        return [
            {
                key: 'create-materialized-view',
                label: t('sidebar.v2_database_menu.new_materialized_view'),
                icon: <PlusOutlined />,
                onClick: () => openCreateStarRocksMaterializedView(node)
            },
        ];
    }

    // 函数分组节点的右键菜单
    if (node.type === 'object-group' && node.dataRef?.groupKey === 'routines') {
        const dialect = getMetadataDialect(node.dataRef as SavedConnection);
        const routineMenu: MenuProps['items'] = [
            {
                key: 'create-function',
                label: t('sidebar.tab.create_function'),
                icon: <PlusOutlined />,
                onClick: () => openCreateRoutine(node, 'FUNCTION')
            },
        ];
        if (dialect !== 'duckdb') {
            routineMenu.push({
                key: 'create-procedure',
                label: t('sidebar.tab.create_procedure'),
                icon: <PlusOutlined />,
                onClick: () => openCreateRoutine(node, 'PROCEDURE')
            });
        }
        return routineMenu;
    }

    if (node.type === 'object-group' && node.dataRef?.groupKey === 'events') {
        return [
            {
                key: 'create-event-query',
                label: t('sidebar.menu.create_event'),
                icon: <PlusOutlined />,
                onClick: () => {
                    addTab({
                        id: `query-create-event-${Date.now()}`,
                        title: t('sidebar.tab.new_event'),
                        type: 'query',
                        connectionId: node.dataRef.id,
                        dbName: node.dataRef.dbName,
                        query: `CREATE EVENT event_name\nON SCHEDULE EVERY 1 DAY\nDO\nBEGIN\n    -- event body\nEND;`
                    });
                }
            },
        ];
    }

    // Connection Tag Menu — must be BEFORE the connection check
    if (node.type === 'tag') {
        const tagId = String(node.dataRef?.id || '').trim();
        const hasConnectionsForHealthCheck = tagId !== ''
            && Array.isArray(connectionTags)
            && Array.isArray(connections)
            && getConnectionHealthGroupConnectionIds(connectionTags, tagId, connections).length > 0;
        const tagPrimaryItems: NonNullable<MenuProps['items']> = [
            ...(tagId && typeof onCreateConnectionInGroup === 'function' ? [
                {
                    key: 'new-connection-in-tag',
                    label: t('connection.new'),
                    icon: <PlusOutlined />,
                    onClick: () => onCreateConnectionInGroup?.(tagId),
                },
            ] : []),
            ...(tagId && typeof onOpenConnectionHealthForGroup === 'function' ? [
                {
                    key: 'connection-health',
                    label: t('connection_health.action.open'),
                    icon: <SafetyCertificateOutlined />,
                    disabled: !hasConnectionsForHealthCheck,
                    onClick: () => onOpenConnectionHealthForGroup?.(tagId),
                },
            ] : []),
        ];
        return [
            ...tagPrimaryItems,
            ...(tagPrimaryItems.length > 0 ? [{ type: 'divider' as const }] : []),
            {
                key: 'edit-tag',
                label: t('sidebar.menu.edit_tag'),
                icon: <EditOutlined />,
                onClick: () => {
                    createTagForm.setFieldsValue({
                        name: node.title,
                        parentTagId: node.dataRef.parentTagId,
                        connectionIds: node.dataRef.connectionIds,
                    });
                    setRenameViewTarget(node);
                    setIsCreateTagModalOpen(true);
                }
            },
            {
                key: 'new-child-tag',
                label: t('connection.sidebar.group.newSubgroup'),
                icon: <FolderAddOutlined />,
                onClick: () => {
                    createTagForm.resetFields();
                    createTagForm.setFieldsValue({
                        parentTagId: node.dataRef.id,
                        connectionIds: [],
                    });
                    setRenameViewTarget(null);
                    setIsCreateTagModalOpen(true);
                }
            },
            { type: 'divider' },
            {
                key: 'delete-tag',
                label: t('sidebar.menu.delete_tag'),
                icon: <DeleteOutlined />,
                danger: true,
                onClick: () => {
                    Modal.confirm({
                        title: t('sidebar.modal.confirm_delete.title'),
                        content: t('sidebar.modal.confirm_delete_tag.content', { name: node.title }),
                        onOk: () => {
                            removeConnectionTag(node.dataRef.id);
                        }
                    });
                }
            }
        ];
    }

    if (node.type === 'connection') {
        // Redis connection menu
        if (isRedis) {
            return [
                {
                    key: 'refresh',
                    label: t('sidebar.menu.refresh'),
                    icon: <ReloadOutlined />,
                    onClick: () => {
                        void refreshConnectionResources(node);
                    }
                },
                { type: 'divider' },
                {
                    key: 'new-command',
                    label: t('sidebar.menu.new_command_window'),
                    icon: <ConsoleSqlOutlined />,
                    onClick: () => {
                        addTab({
                            id: `redis-cmd-${node.key}-${Date.now()}`,
                            title: buildConnectionRootRedisCommandTabTitle(),
                            type: 'redis-command',
                            connectionId: node.key,
                            redisDB: 0
                        });
                    }
                },
                {
                    key: 'open-monitor',
                    label: t('redis_monitor.title.instance'),
                    icon: <DashboardOutlined />,
                    onClick: () => {
                        addTab({
                            id: `redis-monitor-${node.key}-${Date.now()}`,
                            title: buildConnectionRootRedisMonitorTabTitle(),
                            type: 'redis-monitor',
                            connectionId: node.key,
                            redisDB: 0
                        });
                    }
                },
                { type: 'divider' },
                {
                    key: 'edit',
                    label: t('sidebar.menu.edit_connection'),
                    icon: <EditOutlined />,
                    onClick: () => {
                        if (onEditConnection) onEditConnection(node.dataRef);
                    }
                },
                {
                    key: 'copy-connection',
                    label: t('connection.sidebar.menu.copy'),
                    icon: <CopyOutlined />,
                    onClick: () => handleDuplicateConnection(node.dataRef as SavedConnection)
                },
                {
                    key: 'disconnect',
                    label: t('connection.sidebar.menu.disconnect'),
                    icon: <DisconnectOutlined />,
                    onClick: () => void disconnectConnectionNode(node)
                },
                {
                    key: 'delete',
                    label: t('connection.sidebar.menu.delete'),
                    icon: <DeleteOutlined />,
                    danger: true,
                    onClick: () => deleteConnectionNode(node)
                }
            ];
        }

        if (isNacos) {
            const nacosStructureRestricted = isNacosNamespaceStructureRestricted(
                resolveCurrentNacosConnection(conn).config,
            );
            const isNamespaceManagementBlocked = () =>
                resolveCurrentNacosNamespaceDiscoveryMode(
                    conn.id,
                    node,
                    getNacosNamespaceDiscoveryMode,
                ) === 'configured';
            const usesConfiguredNacosNamespace =
                isNamespaceManagementBlocked();
            return [
                {
                    key: 'refresh',
                    label: t('sidebar.menu.refresh'),
                    icon: <ReloadOutlined />,
                    onClick: () => {
                        void refreshConnectionResources(node);
                    },
                },
                {
                    key: 'create-nacos-namespace',
                    label: t('nacos.namespace.menu.create'),
                    icon: <PlusOutlined />,
                    disabled:
                        nacosStructureRestricted || usesConfiguredNacosNamespace,
                    onClick: () => {
                        if (isNamespaceManagementBlocked()) return;
                        const currentConnection = resolveCurrentNacosConnection(
                            node.dataRef as SavedConnection,
                        );
                        if (isNacosNamespaceStructureRestricted(currentConnection.config)) return;
                        openNacosNamespaceFormModal({
                            mode: 'create',
                            connection: currentConnection,
                            onSuccess: () => loadDatabases(node, { ensureFresh: true }),
                            isNamespaceManagementBlocked,
                        });
                    },
                },
                { type: 'divider' },
                {
                    key: 'edit',
                    label: t('sidebar.menu.edit_connection'),
                    icon: <EditOutlined />,
                    onClick: () => {
                        if (onEditConnection) onEditConnection(node.dataRef);
                    },
                },
                {
                    key: 'copy-connection',
                    label: t('connection.sidebar.menu.copy'),
                    icon: <CopyOutlined />,
                    onClick: () => handleDuplicateConnection(node.dataRef as SavedConnection),
                },
                {
                    key: 'disconnect',
                    label: t('connection.sidebar.menu.disconnect'),
                    icon: <DisconnectOutlined />,
                    onClick: () => void disconnectConnectionNode(node),
                },
                {
                    key: 'delete',
                    label: t('connection.sidebar.menu.delete'),
                    icon: <DeleteOutlined />,
                    danger: true,
                    onClick: () => deleteConnectionNode(node),
                },
            ];
        }

        // Tag submenu for connection
        const tagSubMenuItems: NonNullable<MenuProps['items']> = connectionTags.map((tag: any) => ({
            key: `move-to-tag-${tag.id}`,
            label: tag.name,
            icon: <FolderOutlined />,
            onClick: () => moveConnectionToTag(node.key, tag.id)
        }));
        if (connectionTags.length > 0) {
            tagSubMenuItems.push({ type: 'divider' });
        }
        tagSubMenuItems.push({
            key: 'move-to-ungrouped',
            label: t('connection.sidebar.menu.moveOutTag'),
            onClick: () => moveConnectionToTag(node.key, null)
        });

        // Regular database connection menu
        const connectionCapabilities = getDataSourceCapabilities((node.dataRef as SavedConnection)?.config);
        return [
            ...(connectionCapabilities.supportsCreateDatabase ? [{
                key: 'new-db',
                label: t('connection.sidebar.menu.createDatabase'),
                icon: <DatabaseOutlined />,
                onClick: () => {
                    setTargetConnection(node);
                    setIsCreateDbModalOpen(true);
                }
            }] : []),
            {
                key: 'refresh',
                label: t('sidebar.menu.refresh'),
                icon: <ReloadOutlined />,
                onClick: () => {
                    void refreshConnectionResources(node);
                }
            },
            { type: 'divider' },
             ...(connectionCapabilities.supportsQueryEditor ? [
                 {
                   key: 'new-query',
                   label: t('sidebar.menu.new_query'),
                   icon: <ConsoleSqlOutlined />,
                   onClick: () => {
                       addTab({
                           id: `query-${Date.now()}`,
                           title: buildConnectionRootQueryTabTitle(),
                           type: 'query',
                           connectionId: node.key,
                           dbName: undefined,
                           query: ''
                       });
                   }
                 },
                 {
                     key: 'open-sql-file',
                     label: t('sidebar.sql_file_exec.title'),
                     icon: <FileAddOutlined />,
                     onClick: () => handleRunSQLFile(node)
                 },
             ] : []),
             { type: 'divider' },
             {
                 key: 'edit',
                 label: t('sidebar.menu.edit_connection'),
                 icon: <EditOutlined />,
                 onClick: () => {
                     if (onEditConnection) onEditConnection(node.dataRef);
                 }
             },
             {
                 key: 'copy-connection',
                 label: t('connection.sidebar.menu.copy'),
                 icon: <CopyOutlined />,
                 onClick: () => handleDuplicateConnection(node.dataRef as SavedConnection)
             },
             {
                 key: 'move-to-tag',
                 label: t('connection.sidebar.menu.moveToTag'),
                 icon: <FolderOpenOutlined />,
                 children: tagSubMenuItems
             },
             {
                 key: 'disconnect',
                 label: t('connection.sidebar.menu.disconnect'),
                 icon: <DisconnectOutlined />,
                 onClick: () => void disconnectConnectionNode(node)
             },
             {
                 key: 'delete',
                 label: t('connection.sidebar.menu.delete'),
                 icon: <DeleteOutlined />,
                 danger: true,
                 onClick: () => deleteConnectionNode(node)
             }
        ];
    } else if (node.type === 'nacos-namespace') {
        const {
            id,
            nacosNamespaceId = '',
            nacosNamespaceName = '',
            config,
        } = node.dataRef || {};
        const nsName = nacosNamespaceName || nacosNamespaceId || 'public';
        const nsKey = nacosNamespaceId || 'public';
        const isPublicNs = !String(nacosNamespaceId || '').trim() || String(nacosNamespaceId).toLowerCase() === 'public';
        const namespaceConnection = { id, config } as SavedConnection;
        const nacosStructureRestricted = isNacosNamespaceStructureRestricted(
            resolveCurrentNacosConnection(namespaceConnection).config,
        );
        const isNamespaceManagementBlocked = () =>
            resolveCurrentNacosNamespaceDiscoveryMode(
                id,
                node,
                getNacosNamespaceDiscoveryMode,
            ) === 'configured';
        const usesConfiguredNacosNamespace =
            isNamespaceManagementBlocked();
        const parentConnectionNode = {
            key: id,
            type: 'connection',
            dataRef: node.dataRef,
        };
        return [
            {
                key: 'open-nacos-config',
                label: t('nacos_viewer.title.config_explorer'),
                icon: <FileTextOutlined />,
                onClick: () => {
                    addTab({
                        id: `nacos-config-${id}-ns-${nsKey}`,
                        title: nsName,
                        type: 'nacos-config',
                        connectionId: id,
                        nacosNamespaceId: nacosNamespaceId || '',
                        nacosNamespaceName: nsName,
                    });
                },
            },
            {
                key: 'open-nacos-services',
                label: t('nacos_service.title.service_explorer'),
                icon: <CloudOutlined />,
                onClick: () => {
                    addTab({
                        id: `nacos-services-${id}-ns-${nsKey}`,
                        title: `${nsName} · services`,
                        type: 'nacos-services',
                        connectionId: id,
                        nacosNamespaceId: nacosNamespaceId || '',
                        nacosNamespaceName: nsName,
                    });
                },
            },
            {
                key: 'edit-nacos-namespace',
                label: t('nacos.namespace.menu.edit'),
                icon: <EditOutlined />,
                disabled:
                    isPublicNs ||
                    nacosStructureRestricted ||
                    usesConfiguredNacosNamespace,
                onClick: () => {
                    if (isNamespaceManagementBlocked()) return;
                    const currentConnection = resolveCurrentNacosConnection(namespaceConnection);
                    if (
                        isPublicNs
                        || isNacosNamespaceStructureRestricted(currentConnection.config)
                    ) return;
                    openNacosNamespaceFormModal({
                        mode: 'edit',
                        connection: currentConnection,
                        initial: {
                            id: nacosNamespaceId || '',
                            showName: nsName,
                            description: '',
                        },
                        onSuccess: () => loadDatabases(parentConnectionNode, { ensureFresh: true }),
                        isNamespaceManagementBlocked,
                    });
                },
            },
            {
                key: 'delete-nacos-namespace',
                label: t('nacos.namespace.menu.delete'),
                icon: <DeleteOutlined />,
                danger: true,
                disabled:
                    isPublicNs ||
                    nacosStructureRestricted ||
                    usesConfiguredNacosNamespace,
                onClick: () => {
                    if (isNamespaceManagementBlocked()) return;
                    const currentConnection = resolveCurrentNacosConnection(namespaceConnection);
                    if (
                        isPublicNs
                        || isNacosNamespaceStructureRestricted(currentConnection.config)
                    ) return;
                    Modal.confirm({
                        title: t('nacos.namespace.menu.delete'),
                        content: t('nacos.namespace.message.confirm_delete', {
                            name: nsName,
                            id: nacosNamespaceId || '',
                        }),
                        okButtonProps: { danger: true },
                        onOk: async () => {
                            assertNacosNamespaceDiscoveryAllowsCrud(
                                isNamespaceManagementBlocked,
                            );
                            const latestConnection =
                                assertNacosNamespaceStructureEditable(currentConnection);
                            if (!await confirmProductionMutation(
                                latestConnection,
                                t('connection.production_risk.action.modify_configuration'),
                                [nacosNamespaceId, nsName].filter(Boolean).join(' / '),
                                t,
                            )) return;
                            const rpcConfig = buildRpcConnectionConfig(
                                latestConnection.config as any,
                            );
                            const res = await (window as any).go.app.App.NacosDeleteNamespace(
                                rpcConfig,
                                nacosNamespaceId || '',
                            );
                            if (!res?.success) {
                                message.error(res?.message || 'delete failed');
                                throw new Error(res?.message || 'delete failed');
                            }
                            await loadDatabases(parentConnectionNode, { ensureFresh: true });
                            message.success(t('nacos.namespace.message.delete_success'));
                        },
                    });
                },
            },
        ];
    } else if (node.type === 'nacos-config-entry' || node.type === 'nacos-services-entry') {
        const {
            id,
            nacosNamespaceId = '',
            nacosNamespaceName = '',
        } = node.dataRef || {};
        const nsName = nacosNamespaceName || nacosNamespaceId || 'public';
        const nsKey = nacosNamespaceId || 'public';
        const isServices = node.type === 'nacos-services-entry';
        return [
            {
                key: 'open-nacos-entry',
                label: isServices
                    ? t('nacos_service.title.service_explorer')
                    : t('nacos_viewer.action.open_all_configs'),
                icon: isServices ? <CloudOutlined /> : <FileTextOutlined />,
                onClick: () => {
                    addTab({
                        id: isServices
                            ? `nacos-services-${id}-ns-${nsKey}`
                            : `nacos-config-${id}-ns-${nsKey}`,
                        title: isServices ? `${nsName} · services` : nsName,
                        type: isServices ? 'nacos-services' : 'nacos-config',
                        connectionId: id,
                        nacosNamespaceId: nacosNamespaceId || '',
                        nacosNamespaceName: nsName,
                    });
                },
            },
        ];
    } else if (node.type === 'nacos-config-group') {
        const {
            id,
            nacosNamespaceId = '',
            nacosNamespaceName = '',
            nacosGroup = '',
            nacosAllConfigs = false,
        } = node.dataRef || {};
        const nsName = nacosNamespaceName || nacosNamespaceId || 'public';
        const nsKey = nacosNamespaceId || 'public';
        const isAll = !!nacosAllConfigs;
        const groupName = isAll ? '' : (String(nacosGroup || '').trim() || 'DEFAULT_GROUP');
        return [
            {
                key: 'open-nacos-group',
                label: isAll
                    ? t('nacos_viewer.action.open_all_configs')
                    : t('nacos_viewer.action.open_group_configs'),
                icon: <FileTextOutlined />,
                onClick: () => {
                    addTab({
                        id: isAll
                            ? `nacos-config-${id}-ns-${nsKey}`
                            : `nacos-config-${id}-ns-${nsKey}-g-${encodeURIComponent(groupName)}`,
                        title: isAll
                            ? `${nsName} · ${t('nacos_viewer.label.all')}`
                            : `${nsName} · ${groupName}`,
                        type: 'nacos-config',
                        connectionId: id,
                        nacosNamespaceId: nacosNamespaceId || '',
                        nacosNamespaceName: nsName,
                        ...(isAll ? {} : { nacosGroup: groupName }),
                    });
                },
            },
        ];
    } else if (node.type === 'nacos-service-group') {
        return [
            {
                key: 'open-nacos-service-group',
                label: t('nacos_service.title.service_explorer'),
                icon: <CloudOutlined />,
                onClick: () => addTab(buildNacosServicesTabData(node.dataRef || {})),
            },
        ];
    } else if (node.type === 'redis-db') {
        // Redis database menu
        const { id, redisDB } = node.dataRef;
        return [
            {
                key: 'open-keys',
                label: t('redis_viewer.title.key_explorer'),
                icon: <KeyOutlined />,
                onClick: () => {
                    addTab({
                        id: `redis-keys-${id}-db${redisDB}`,
                        title: `db${redisDB}`,
                        type: 'redis-keys',
                        connectionId: id,
                        redisDB: redisDB
                    });
                }
            },
            {
                key: 'new-command',
                label: t('sidebar.menu.new_command_window'),
                icon: <ConsoleSqlOutlined />,
                onClick: () => {
                    addTab({
                        id: `redis-cmd-${id}-db${redisDB}-${Date.now()}`,
                        title: buildConnectionRootRedisCommandTabTitle(`db${redisDB}`),
                        type: 'redis-command',
                        connectionId: id,
                        redisDB: redisDB
                    });
                }
            },
            {
                key: 'open-monitor',
                label: t('redis_monitor.title.instance'),
                icon: <DashboardOutlined />,
                onClick: () => {
                    addTab({
                        id: `redis-monitor-${id}-db${redisDB}-${Date.now()}`,
                        title: buildConnectionRootRedisMonitorTabTitle(`db${redisDB}`),
                        type: 'redis-monitor',
                        connectionId: id,
                        redisDB: redisDB
                    });
                }
            },
            {
                key: 'set-db-alias',
                label: t('redis.db_alias.menu.set'),
                icon: <EditOutlined />,
                onClick: () => openRedisDbAliasModal(node, context)
            }
        ];
    } else if (node.type === 'database') {
       const databaseConn = node.dataRef as SavedConnection;
       const dialect = getMetadataDialect(databaseConn);
       const capabilities = getDataSourceCapabilities(databaseConn?.config);
       const isStarRocks = dialect === 'starrocks';
       const supportsSchemaActions = isPostgresSchemaDialect(dialect);
       const supportsSchemaVisibility = typeof shouldHideSchemaPrefix === 'function'
           && shouldHideSchemaPrefix(databaseConn);
       const canCreateTable = !isStructureOnlyDbType(String(databaseConn?.id || ''));
       return [
            {
                key: 'copy-database-name',
                label: t('sidebar.menu.copy_database_name'),
                icon: <CopyOutlined />,
                onClick: () => handleV2DatabaseContextMenuAction(node, 'copy-database-name')
            },
           ...(canCreateTable ? [{
                key: 'new-table',
                label: t('sidebar.menu.create_table'),
                icon: <TableOutlined />,
                onClick: () => openNewTableDesign(node)
            }] : []),
            ...(supportsSchemaActions ? [
                {
                    key: 'new-schema',
                    label: t('sidebar.v2_database_menu.new_schema'),
                    icon: <FolderAddOutlined />,
                    onClick: () => handleV2DatabaseContextMenuAction(node, 'new-schema')
                },
            ] : []),
            ...(supportsSchemaVisibility ? [
                {
                    key: 'schema-visibility',
                    label: t('sidebar.schema_visibility.menu.manage'),
                    icon: <FolderOpenOutlined />,
                    onClick: () => openSchemaVisibilitySettings(node),
                },
            ] : []),
            ...(isStarRocks ? [
                {
                    key: 'new-materialized-view',
                    label: t('sidebar.v2_database_menu.new_materialized_view'),
                    icon: <ThunderboltOutlined />,
                    onClick: () => openCreateStarRocksMaterializedView(node)
                },
                {
                    key: 'new-external-catalog',
                    label: t('sidebar.v2_database_menu.new_external_catalog'),
                    icon: <CloudOutlined />,
                    onClick: () => openCreateStarRocksExternalCatalog(node)
                },
            ] : []),
            {
                key: 'new-query',
                label: t('sidebar.menu.new_query'),
                icon: <ConsoleSqlOutlined />,
                onClick: () => handleV2DatabaseContextMenuAction(node, 'new-query')
            },
            {
                key: 'run-sql',
                label: t('sidebar.sql_file_exec.title'),
                icon: <FileAddOutlined />,
                onClick: () => handleV2DatabaseContextMenuAction(node, 'run-sql')
            },
            { type: 'divider' },
            ...(capabilities.supportsRenameDatabase ? [{
                key: 'rename-db',
                label: t('sidebar.menu.rename_database'),
                icon: <EditOutlined />,
                onClick: () => handleV2DatabaseContextMenuAction(node, 'rename-db')
            }] : []),
            ...(capabilities.supportsDropDatabase ? [{
                key: 'danger-zone',
                label: t('sidebar.menu.danger_operations'),
                icon: <WarningOutlined />,
                children: [
                    {
                        key: 'drop-db',
                        label: t('sidebar.v2_table_menu.item_with_suffix', { label: t('sidebar.menu.delete_database'), suffix: 'DROP' }),
                        icon: <DeleteOutlined />,
                        danger: true,
                        onClick: () => handleV2DatabaseContextMenuAction(node, 'drop-db')
                    }
                ]
            }] : []),
            {
                key: 'refresh',
                label: t('sidebar.v2_database_menu.refresh_object_tree'),
                icon: <ReloadOutlined />,
                onClick: () => handleV2DatabaseContextMenuAction(node, 'refresh')
            },
            {
                key: 'export-db-schema',
                label: t('sidebar.v2_database_menu.export_all_table_schema_sql'),
                icon: <ExportOutlined />,
                onClick: () => handleV2DatabaseContextMenuAction(node, 'export-db-schema')
            },
            {
                key: 'backup-db-sql',
                label: t('sidebar.v2_database_menu.backup_all_tables_sql'),
                icon: <SaveOutlined />,
                onClick: () => handleV2DatabaseContextMenuAction(node, 'backup-db-sql')
            },
            ...(capabilities.supportsSqlQueryExport ? [
                {
                    key: 'batch-tables',
                    label: t('sidebar.action.batch_tables'),
                    icon: <AppstoreOutlined />,
                    onClick: () => handleV2DatabaseContextMenuAction(node, 'batch-tables'),
                },
                {
                    key: 'batch-databases',
                    label: t('sidebar.action.batch_databases'),
                    icon: <DatabaseOutlined />,
                    onClick: () => handleV2DatabaseContextMenuAction(node, 'batch-databases'),
                },
            ] : []),
            { type: 'divider' },
            {
                key: 'disconnect-db',
                label: t('sidebar.menu.close_database'),
                icon: <DisconnectOutlined />,
                onClick: () => handleV2DatabaseContextMenuAction(node, 'disconnect-db')
            }
       ];
    } else if (node.type === 'view') {
        return [
            {
                key: 'open-view',
                label: t('sidebar.menu.browse_view_data'),
                icon: <EyeOutlined />,
                onClick: () => onDoubleClick(null, node)
            },
            {
                key: 'view-definition',
                label: t('sidebar.menu.view_definition'),
                icon: <CodeOutlined />,
                onClick: () => openViewDefinition(node)
            },
            {
                key: 'copy-view-name',
                label: t('sidebar.menu.copy_object_name'),
                icon: <CopyOutlined />,
                onClick: () => handleCopyTableName(node)
            },
            { type: 'divider' },
            {
                key: 'edit-view',
                label: t('sidebar.menu.edit_view'),
                icon: <EditOutlined />,
                onClick: () => openEditView(node)
            },
            {
                key: 'new-query',
                label: t('sidebar.menu.new_query'),
                icon: <ConsoleSqlOutlined />,
                onClick: () => {
                    addTab({
                        id: `query-${Date.now()}`,
                        title: t('query.new'),
                        type: 'query',
                        connectionId: node.dataRef.id,
                        dbName: node.dataRef.dbName,
                        query: ''
                    });
                }
            },
            { type: 'divider' },
            {
                key: 'rename-view',
                label: t('sidebar.menu.rename_view'),
                icon: <EditOutlined />,
                onClick: () => {
                    setRenameViewTarget(node);
                    renameViewForm.setFieldsValue({ newName: extractObjectName(node.dataRef?.viewName || node.title) });
                    setIsRenameViewModalOpen(true);
                }
            },
            {
                key: 'danger-zone',
                label: t('sidebar.menu.danger_operations'),
                icon: <WarningOutlined />,
                children: [
                    {
                        key: 'drop-view',
                        label: t('sidebar.menu.delete_view'),
                        icon: <DeleteOutlined />,
                        danger: true,
                        onClick: () => handleDropView(node)
                    }
                ]
            },
        ];
    } else if (node.type === 'materialized-view') {
        return [
            {
                key: 'open-materialized-view',
                label: t('sidebar.menu.browse_materialized_view_data'),
                icon: <EyeOutlined />,
                onClick: () => onDoubleClick(null, node)
            },
            {
                key: 'materialized-view-definition',
                label: t('sidebar.menu.materialized_view_definition'),
                icon: <CodeOutlined />,
                onClick: () => openViewDefinition(node)
            },
            {
                key: 'copy-materialized-view-name',
                label: t('sidebar.menu.copy_object_name'),
                icon: <CopyOutlined />,
                onClick: () => handleCopyTableName(node)
            },
            {
                key: 'new-query',
                label: t('sidebar.menu.new_query'),
                icon: <ConsoleSqlOutlined />,
                onClick: () => {
                    void (async () => {
                        const tableName = String(node.dataRef?.tableName || node.dataRef?.viewName || '');
                        const queryTemplate = await resolveTableSelectQuery({
                            dbType: 'starrocks',
                            tableName,
                            dbName: String(node.dataRef?.dbName || ''),
                            connectionConfig: node.dataRef?.config,
                        });
                        addTab({
                            id: `query-${Date.now()}`,
                            title: t('query.new'),
                            type: 'query',
                            connectionId: node.dataRef.id,
                            dbName: node.dataRef.dbName,
                            query: queryTemplate,
                        });
                    })();
                }
            },
        ];
    } else if (node.type === 'routine') {
        const routineType = node.dataRef?.routineType || 'FUNCTION';
        const typeLabel = t(routineType === 'PROCEDURE' ? 'sidebar.object.procedure' : 'sidebar.object.function');
        const supportsOracleCompilation = getMetadataDialect(node.dataRef as SavedConnection) === 'oracle';
        return [
            {
                key: 'view-routine-def',
                label: t('sidebar.menu.view_object_definition'),
                icon: <CodeOutlined />,
                onClick: () => openRoutineDefinition(node)
            },
            {
                key: 'edit-routine',
                label: t('sidebar.menu.edit_definition'),
                icon: <EditOutlined />,
                onClick: () => openEditRoutine(node)
            },
            ...(supportsOracleCompilation && typeof handleCompileOracleObject === 'function' ? [{
                key: 'compile-oracle-object',
                label: t('sidebar.menu.compile'),
                icon: <ThunderboltOutlined />,
                onClick: () => void handleCompileOracleObject(node),
            }] : []),
            { type: 'divider' },
            {
                key: 'danger-zone',
                label: t('sidebar.menu.danger_operations'),
                icon: <WarningOutlined />,
                children: [
                    {
                        key: 'drop-routine',
                        label: t('sidebar.menu.delete_routine', { type: typeLabel }),
                        icon: <DeleteOutlined />,
                        danger: true,
                        onClick: () => handleDropRoutine(node)
                    }
                ]
            },
        ];
    } else if (node.type === 'db-trigger') {
        const supportsOracleCompilation = getMetadataDialect(node.dataRef as SavedConnection) === 'oracle';
        return [
            {
                key: 'view-trigger-definition',
                label: t('sidebar.menu.view_object_definition'),
                icon: <CodeOutlined />,
                onClick: () => onDoubleClick(null, node),
            },
            ...(supportsOracleCompilation && typeof handleCompileOracleObject === 'function' ? [{
                key: 'compile-oracle-object',
                label: t('sidebar.menu.compile'),
                icon: <ThunderboltOutlined />,
                onClick: () => void handleCompileOracleObject(node),
            }] : []),
        ];
    } else if (node.type === 'sequence') {
        return [
            {
                key: 'view-sequence-def',
                label: t('sidebar.menu.view_object_definition'),
                icon: <CodeOutlined />,
                onClick: () => openSequenceDefinition(node)
            },
            {
                key: 'copy-sequence-name',
                label: t('sidebar.menu.copy_object_name'),
                icon: <CopyOutlined />,
                onClick: () => handleCopyTableName(node)
            },
        ];
    } else if (node.type === 'package') {
        return [
            {
                key: 'view-package-def',
                label: t('sidebar.menu.view_object_definition'),
                icon: <CodeOutlined />,
                onClick: () => openPackageDefinition(node)
            },
            {
                key: 'copy-package-name',
                label: t('sidebar.menu.copy_object_name'),
                icon: <CopyOutlined />,
                onClick: () => handleCopyTableName(node)
            },
        ];
    } else if (node.type === 'db-event') {
        return [
            {
                key: 'view-event-def',
                label: t('sidebar.menu.view_object_definition'),
                icon: <CodeOutlined />,
                onClick: () => openEventDefinition(node)
            },
            {
                key: 'edit-event-query',
                label: t('sidebar.menu.edit_definition'),
                icon: <EditOutlined />,
                onClick: () => void openEditEvent(node)
            },
        ];
    } else if (node.type === 'table') {
        const isStarRocks = getMetadataDialect(node.dataRef as SavedConnection) === 'starrocks';
        const supportsCopyTable = getDataSourceCapabilities(node.dataRef?.config).supportsCopyTable;
        const messagePublishTarget = resolveMessagePublishTarget(node);
        return [
            {
                key: 'new-query',
                label: t('sidebar.menu.new_query'),
                icon: <ConsoleSqlOutlined />,
                onClick: () => {
                   void (async () => {
                       const tableName = String(node.dataRef?.tableName || '').trim();
                       const queryTemplate = await resolveTableSelectQuery({
                           dbType: getMetadataDialect(node.dataRef as SavedConnection),
                           tableName,
                           dbName: String(node.dataRef?.dbName || ''),
                           connectionConfig: node.dataRef?.config,
                       });
                       addTab({
                           id: `query-${Date.now()}`,
                           title: t('query.new'),
                           type: 'query',
                           connectionId: node.dataRef.id,
                           dbName: node.dataRef.dbName,
                           query: queryTemplate,
                       });
                   })();
                }
            },
            ...(messagePublishTarget ? [{
                key: 'publish-message',
                label: t('message_publish_modal.title'),
                icon: <SendOutlined />,
                onClick: () => openMessagePublishModal(node),
            }] : []),
            { type: 'divider' },
            {
                key: 'design-table',
                label: isStructureOnlyDbType(String(node.dataRef?.id || ''))
                  ? t('sidebar.menu.table_structure')
                  : t('sidebar.menu.design_table'),
                icon: <EditOutlined />,
                onClick: () => openDesign(node, 'columns', false)
            },
            ...(isStarRocks ? [{
                key: 'new-rollup',
                label: t('sidebar.v2_table_menu.new_rollup', { keyword: 'Rollup' }),
                icon: <ThunderboltOutlined />,
                onClick: () => openCreateStarRocksRollup(node)
            }] : []),
            {
                key: 'copy-table-name',
                label: t('sidebar.menu.copy_table_name'),
                icon: <CopyOutlined />,
                onClick: () => handleCopyTableName(node)
            },
            {
                key: 'copy-structure',
                label: t('sidebar.menu.copy_table_structure'),
                icon: <CopyOutlined />,
                onClick: () => handleCopyStructure(node)
            },
            ...(supportsCopyTable ? [{
                key: 'copy-table',
                label: t('table_copy.action.label'),
                icon: <CopyOutlined />,
                onClick: () => handleCopyTable(node)
            }] : []),
            {
                key: 'backup-table',
                label: t('sidebar.menu.backup_table_sql'),
                icon: <SaveOutlined />,
                onClick: () => handleExport(node, { format: 'sql' })
            },
            {
                key: 'rename-table',
                label: t('sidebar.menu.rename_table'),
                icon: <EditOutlined />,
                onClick: () => {
                    setRenameTableTarget(node);
                    renameTableForm.setFieldsValue({ newName: extractObjectName(node.dataRef?.tableName || node.title) });
                    setIsRenameTableModalOpen(true);
                }
            },
            {
                key: 'danger-zone',
                label: t('sidebar.menu.danger_operations'),
                icon: <WarningOutlined />,
                children: [
                    ...(supportsTableTruncateAction(node.dataRef?.config?.type, node.dataRef?.config?.driver) ? [{
                        key: 'truncate-table',
                        label: t('sidebar.menu.truncate_table'),
                        danger: true,
                        onClick: () => handleTableDataDangerAction(node, 'truncate')
                    }] : []),
                    {
                        key: 'clear-table',
                        label: t('sidebar.menu.clear_table'),
                        danger: true,
                        onClick: () => handleTableDataDangerAction(node, 'clear')
                    },
                    {
                        key: 'drop-table',
                        label: t('sidebar.menu.delete_table'),
                        icon: <DeleteOutlined />,
                        danger: true,
                        onClick: () => handleDeleteTable(node)
                    }
                ]
            },
            {
                type: 'divider'
            },
            {
                key: 'export',
                label: t('sidebar.menu.export_table_data'),
                icon: <ExportOutlined />,
                onClick: () => openExportDialog(node),
            },
            ...(getDataSourceCapabilities(node.dataRef?.config).supportsSqlQueryExport ? [{
                key: 'batch-tables',
                label: t('sidebar.action.batch_tables'),
                icon: <AppstoreOutlined />,
                onClick: () => openBatchTableWorkbench?.(node),
            }] : []),
        ];
    }

    if (node.type === 'all-saved-queries') {
        return [
            {
                key: 'new-saved-query-group',
                label: t('sidebar.saved_query_group.new_group'),
                icon: <FolderAddOutlined />,
                onClick: () => void openSavedQueryGroupModal(null, null),
            },
        ];
    }

    if (node.type === 'saved-query-manual-group') {
        const group = node.dataRef as SavedQueryGroup;
        return [
            {
                key: 'new-saved-query-subgroup',
                label: t('sidebar.saved_query_group.new_subgroup'),
                icon: <FolderAddOutlined />,
                onClick: () => void openSavedQueryGroupModal(null, group.id),
            },
            {
                key: 'edit-saved-query-group',
                label: t('sidebar.saved_query_group.edit'),
                icon: <EditOutlined />,
                onClick: () => void openSavedQueryGroupModal(group),
            },
            { type: 'divider' },
            {
                key: 'delete-saved-query-group',
                label: t('sidebar.saved_query_group.delete'),
                icon: <DeleteOutlined />,
                danger: true,
                onClick: () => {
                    Modal.confirm({
                        title: t('sidebar.modal.confirm_delete.title'),
                        content: t('sidebar.saved_query_group.delete_confirm', { name: group.name }),
                        okButtonProps: { danger: true },
                        onOk: async () => {
                            try {
                                await deleteSavedQueryGroup(group.id);
                                message.success(t('sidebar.message.saved_query_group_deleted'));
                            } catch (error) {
                                message.error(t('sidebar.message.saved_query_group_delete_failed', {
                                    error: error instanceof Error ? error.message : String(error),
                                }));
                                throw error;
                            }
                        },
                    });
                },
            },
        ];
    }

    // 已存查询节点的右键菜单
    if (node.type === 'saved-query') {
        const q = node.dataRef as SavedQuery;
        const queryGroupOwners = getSavedQueryGroupOwnerIds(savedQueryGroups || []);
        const currentGroupId = queryGroupOwners.get(q.id) || '';
        const moveQuery = async (targetGroupId: string) => {
            try {
                await moveSavedQueryToGroup(q.id, targetGroupId);
                message.success(t('sidebar.message.saved_query_group_moved'));
            } catch (error) {
                message.error(t('sidebar.message.saved_query_group_move_failed', {
                    error: error instanceof Error ? error.message : String(error),
                }));
            }
        };
        const rebindMenuItems: MenuProps['items'] = isSavedQueryUnmatched(q)
            ? [
                {
                    key: 'rebind-query',
                    label: t('sidebar.menu.bind_to_connection'),
                    icon: <LinkOutlined />,
                    disabled: connections.length === 0,
                    children: connections.length > 0
                        ? connections.map((conn: SavedConnection) => ({
                            key: `rebind-query-${conn.id}`,
                            label: conn.name || conn.id,
                            onClick: () => void handleRebindSavedQuery(q, conn),
                        }))
                        : undefined,
                },
            ]
            : [];
        const moveToGroupMenuItems: NonNullable<MenuProps['items']> = (savedQueryGroups || []).map((group: SavedQueryGroup) => ({
            key: `move-saved-query-to-group-${group.id}`,
            label: buildSavedQueryGroupPath(group.id, savedQueryGroups || []).join(' / ') || group.name,
            icon: <FolderOutlined />,
            disabled: group.id === currentGroupId,
            onClick: () => void moveQuery(group.id),
        }));
        return [
            {
                key: 'open-query',
                label: t('sidebar.menu.open_query'),
                icon: <ConsoleSqlOutlined />,
                onClick: () => {
                    addTab({
                        id: q.id,
                        title: resolveSavedQueryDisplayName(q.name),
                        type: 'query',
                        connectionId: q.connectionId,
                        dbName: q.dbName,
                        query: q.sql,
                        savedQueryId: q.id,
                    });
                }
            },
            {
                key: 'reveal-saved-query-in-folder',
                label: t('sidebar.menu.reveal_saved_query_in_folder'),
                icon: <FolderOpenOutlined />,
                onClick: () => void handleRevealSavedQueryInFolder(q),
            },
            ...rebindMenuItems,
            {
                key: 'move-saved-query-to-group',
                label: t('sidebar.saved_query_group.move_to_group'),
                icon: <FolderOpenOutlined />,
                disabled: moveToGroupMenuItems.length === 0,
                children: moveToGroupMenuItems.length > 0 ? moveToGroupMenuItems : undefined,
            },
            ...(currentGroupId ? [{
                key: 'move-saved-query-to-ungrouped',
                label: t('sidebar.saved_query_group.move_to_ungrouped'),
                icon: <FolderOutlined />,
                onClick: () => void moveQuery(''),
            }] : []),
            { type: 'divider' },
            {
                key: 'rename-query',
                label: t('sidebar.menu.rename_query'),
                icon: <EditOutlined />,
                onClick: () => openRenameSavedQueryModal(q),
            },
            {
                key: 'delete-query',
                label: t('sidebar.menu.delete_query'),
                icon: <DeleteOutlined />,
                danger: true,
                onClick: () => {
                    Modal.confirm({
                        title: t('sidebar.modal.confirm_delete.title'),
                        content: t('sidebar.modal.confirm_delete_saved_query.content', { name: resolveSavedQueryDisplayName(q.name) }),
                        okButtonProps: { danger: true },
                        onOk: async () => {
                            try {
                                await deleteQuery(q.id);
                            } catch (e) {
                                message.error(t('sidebar.message.saved_query_delete_failed', {
                                  error: e instanceof Error ? e.message : String(e),
                                }));
                                throw e;
                            }
                            // 从树中移除节点
                            const removeNode = (list: TreeNode[]): TreeNode[] =>
                                list
                                    .filter(n => !(n.type === 'saved-query' && n.dataRef?.id === q.id))
                                    .map(n => n.children ? { ...n, children: removeNode(n.children) } : n);
                            const nextTreeData = removeNode(treeDataRef.current);
                            treeDataRef.current = nextTreeData;
                            setTreeData(nextTreeData);
                            message.success(t('sidebar.message.saved_query_deleted'));
                        }
                    });
                }
            }
        ];
    }

    if (node.type === 'external-sql-root') {
        return [
            {
                key: 'add-external-sql-directory',
                label: t('sidebar.menu.add_sql_directory'),
                icon: <PlusOutlined />,
                onClick: () => {
                    void handleAddExternalSQLDirectory(node);
                }
            }
        ];
    }

    if (node.type === 'external-sql-directory') {
        return [
            {
                key: 'new-external-sql-file',
                label: t('sidebar.menu.new_sql_file'),
                icon: <FileAddOutlined />,
                onClick: () => {
                    openCreateExternalSQLFileModal(node);
                }
            },
            {
                key: 'new-external-sql-directory',
                label: t('sidebar.menu.new_sql_directory'),
                icon: <FolderAddOutlined />,
                onClick: () => {
                    openCreateExternalSQLDirectoryModal(node);
                }
            },
            {
                key: 'rename-external-sql-directory',
                label: t('sidebar.menu.rename_sql_directory'),
                icon: <EditOutlined />,
                onClick: () => {
                    openRenameExternalSQLDirectoryModal(node);
                }
            },
            { type: 'divider' },
            {
                key: 'refresh-external-sql-directory',
                label: t('sidebar.menu.refresh_directory'),
                icon: <ReloadOutlined />,
                onClick: () => {
                    void handleRefreshExternalSQLDirectory(node);
                }
            },
            { type: 'divider' },
            {
                key: 'remove-external-sql-directory',
                label: t('sidebar.menu.remove_directory'),
                icon: <DeleteOutlined />,
                danger: true,
                onClick: () => {
                    void handleRemoveExternalSQLDirectory(node);
                }
            },
            {
                key: 'delete-external-sql-directory',
                label: t('sidebar.menu.delete_local_directory'),
                icon: <DeleteOutlined />,
                danger: true,
                onClick: () => {
                    handleDeleteExternalSQLDirectory(node);
                }
            }
        ];
    }

    if (node.type === 'external-sql-folder') {
        return [
            {
                key: 'new-external-sql-file',
                label: t('sidebar.menu.new_sql_file'),
                icon: <FileAddOutlined />,
                onClick: () => {
                    openCreateExternalSQLFileModal(node);
                }
            },
            {
                key: 'new-external-sql-directory',
                label: t('sidebar.menu.new_sql_directory'),
                icon: <FolderAddOutlined />,
                onClick: () => {
                    openCreateExternalSQLDirectoryModal(node);
                }
            },
            {
                key: 'rename-external-sql-directory',
                label: t('sidebar.menu.rename_sql_directory'),
                icon: <EditOutlined />,
                onClick: () => {
                    openRenameExternalSQLDirectoryModal(node);
                }
            },
            {
                key: 'refresh-external-sql-directory',
                label: t('sidebar.menu.refresh_directory'),
                icon: <ReloadOutlined />,
                onClick: () => {
                    void handleRefreshExternalSQLDirectory(node);
                }
            },
            { type: 'divider' },
            {
                key: 'delete-external-sql-directory',
                label: t('sidebar.menu.delete_sql_directory'),
                icon: <DeleteOutlined />,
                danger: true,
                onClick: () => {
                    handleDeleteExternalSQLDirectory(node);
                }
            }
        ];
    }

    if (node.type === 'external-sql-file') {
        return [
            {
                key: 'open-external-sql-file',
                label: t('sidebar.menu.open_sql_file'),
                icon: <ConsoleSqlOutlined />,
                onClick: () => {
                    void openExternalSQLFile(node);
                }
            },
            {
                key: 'bind-external-sql-file-database',
                label: t('sidebar.menu.bind_sql_file_database'),
                icon: <LinkOutlined />,
                onClick: () => {
                    openExternalSQLBindingModal(node);
                }
            },
            {
                key: 'rename-external-sql-file',
                label: t('sidebar.menu.rename_sql_file'),
                icon: <EditOutlined />,
                onClick: () => {
                    openRenameExternalSQLFileModal(node);
                }
            },
            {
                key: 'new-external-sql-file-sibling',
                label: t('sidebar.menu.new_sql_file_in_directory'),
                icon: <FileAddOutlined />,
                onClick: () => {
                    openCreateExternalSQLFileModal(node);
                }
            },
            {
                key: 'new-external-sql-directory-sibling',
                label: t('sidebar.menu.new_sql_directory_in_directory'),
                icon: <FolderAddOutlined />,
                onClick: () => {
                    openCreateExternalSQLDirectoryModal(node);
                }
            },
            { type: 'divider' },
            {
                key: 'delete-external-sql-file',
                label: t('sidebar.menu.delete_sql_file'),
                icon: <DeleteOutlined />,
                danger: true,
                onClick: () => {
                    handleDeleteExternalSQLFile(node);
                }
            }
        ];
    }

    return [];
  };
