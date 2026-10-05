import type { SavedConnection } from '../../types';
import { getDataSourceCapabilities } from '../../utils/dataSourceCapabilities';
import { t } from '../../i18n';
import {
  CopyOutlined, TableOutlined, FolderAddOutlined, FolderOpenOutlined, ThunderboltOutlined,
  CloudOutlined, FileAddOutlined, EditOutlined, WarningOutlined, DeleteOutlined, ReloadOutlined,
  ExportOutlined, SaveOutlined, AppstoreOutlined, DatabaseOutlined, DisconnectOutlined, KeyOutlined,
  ConsoleSqlOutlined, DashboardOutlined,
} from '@ant-design/icons';
import { GnNewQueryIcon } from '../icons/gnIcons';
import { type SidebarNodeMenuContext, openRedisDbAliasModal } from './sidebarNodeMenuHelpers';
import type { MenuProps } from 'antd';
import { registryAllowsImport } from '../../utils/dataSourceRegistry';

export interface BuildDatabaseNodeMenuItemsInput {
  node: any;
  context: SidebarNodeMenuContext;
}

export const buildDatabaseNodeMenuItems = ({ node, context }: BuildDatabaseNodeMenuItemsInput): MenuProps['items'] => {
  const {
    getMetadataDialect, isPostgresSchemaDialect, isStructureOnlyDbType,
    handleV2DatabaseContextMenuAction, openNewTableDesign, openSchemaVisibilitySettings,
    openCreateStarRocksMaterializedView, openCreateStarRocksExternalCatalog,
  } = context;
  const databaseConn = node.dataRef as SavedConnection;
  const dialect = getMetadataDialect(databaseConn);
  const capabilities = getDataSourceCapabilities(databaseConn?.config);
  const isStarRocks = dialect === 'starrocks';
  const supportsSchemaActions = isPostgresSchemaDialect(dialect);
  const supportsSchemaVisibility = capabilities.supportsSecondarySchemaVisibility;
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
           icon: <GnNewQueryIcon />,
           onClick: () => handleV2DatabaseContextMenuAction(node, 'new-query')
       },
       ...(registryAllowsImport(databaseConn?.config?.type, 'sqlFile') ? [{
           key: 'run-sql',
           label: t('sidebar.sql_file_exec.title'),
           icon: <FileAddOutlined />,
           onClick: () => handleV2DatabaseContextMenuAction(node, 'run-sql')
       }] : []),
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
       ...(capabilities.supportsSqlQueryExport ? [
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
};

export interface BuildRedisDbMenuItemsInput {
  node: any;
  context: SidebarNodeMenuContext;
}

export const buildRedisDbMenuItems = ({ node, context }: BuildRedisDbMenuItemsInput): MenuProps['items'] => {
  const {
    addTab, buildConnectionRootRedisCommandTabTitle, buildConnectionRootRedisMonitorTabTitle,
  } = context;
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
};
