import { t } from '../../i18n';
import {
  ReloadOutlined, ConsoleSqlOutlined, DashboardOutlined, EyeOutlined, EditOutlined, CopyOutlined,
  DisconnectOutlined, AppstoreOutlined, DeleteOutlined, PlusOutlined, FolderOutlined,
  FolderOpenOutlined, DatabaseOutlined, InboxOutlined, PlayCircleOutlined, SendOutlined,
  FileAddOutlined,
} from '@ant-design/icons';
import type { SavedConnection } from '../../types';
import {
  isNacosNamespaceStructureRestricted, resolveCurrentNacosConnection,
  resolveCurrentNacosNamespaceDiscoveryMode, openNacosNamespaceFormModal,
  type SidebarNodeMenuContext,
} from './sidebarNodeMenuHelpers';
import type { MenuProps } from 'antd';
import { getDataSourceCapabilities } from '../../utils/dataSourceCapabilities';
import { buildElasticsearchConsoleTemplates } from '../../utils/elasticsearchConsole';
import { isElasticsearchFamilyType } from '../../utils/elasticsearchFamily';
import { GnNewQueryIcon } from '../icons/gnIcons';
import { registryAllowsImport } from '../../utils/dataSourceRegistry';

export interface BuildConnectionNodeMenuItemsInput {
  isRedis: boolean;
  refreshConnectionResources: any;
  node: any;
  isNacos: boolean;
  conn: SavedConnection;
  context: SidebarNodeMenuContext;
}

export const buildConnectionNodeMenuItems = ({ isRedis, refreshConnectionResources, node, isNacos, conn, context }: BuildConnectionNodeMenuItemsInput): MenuProps['items'] => {
  const {
    addTab, buildConnectionRootRedisCommandTabTitle, buildConnectionRootRedisMonitorTabTitle,
    supportsConnectionVisibility = () => false, openConnectionVisibilitySettings = () => undefined,
    onEditConnection, handleDuplicateConnection, disconnectConnectionNode,
    openBatchConnectionWorkbench, deleteConnectionNode, getNacosNamespaceDiscoveryMode,
    loadDatabases, connectionTags, moveConnectionToTag, resolveMessagePublishTarget,
    buildConnectionRootQueryTabTitle, setTargetConnection, setIsCreateDbModalOpen,
    openMessageQueueWorkbench, openMessagePublishModal, handleRunSQLFile,
  } = context;
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
          ...(supportsConnectionVisibility(node.dataRef as SavedConnection) ? [{
              key: 'visibility',
              label: t('sidebar.database_schema_visibility.menu.manage'),
              icon: <EyeOutlined />,
              onClick: () => openConnectionVisibilitySettings(node.dataRef as SavedConnection),
          }] : []),
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
              key: 'batch-connections',
              label: t('sidebar.action.batch_connections'),
              icon: <AppstoreOutlined />,
              onClick: () => openBatchConnectionWorkbench?.(node),
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
              key: 'batch-connections',
              label: t('sidebar.action.batch_connections'),
              icon: <AppstoreOutlined />,
              onClick: () => openBatchConnectionWorkbench?.(node),
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
  const currentTagId = connectionTags.find(
      (tag: any) => tag.connectionIds.includes(String(node.key)),
  )?.id;
  if (currentTagId) {
      if (connectionTags.length > 0) {
          tagSubMenuItems.push({ type: 'divider' });
      }
      tagSubMenuItems.push({
          key: 'move-to-ungrouped',
          label: t('connection.sidebar.menu.moveOutTag'),
          onClick: () => moveConnectionToTag(node.key, null)
      });
  }
  const tagMenuItem = tagSubMenuItems.length > 0 ? {
      key: 'move-to-tag',
      label: t('connection.sidebar.menu.moveToTag'),
      icon: <FolderOpenOutlined />,
      children: tagSubMenuItems
  } : null;

  // Regular database connection menu
  const connectionCapabilities = getDataSourceCapabilities((node.dataRef as SavedConnection)?.config);
  const isElasticsearch = isElasticsearchFamilyType(connectionCapabilities.type);
  const isMessageQueue = ['mqtt', 'kafka', 'rocketmq', 'rabbitmq', 'pulsar'].includes(connectionCapabilities.type);
  const messagePublishTarget = isMessageQueue ? resolveMessagePublishTarget(node) : null;
  return [
      ...((connectionCapabilities.supportsCreateDatabase || connectionCapabilities.supportsCreateIndex) ? [{
          key: 'new-db',
          label: t(connectionCapabilities.supportsCreateIndex
              ? 'query_editor.elasticsearch.templates.create_index'
              : 'connection.sidebar.menu.createDatabase'),
          icon: <DatabaseOutlined />,
          onClick: () => {
              if (isElasticsearch && connectionCapabilities.supportsCreateIndex) {
                  const query = buildElasticsearchConsoleTemplates('')
                      .find((template) => template.id === 'create_index')?.source || '';
                  addTab({
                      id: `query-${Date.now()}`,
                      title: buildConnectionRootQueryTabTitle(),
                      type: 'query',
                      connectionId: node.key,
                      dbName: undefined,
                      query,
                  });
                  return;
              }
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
           ...(isMessageQueue ? [
               {
                 key: 'open-message-workbench',
                 label: t('message_queue_workbench.tab_kind'),
                 icon: <InboxOutlined />,
                 onClick: () => openMessageQueueWorkbench(node, 'open'),
               },
               {
                 key: 'consume-messages',
                 label: t('message_consume.action.subscribe'),
                 icon: <PlayCircleOutlined />,
                 onClick: () => openMessageQueueWorkbench(node, 'consume'),
               },
               ...(messagePublishTarget ? [{
                 key: 'publish-message',
                 label: t('message_queue_workbench.action.publish'),
                 icon: <SendOutlined />,
                 onClick: () => openMessagePublishModal(node),
               }] : []),
           ] : [
           {
             key: 'new-query',
             label: t('sidebar.menu.new_query'),
             icon: <GnNewQueryIcon />,
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
           ...(registryAllowsImport((node.dataRef as SavedConnection)?.config?.type, 'sqlFile') ? [{
               key: 'open-sql-file',
               label: t('sidebar.sql_file_exec.title'),
               icon: <FileAddOutlined />,
               onClick: () => handleRunSQLFile(node)
           }] : []),
           ]),
       ] : []),
       { type: 'divider' },
       ...(supportsConnectionVisibility(node.dataRef as SavedConnection) ? [{
           key: 'visibility',
           label: t('sidebar.database_schema_visibility.menu.manage'),
           icon: <EyeOutlined />,
           onClick: () => openConnectionVisibilitySettings(node.dataRef as SavedConnection),
       }] : []),
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
       ...(tagMenuItem ? [tagMenuItem] : []),
       {
           key: 'disconnect',
           label: t('connection.sidebar.menu.disconnect'),
           icon: <DisconnectOutlined />,
           onClick: () => void disconnectConnectionNode(node)
       },
       {
           key: 'batch-connections',
           label: t('sidebar.action.batch_connections'),
           icon: <AppstoreOutlined />,
           onClick: () => openBatchConnectionWorkbench?.(node),
       },
       {
           key: 'delete',
           label: t('connection.sidebar.menu.delete'),
           icon: <DeleteOutlined />,
           danger: true,
           onClick: () => deleteConnectionNode(node)
       }
  ];
};
