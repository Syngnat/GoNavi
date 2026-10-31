import type { SavedConnection } from '../../types';
import { getDataSourceCapabilities } from '../../utils/dataSourceCapabilities';
import { t } from '../../i18n';
import { GnNewQueryIcon } from '../icons/gnIcons';
import { resolveTableSelectQuery } from '../../utils/objectQueryTemplates';
import { resolveOptionalSchemaName, type SidebarNodeMenuContext } from './sidebarNodeMenuHelpers';
import {
  SendOutlined, EditOutlined, ThunderboltOutlined, CopyOutlined, WarningOutlined,
  DeleteOutlined, EyeOutlined, InboxOutlined, ReloadOutlined,
  PlayCircleOutlined, CodeOutlined,
} from '@ant-design/icons';
import type { MenuProps } from 'antd';
import { buildSidebarCopyObjectNameMenuItem } from './sidebarCopyObjectNameMenu';
import { supportsOracleObjectCompilation } from './oracleObjectCompilation';
import { openEventManagement, supportsEventManagement } from './sidebarEventManagement';
import { buildPluginConnectionActionMenuItems } from './pluginConnectionActionMenu';

export interface BuildMessageObjectMenuItemsInput {
  node: any;
  context: SidebarNodeMenuContext;
}

export const buildMessageObjectMenuItems = ({ node, context }: BuildMessageObjectMenuItemsInput): MenuProps['items'] => {
  const {
    resolveMessagePublishTarget, openMessageQueueWorkbench, openMessagePublishModal,
    handleCopyTableName, loadTables, getDatabaseNodeRef,
  } = context;
  const objectKind = String(node.dataRef?.messageObjectKind || '').trim().toLowerCase();
  const messagePublishTarget = resolveMessagePublishTarget(node);
  const pluginActionItems = buildPluginConnectionActionMenuItems({
    actions: context.pluginConnectionActions ?? [],
    connectionType: node.dataRef?.config?.type ?? '',
    scope: 'collection',
    target: {
      connectionId: String(node.dataRef?.id || ''),
      database: String(node.dataRef?.dbName || ''),
      collection: String(node.dataRef?.tableName || ''),
    },
    run: (entry, target) => context.runPluginConnectionAction?.(entry, target),
  });
  return [
      ...(objectKind === 'exchange' ? [] : [{
          key: 'browse-messages',
          label: t('sidebar.menu.browse_messages'),
          icon: <EyeOutlined />,
          onClick: () => openMessageQueueWorkbench(node, 'consume'),
      }]),
      {
          key: 'open-message-workbench',
          label: t('message_queue_workbench.tab_kind'),
          icon: <InboxOutlined />,
          onClick: () => openMessageQueueWorkbench(node, 'open'),
      },
      ...pluginActionItems,
      ...(messagePublishTarget ? [{
          key: 'publish-message',
          label: t('message_publish_modal.title'),
          icon: <SendOutlined />,
          onClick: () => openMessagePublishModal(node),
      }] : []),
      { type: 'divider' as const },
      {
          key: 'copy-message-object-name',
          label: t('sidebar.menu.copy_object_name'),
          icon: <CopyOutlined />,
          onClick: () => handleCopyTableName(node),
      },
      {
          key: 'refresh-message-objects',
          label: t('sidebar.menu.refresh_message_objects'),
          icon: <ReloadOutlined />,
          onClick: () => void loadTables(
              getDatabaseNodeRef(node.dataRef, String(node.dataRef?.dbName || '')),
              { ensureFresh: true },
          ),
      },
  ];
};

export interface BuildMessageNamespaceMenuItemsInput {
  node: any;
  context: SidebarNodeMenuContext;
}

export const buildMessageNamespaceMenuItems = ({ node, context }: BuildMessageNamespaceMenuItemsInput): MenuProps['items'] => {
  const {
    resolveMessagePublishTarget, openMessageQueueWorkbench, openMessagePublishModal, loadTables,
    getDatabaseNodeRef,
  } = context;
  const messagePublishTarget = resolveMessagePublishTarget(node);
  const pluginActionItems = buildPluginConnectionActionMenuItems({
    actions: context.pluginConnectionActions ?? [],
    connectionType: node.dataRef?.config?.type ?? '',
    scope: 'collection',
    target: {
      connectionId: String(node.dataRef?.id || ''),
      database: String(node.dataRef?.dbName || ''),
      collection: String(node.dataRef?.tableName || ''),
    },
    run: (entry, target) => context.runPluginConnectionAction?.(entry, target),
  });
  return [
      ...(node.type === 'message-namespace' ? [{
          key: 'open-message-workbench',
          label: t('message_queue_workbench.tab_kind'),
          icon: <InboxOutlined />,
          onClick: () => openMessageQueueWorkbench(node, 'open'),
      }, {
          key: 'consume-messages',
          label: t('message_consume.action.subscribe'),
          icon: <PlayCircleOutlined />,
          onClick: () => openMessageQueueWorkbench(node, 'consume'),
      }, ...(messagePublishTarget ? [{
          key: 'publish-message',
          label: t('message_queue_workbench.action.publish'),
          icon: <SendOutlined />,
          onClick: () => openMessagePublishModal(node),
      }] : [])] : []),
      {
          key: 'refresh-message-objects',
          label: t('sidebar.menu.refresh_message_objects'),
          icon: <ReloadOutlined />,
          onClick: () => void loadTables(
              getDatabaseNodeRef(node.dataRef, String(node.dataRef?.dbName || '')),
              { ensureFresh: true },
          ),
      },
  ];
};

export interface BuildDbEventMenuItemsInput {
  node: any;
  context: SidebarNodeMenuContext;
}

export const buildDbEventMenuItems = ({ node, context }: BuildDbEventMenuItemsInput): MenuProps['items'] => {
  const { openEventDefinition, openEditEvent } = context;
  return [
      ...(supportsEventManagement(node) ? [{ key: 'manage-event', label: t('database_jobs.manage.title'), onClick: () => openEventManagement(node) }] : []),
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
};

export interface BuildDatabaseLinkMenuItemsInput {
  node: any;
  context: SidebarNodeMenuContext;
}

export const buildDatabaseLinkMenuItems = ({ node, context }: BuildDatabaseLinkMenuItemsInput): MenuProps['items'] => {
  const { onDoubleClick, handleCopyTableName } = context;
  return [
      {
          key: 'view-database-link-def',
          label: t('sidebar.menu.view_object_definition'),
          icon: <CodeOutlined />,
          onClick: () => onDoubleClick(null, node),
      },
      buildSidebarCopyObjectNameMenuItem(node, handleCopyTableName, 'copy-database-link-name'),
  ];
};

export interface BuildPackageMenuItemsInput {
  node: any;
  context: SidebarNodeMenuContext;
}

export const buildPackageMenuItems = ({ node, context }: BuildPackageMenuItemsInput): MenuProps['items'] => {
  const { openPackageDefinition, handleCopyTableName } = context;
  return [
      {
          key: 'view-package-def',
          label: t('sidebar.menu.view_object_definition'),
          icon: <CodeOutlined />,
          onClick: () => openPackageDefinition(node)
      },
      buildSidebarCopyObjectNameMenuItem(node, handleCopyTableName, 'copy-package-name'),
  ];
};

export interface BuildSequenceMenuItemsInput {
  node: any;
  context: SidebarNodeMenuContext;
}

export const buildSequenceMenuItems = ({ node, context }: BuildSequenceMenuItemsInput): MenuProps['items'] => {
  const { openSequenceDefinition, handleCopyTableName } = context;
  return [
      {
          key: 'view-sequence-def',
          label: t('sidebar.menu.view_object_definition'),
          icon: <CodeOutlined />,
          onClick: () => openSequenceDefinition(node)
      },
      buildSidebarCopyObjectNameMenuItem(node, handleCopyTableName, 'copy-sequence-name'),
  ];
};

export interface BuildDbTriggerMenuItemsInput {
  node: any;
  context: SidebarNodeMenuContext;
}

export const buildDbTriggerMenuItems = ({ node, context }: BuildDbTriggerMenuItemsInput): MenuProps['items'] => {
  const { getMetadataDialect, onDoubleClick, handleCompileOracleObject } = context;
  const supportsOracleCompilation = supportsOracleObjectCompilation(
      getMetadataDialect(node.dataRef as SavedConnection),
  );
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
};

export interface BuildRoutineMenuItemsInput {
  node: any;
  context: SidebarNodeMenuContext;
}

export const buildRoutineMenuItems = ({ node, context }: BuildRoutineMenuItemsInput): MenuProps['items'] => {
  const {
    getMetadataDialect, openRoutineDefinition, openEditRoutine, handleCompileOracleObject,
    handleDropRoutine,
  } = context;
  const routineType = node.dataRef?.routineType || 'FUNCTION';
  const typeLabel = t(routineType === 'PROCEDURE' ? 'sidebar.object.procedure' : 'sidebar.object.function');
  const supportsOracleCompilation = supportsOracleObjectCompilation(
      getMetadataDialect(node.dataRef as SavedConnection),
  );
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
};

export interface BuildMaterializedViewMenuItemsInput {
  node: any;
  context: SidebarNodeMenuContext;
}

export const buildMaterializedViewMenuItems = ({ node, context }: BuildMaterializedViewMenuItemsInput): MenuProps['items'] => {
  const { onDoubleClick, openViewDefinition, handleCopyTableName, addTab } = context;
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
          icon: <GnNewQueryIcon />,
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
                      schemaName: resolveOptionalSchemaName(node),
                      query: queryTemplate,
                  });
              })();
          }
      },
  ];
};

export interface BuildViewMenuItemsInput {
  node: any;
  context: SidebarNodeMenuContext;
}

export const buildViewMenuItems = ({ node, context }: BuildViewMenuItemsInput): MenuProps['items'] => {
  const {
    onDoubleClick, openViewDefinition, handleCopyTableName, openEditView, addTab,
    setRenameViewTarget, renameViewForm, extractObjectName, setIsRenameViewModalOpen,
    handleDropView,
  } = context;
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
          icon: <GnNewQueryIcon />,
          onClick: () => {
              addTab({
                  id: `query-${Date.now()}`,
                  title: t('query.new'),
                  type: 'query',
                  connectionId: node.dataRef.id,
                  dbName: node.dataRef.dbName,
                  schemaName: resolveOptionalSchemaName(node),
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
};
