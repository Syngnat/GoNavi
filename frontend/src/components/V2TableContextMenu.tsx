import React from 'react';
import {
  CodeOutlined,
  ConsoleSqlOutlined,
  CopyOutlined,
  DeleteOutlined,
  DisconnectOutlined,
  EditOutlined,
  ExportOutlined,
  FileAddOutlined,
  FolderOpenOutlined,
  FolderOutlined,
  SaveOutlined,
  SendOutlined,
  LinkOutlined,
  ReloadOutlined,
  TableOutlined,
  ThunderboltOutlined,
  DatabaseOutlined,
  AppstoreOutlined,
  CheckSquareOutlined,
  CloudOutlined,
  ClearOutlined,
  ClockCircleOutlined,
  ColumnWidthOutlined,
  DashboardOutlined,
  EyeInvisibleOutlined,
  FileTextOutlined,
  FolderAddOutlined,
  HddOutlined,
  PushpinOutlined,
  PlusOutlined,
  UndoOutlined,
  SortAscendingOutlined,
  SortDescendingOutlined,
  VerticalAlignBottomOutlined,
  SafetyCertificateOutlined,
} from '@ant-design/icons';
import { getCurrentLanguage, t } from '../i18n';
import { getPrimaryShortcutDisplayLabel, type ShortcutPlatform } from '../utils/shortcuts';
import { formatSidebarTableSize } from './sidebar/sidebarHelpers';

export type V2TableContextMenuActionKey =
  | 'pin-table'
  | 'unpin-table'
  | 'open-data'
  | 'design-table'
  | 'open-new-tab'
  | 'new-query'
  | 'publish-message'
  | 'view-ddl'
  | 'view-er'
  | 'copy-table-name'
  | 'copy-structure'
  | 'copy-table'
  | 'copy-insert'
  | 'rename-table'
  | 'new-rollup'
  | 'backup-table'
  | 'refresh-stats'
  | 'export-data'
  | 'batch-tables'
  | 'ai-explain'
  | 'ai-generate-query'
  | 'truncate-table'
  | 'drop-table';

export type V2TableContextMenuStats = {
  rowCount?: number;
  dataLength?: number;
  indexLength?: number;
  engine?: string;
  loading?: boolean;
  unavailable?: boolean;
};

type V2TableContextMenuItemConfig = {
  action: string;
  icon: React.ReactNode;
  title: string;
  kbd?: string;
  featured?: boolean;
  selected?: boolean;
  disabled?: boolean;
  tone?: 'default' | 'ai' | 'danger';
};

export const formatV2TableContextMenuRows = (count?: number): string => {
  if (count === undefined || count === null || !Number.isFinite(count) || count < 0) {
    return t('sidebar.v2_table_menu.meta.rows_empty');
  }
  return t('sidebar.v2_table_menu.meta.rows', {
    count: Math.round(count).toLocaleString(getCurrentLanguage()),
  });
};

export const formatV2TableContextMenuSize = (bytes?: number): string => {
  const formatted = bytes === undefined ? '' : formatSidebarTableSize(bytes);
  return formatted || '—';
};

const resolveV2TableContextMenuMeta = (stats?: V2TableContextMenuStats): string => {
  if (!stats) return t('sidebar.v2_table_menu.meta.idle');
  if (stats?.loading) return t('sidebar.v2_table_menu.meta.loading');
  if (stats?.unavailable) return t('sidebar.v2_table_menu.meta.unavailable');
  return t('sidebar.v2_table_menu.meta.summary', {
    rows: formatV2TableContextMenuRows(stats?.rowCount),
    data: formatV2TableContextMenuSize(stats?.dataLength),
    indexes: formatV2TableContextMenuSize(stats?.indexLength),
  });
};

const V2TableContextMenuItem: React.FC<{
  item: V2TableContextMenuItemConfig;
  onAction?: (action: string) => void;
}> = ({ item, onAction }) => (
  <button
    type="button"
    className={[
      'gn-v2-context-menu-item',
      item.featured ? 'is-featured' : '',
      item.selected ? 'is-selected' : '',
      item.tone === 'ai' ? 'is-ai' : '',
      item.tone === 'danger' ? 'is-danger' : '',
      item.tone === 'default' ? 'is-default' : '',
      item.disabled ? 'is-disabled' : '',
    ].filter(Boolean).join(' ')}
    role="menuitem"
    disabled={item.disabled}
    aria-disabled={item.disabled || undefined}
    onClick={(event) => {
      event.preventDefault();
      event.stopPropagation();
      if (item.disabled) return;
      onAction?.(item.action);
    }}
  >
    <span className="gn-v2-context-menu-item-icon">{item.icon}</span>
    <span className="gn-v2-context-menu-item-title">{item.title}</span>
    {item.kbd && <span className="gn-v2-context-menu-kbd">{item.kbd}</span>}
  </button>
);

const V2ContextMenuHeader: React.FC<{
  icon: React.ReactNode;
  title: string;
  meta: string;
  pill?: string;
}> = ({ icon, title, meta, pill }) => (
  <div className="gn-v2-context-menu-header">
    <span className="gn-v2-context-menu-table-icon">{icon}</span>
    <span className="gn-v2-context-menu-heading">
      <strong title={title}>{title}</strong>
      <small>{meta}</small>
    </span>
    {pill && (
      <span className="gn-v2-context-menu-engine-pill">{pill}</span>
    )}
  </div>
);

const renderV2ContextMenuItems = (
  items: V2TableContextMenuItemConfig[],
  onAction?: (action: string) => void,
) => items.map((item) => (
  <V2TableContextMenuItem key={item.action} item={item} onAction={onAction} />
));

export const V2TableContextMenuView: React.FC<{
  tableName: string;
  shortcutPlatform?: ShortcutPlatform;
  stats?: V2TableContextMenuStats;
  isPinned?: boolean;
  supportsTruncate?: boolean;
  supportsCopyTable?: boolean;
  supportsStarRocksRollup?: boolean;
  supportsMessagePublish?: boolean;
  supportsBatchTables?: boolean;
  onAction?: (action: V2TableContextMenuActionKey) => void;
}> = ({
  tableName,
  shortcutPlatform = DEFAULT_V2_CONTEXT_MENU_SHORTCUT_PLATFORM,
  stats,
  isPinned = false,
  supportsTruncate = true,
  supportsCopyTable = false,
  supportsStarRocksRollup = false,
  supportsMessagePublish = false,
  supportsBatchTables = true,
  onAction,
}) => {
  const renderItems = (items: V2TableContextMenuItemConfig[]) => renderV2ContextMenuItems(
    items,
    onAction as (action: string) => void,
  );

  const maintenanceItems: V2TableContextMenuItemConfig[] = [
    { action: 'rename-table', icon: <EditOutlined />, title: t('sidebar.v2_table_menu.rename_compact'), kbd: 'F2' },
    ...(supportsStarRocksRollup ? [{ action: 'new-rollup' as const, icon: <ThunderboltOutlined />, title: t('sidebar.v2_table_menu.new_rollup', { keyword: 'Rollup' }) }] : []),
    { action: 'backup-table', icon: <ExportOutlined />, title: t('sidebar.v2_table_menu.backup_sql_dump', { keyword: 'SQL Dump' }) },
    { action: 'refresh-stats', icon: <ReloadOutlined />, title: t('sidebar.v2_table_menu.refresh_stats') },
  ];

  const dangerItems: V2TableContextMenuItemConfig[] = [
    ...(supportsTruncate ? [{
      action: 'truncate-table' as const,
      icon: <DeleteOutlined />,
      title: t('sidebar.v2_table_menu.item_with_suffix', { label: t('sidebar.v2_table_menu.truncate_table'), suffix: 'TRUNCATE' }),
      tone: 'danger' as const,
    }] : []),
    {
      action: 'drop-table',
      icon: <DeleteOutlined />,
      title: t('sidebar.v2_table_menu.item_with_suffix', { label: t('sidebar.menu.delete_table'), suffix: 'DROP' }),
      kbd: '⌫',
      tone: 'danger',
    },
  ];

  return (
    <div className="gn-v2-table-context-menu" data-v2-table-context-menu="true" role="menu">
      <V2ContextMenuHeader
        icon={<TableOutlined />}
        title={tableName}
        meta={resolveV2TableContextMenuMeta(stats)}
        pill={(stats?.engine || stats?.loading) ? (stats?.loading ? '...' : stats?.engine) : undefined}
      />

      <div className="gn-v2-context-menu-body">
        {renderItems([
          { action: 'open-data', icon: <TableOutlined />, title: t('sidebar.v2_table_menu.open_data'), kbd: '↵', featured: true },
          { action: isPinned ? 'unpin-table' : 'pin-table', icon: <PushpinOutlined />, title: isPinned ? t('sidebar.action.unpin_table') : t('sidebar.action.pin_table'), kbd: isPinned ? t('sidebar.status.pinned') : undefined, selected: isPinned },
          { action: 'design-table', icon: <EditOutlined />, title: `${t('sidebar.menu.design_table')} · ${t('sidebar.v2_table_menu.design_table_detail')}`, kbd: primaryShortcut('D', shortcutPlatform) },
          { action: 'open-new-tab', icon: <FileAddOutlined />, title: t('sidebar.v2_table_menu.open_in_new_tab'), kbd: primaryShortcut('Enter', shortcutPlatform) },
          { action: 'new-query', icon: <ConsoleSqlOutlined />, title: t('sidebar.menu.new_query') },
          ...(supportsMessagePublish ? [{ action: 'publish-message' as const, icon: <SendOutlined />, title: t('message_publish_modal.title') }] : []),
        ])}

        <div className="gn-v2-context-menu-section-title">{t('sidebar.v2_table_menu.metadata_section')}</div>
        {renderItems([
          { action: 'view-ddl', icon: <CodeOutlined />, title: `${t('data_grid.ddl.view')} · CREATE TABLE` },
          { action: 'view-er', icon: <LinkOutlined />, title: t('sidebar.v2_table_menu.view_in_er') },
        ])}

        <div className="gn-v2-context-menu-section-title">{t('sidebar.v2_table_menu.copy_section')}</div>
        {renderItems([
          { action: 'copy-table-name', icon: <CopyOutlined />, title: t('sidebar.v2_table_menu.copy_table_name'), kbd: primaryShortcut('C', shortcutPlatform) },
          { action: 'copy-structure', icon: <CopyOutlined />, title: `${t('sidebar.menu.copy_table_structure')} · DDL` },
          ...(supportsCopyTable ? [{ action: 'copy-table' as const, icon: <CopyOutlined />, title: t('table_copy.action.label') }] : []),
          { action: 'copy-insert', icon: <CopyOutlined />, title: t('sidebar.v2_table_menu.copy_table_as_insert', { keyword: 'INSERT' }) },
        ])}

        <div className="gn-v2-context-menu-section-title">{t('sidebar.v2_table_menu.maintenance_section')}</div>
        {renderItems(maintenanceItems)}

        <div className="gn-v2-context-menu-section-title">{t('sidebar.menu.export_table_data')}</div>
        {renderItems([
          { action: 'export-data', icon: <ExportOutlined />, title: t('sidebar.v2_table_menu.open_export_workbench') },
          ...(supportsBatchTables ? [{
            action: 'batch-tables' as const,
            icon: <AppstoreOutlined />,
            title: t('sidebar.action.batch_tables'),
          }] : []),
        ])}

        <div className="gn-v2-context-menu-divider" />
        {renderItems([
          { action: 'ai-explain', icon: <ThunderboltOutlined />, title: t('sidebar.v2_table_menu.ai_explain_table'), tone: 'ai', featured: true },
          { action: 'ai-generate-query', icon: <ConsoleSqlOutlined />, title: t('sidebar.v2_table_menu.ai_generate_query'), tone: 'ai' },
        ])}

        <div className="gn-v2-context-menu-divider" />
        {renderItems(dangerItems)}
      </div>
    </div>
  );
};

export type V2TableGroupContextMenuActionKey =
  | 'new-table'
  | 'refresh'
  | 'sort-by-name'
  | 'sort-by-frequency';

export const V2TableGroupContextMenuView: React.FC<{
  title?: string;
  shortcutPlatform?: ShortcutPlatform;
  dbName?: string;
  count?: number;
  currentSort?: 'name' | 'frequency';
  onAction?: (action: V2TableGroupContextMenuActionKey) => void;
}> = ({
  title,
  shortcutPlatform = DEFAULT_V2_CONTEXT_MENU_SHORTCUT_PLATFORM,
  dbName,
  count,
  currentSort = 'name',
  onAction,
}) => {
  const sortLabel = currentSort === 'frequency'
    ? t('sidebar.v2_table_group_menu.sort_frequency')
    : t('sidebar.v2_table_group_menu.sort_name');
  const databaseLabel = dbName || t('sidebar.v2_table_group_menu.current_database');
  const tableCountLabel = Math.max(0, count ?? 0).toLocaleString(getCurrentLanguage());
  const renderItems = (items: V2TableContextMenuItemConfig[]) => renderV2ContextMenuItems(
    items,
    onAction as (action: string) => void,
  );

  return (
    <div className="gn-v2-table-context-menu gn-v2-group-context-menu" data-v2-table-group-context-menu="true" role="menu">
      <V2ContextMenuHeader
        icon={<TableOutlined />}
        title={title ?? t('sidebar.v2_table_group_menu.title')}
        meta={t('sidebar.v2_table_group_menu.meta', {
          database: databaseLabel,
          count: tableCountLabel,
          sort: sortLabel,
        })}
        pill="GROUP"
      />

      <div className="gn-v2-context-menu-body">
        {renderItems([
          { action: 'new-table', icon: <TableOutlined />, title: t('sidebar.menu.create_table'), kbd: primaryShortcut('N', shortcutPlatform), featured: true },
          { action: 'refresh', icon: <ReloadOutlined />, title: t('sidebar.menu.refresh'), kbd: primaryShortcut('R', shortcutPlatform), featured: true },
        ])}

        <div className="gn-v2-context-menu-section-title">{t('data_grid.context_menu.sort_section')}</div>
        {renderItems([
          {
            action: 'sort-by-name',
            icon: currentSort === 'name' ? <CheckSquareOutlined /> : <SortAscendingOutlined />,
            title: t('sidebar.menu.sort_by_name'),
            kbd: currentSort === 'name' ? t('data_grid.context_menu.current_marker') : undefined,
            selected: currentSort === 'name',
          },
          {
            action: 'sort-by-frequency',
            icon: currentSort === 'frequency' ? <CheckSquareOutlined /> : <ClockCircleOutlined />,
            title: t('sidebar.menu.sort_by_frequency'),
            kbd: currentSort === 'frequency' ? t('data_grid.context_menu.current_marker') : undefined,
            selected: currentSort === 'frequency',
          },
        ])}
      </div>
    </div>
  );
};

export type V2DatabaseContextMenuActionKey =
  | 'pin-database'
  | 'unpin-database'
  | 'copy-database-name'
  | 'new-table'
  | 'new-schema'
  | 'new-materialized-view'
  | 'new-external-catalog'
  | 'rename-db'
  | 'refresh'
  | 'export-db-schema'
  | 'backup-db-sql'
  | 'batch-tables'
  | 'batch-databases'
  | 'disconnect-db'
  | 'new-query'
  | 'run-sql'
  | 'schema-visibility'
  | 'drop-db';

export type V2SchemaContextMenuActionKey =
  | 'rename-schema'
  | 'refresh-schema'
  | 'export-schema'
  | 'backup-schema-sql'
  | 'drop-schema';

export const V2DatabaseContextMenuView: React.FC<{
  dbName: string;
  shortcutPlatform?: ShortcutPlatform;
  dialect?: string;
  supportsSchemaActions?: boolean;
  supportsSchemaVisibility?: boolean;
  supportsStarRocksActions?: boolean;
  supportsRenameDatabase?: boolean;
  supportsDropDatabase?: boolean;
  supportsBatchWorkbench?: boolean;
  isPinned?: boolean;
  onAction?: (action: V2DatabaseContextMenuActionKey) => void;
}> = ({
  dbName,
  shortcutPlatform = DEFAULT_V2_CONTEXT_MENU_SHORTCUT_PLATFORM,
  dialect,
  supportsSchemaActions = false,
  supportsSchemaVisibility = false,
  supportsStarRocksActions = false,
  supportsRenameDatabase = true,
  supportsDropDatabase = true,
  supportsBatchWorkbench = true,
  isPinned = false,
  onAction,
}) => {
  const renderItems = (items: V2TableContextMenuItemConfig[]) => renderV2ContextMenuItems(
    items,
    onAction as (action: string) => void,
  );

  return (
    <div className="gn-v2-table-context-menu gn-v2-database-context-menu" data-v2-database-context-menu="true" role="menu">
      <V2ContextMenuHeader
        icon={<DatabaseOutlined />}
        title={dbName}
        meta={t('sidebar.v2_database_menu.meta', { dialect: dialect || 'database' })}
        pill="DB"
      />

      <div className="gn-v2-context-menu-body">
        {renderItems([
          { action: 'copy-database-name', icon: <CopyOutlined />, title: t('sidebar.menu.copy_database_name'), kbd: primaryShortcut('C', shortcutPlatform), featured: true },
          { action: isPinned ? 'unpin-database' : 'pin-database', icon: <PushpinOutlined />, title: isPinned ? t('sidebar.action.unpin_database') : t('sidebar.action.pin_database'), kbd: isPinned ? t('sidebar.status.pinned') : undefined, selected: isPinned },
          { action: 'new-table', icon: <TableOutlined />, title: t('sidebar.menu.create_table'), kbd: primaryShortcut('N', shortcutPlatform), featured: true },
          ...(supportsSchemaActions ? [{ action: 'new-schema', icon: <FolderAddOutlined />, title: t('sidebar.v2_database_menu.new_schema') }] : []),
          ...(supportsSchemaVisibility ? [{ action: 'schema-visibility', icon: <FolderOpenOutlined />, title: t('sidebar.schema_visibility.menu.manage') }] : []),
          { action: 'new-query', icon: <ConsoleSqlOutlined />, title: t('sidebar.menu.new_query') },
          { action: 'run-sql', icon: <FileAddOutlined />, title: t('sidebar.sql_file_exec.title') },
        ])}

        {supportsStarRocksActions && (
          <>
            <div className="gn-v2-context-menu-section-title">StarRocks</div>
            {renderItems([
              { action: 'new-materialized-view', icon: <ThunderboltOutlined />, title: t('sidebar.v2_database_menu.new_materialized_view') },
              { action: 'new-external-catalog', icon: <CloudOutlined />, title: t('sidebar.v2_database_menu.new_external_catalog') },
            ])}
          </>
        )}

        <div className="gn-v2-context-menu-section-title">{t('sidebar.v2_table_menu.maintenance_section')}</div>
        {renderItems([
          ...(supportsRenameDatabase ? [{ action: 'rename-db', icon: <EditOutlined />, title: t('sidebar.menu.rename_database'), kbd: 'F2' }] : []),
          { action: 'refresh', icon: <ReloadOutlined />, title: t('sidebar.v2_database_menu.refresh_object_tree') },
          { action: 'disconnect-db', icon: <DisconnectOutlined />, title: t('sidebar.menu.close_database') },
        ])}

        <div className="gn-v2-context-menu-section-title">{t('sidebar.v2_database_menu.export_backup_section')}</div>
        {renderItems([
          { action: 'export-db-schema', icon: <ExportOutlined />, title: t('sidebar.v2_database_menu.export_all_table_schema_sql') },
          { action: 'backup-db-sql', icon: <SaveOutlined />, title: t('sidebar.v2_database_menu.backup_all_tables_sql') },
          ...(supportsBatchWorkbench ? [
            { action: 'batch-tables' as const, icon: <AppstoreOutlined />, title: t('sidebar.action.batch_tables') },
            { action: 'batch-databases' as const, icon: <DatabaseOutlined />, title: t('sidebar.action.batch_databases') },
          ] : []),
        ])}

        <div className="gn-v2-context-menu-divider" />
        {supportsDropDatabase && renderItems([
          { action: 'drop-db', icon: <DeleteOutlined />, title: t('sidebar.v2_table_menu.item_with_suffix', { label: t('sidebar.menu.delete_database'), suffix: 'DROP' }), tone: 'danger', kbd: '⌫' },
        ])}
      </div>
    </div>
  );
};

export const V2SchemaContextMenuView: React.FC<{
  dbName: string;
  schemaName: string;
  shortcutPlatform?: ShortcutPlatform;
  onAction?: (action: V2SchemaContextMenuActionKey) => void;
}> = ({
  dbName,
  schemaName,
  shortcutPlatform = DEFAULT_V2_CONTEXT_MENU_SHORTCUT_PLATFORM,
  onAction,
}) => {
  const renderItems = (items: V2TableContextMenuItemConfig[]) => renderV2ContextMenuItems(
    items,
    onAction as (action: string) => void,
  );

  return (
    <div className="gn-v2-table-context-menu gn-v2-database-context-menu" data-v2-schema-context-menu="true" role="menu">
      <V2ContextMenuHeader
        icon={<FolderOpenOutlined />}
        title={schemaName}
        meta={t('sidebar.v2_schema_menu.meta', {
          database: dbName || t('sidebar.v2_table_group_menu.current_database'),
        })}
        pill="SCHEMA"
      />

      <div className="gn-v2-context-menu-body">
        <div className="gn-v2-context-menu-section-title">{t('sidebar.v2_table_menu.maintenance_section')}</div>
        {renderItems([
          { action: 'rename-schema', icon: <EditOutlined />, title: t('sidebar.v2_schema_menu.edit_schema'), kbd: 'F2', featured: true },
          { action: 'refresh-schema', icon: <ReloadOutlined />, title: t('sidebar.v2_database_menu.refresh_object_tree'), kbd: primaryShortcut('R', shortcutPlatform) },
        ])}

        <div className="gn-v2-context-menu-section-title">{t('sidebar.v2_database_menu.export_backup_section')}</div>
        {renderItems([
          { action: 'export-schema', icon: <ExportOutlined />, title: t('sidebar.v2_schema_menu.export_current_schema_sql') },
          { action: 'backup-schema-sql', icon: <SaveOutlined />, title: t('sidebar.v2_schema_menu.backup_current_schema_sql') },
        ])}

        <div className="gn-v2-context-menu-divider" />
        {renderItems([
          { action: 'drop-schema', icon: <DeleteOutlined />, title: t('sidebar.v2_schema_menu.delete_schema_cascade'), tone: 'danger', kbd: '⌫' },
        ])}
      </div>
    </div>
  );
};

const DEFAULT_V2_CONTEXT_MENU_SHORTCUT_PLATFORM: ShortcutPlatform = 'windows';

const primaryShortcut = (
  key: string,
  shortcutPlatform: ShortcutPlatform = DEFAULT_V2_CONTEXT_MENU_SHORTCUT_PLATFORM,
): string => getPrimaryShortcutDisplayLabel(key, shortcutPlatform);

export type V2ConnectionContextMenuActionKey =
  | 'new-db'
  | 'refresh'
  | 'new-query'
  | 'open-sql-file'
  | 'new-command'
  | 'open-monitor'
  | 'edit'
  | 'copy-connection'
  | 'disconnect'
  | 'delete'
  | 'move-to-ungrouped'
  | `move-to-tag:${string}`;

export type V2ConnectionContextMenuTagItem = {
  id: string;
  name: string;
  selected?: boolean;
};

export type V2ConnectionGroupContextMenuActionKey =
  | 'new-connection'
  | 'connection-health'
  | 'new-subgroup'
  | 'edit-group'
  | 'delete-group';

export const V2ConnectionGroupContextMenuView: React.FC<{
  groupName: string;
  count?: number;
  onAction?: (action: V2ConnectionGroupContextMenuActionKey) => void;
}> = ({
  groupName,
  count = 0,
  onAction,
}) => {
  const renderItems = (items: V2TableContextMenuItemConfig[]) => renderV2ContextMenuItems(
    items,
    onAction as (action: string) => void,
  );

  return (
    <div className="gn-v2-table-context-menu gn-v2-connection-group-context-menu" data-v2-connection-group-context-menu="true" role="menu">
      <V2ContextMenuHeader
        icon={<FolderOpenOutlined />}
        title={groupName || t('connection.sidebar.group.untitled')}
        meta={t('connection.sidebar.group.meta', { count: count.toLocaleString() })}
        pill={t('connection.sidebar.group.badge')}
      />

      <div className="gn-v2-context-menu-body">
        {renderItems([
          { action: 'new-connection', icon: <PlusOutlined />, title: t('connection.new'), featured: true },
          { action: 'connection-health', icon: <SafetyCertificateOutlined />, title: t('connection_health.action.open'), featured: true, disabled: count === 0 },
          { action: 'new-subgroup', icon: <FolderAddOutlined />, title: t('connection.sidebar.group.newSubgroup'), featured: true },
          { action: 'edit-group', icon: <EditOutlined />, title: t('connection.sidebar.group.edit'), kbd: 'F2', featured: true },
        ])}
        <div className="gn-v2-context-menu-divider" />
        {renderItems([
          { action: 'delete-group', icon: <DeleteOutlined />, title: t('connection.sidebar.group.delete'), tone: 'danger', kbd: '⌫' },
        ])}
      </div>
    </div>
  );
};

export const V2ConnectionContextMenuView: React.FC<{
  connectionName: string;
  shortcutPlatform?: ShortcutPlatform;
  hostSummary?: string;
  driverLabel?: string;
  isRedis?: boolean;
  supportsCreateDatabase?: boolean;
  supportsQueryEditor?: boolean;
  tags?: V2ConnectionContextMenuTagItem[];
  onAction?: (action: V2ConnectionContextMenuActionKey) => void;
}> = ({
  connectionName,
  shortcutPlatform = DEFAULT_V2_CONTEXT_MENU_SHORTCUT_PLATFORM,
  hostSummary,
  driverLabel,
  isRedis = false,
  supportsCreateDatabase = true,
  supportsQueryEditor = true,
  tags = [],
  onAction,
}) => {
  const renderItems = (items: V2TableContextMenuItemConfig[]) => renderV2ContextMenuItems(
    items,
    onAction as (action: string) => void,
  );
  const hasSelectedTag = tags.some((tag) => tag.selected);
  const meta = [
    driverLabel || (isRedis ? 'redis' : 'database'),
    hostSummary || t('connection.sidebar.menu.hostFallback'),
  ].filter(Boolean).join(' · ');

  return (
    <div className="gn-v2-table-context-menu gn-v2-connection-context-menu" data-v2-connection-context-menu="true" role="menu">
      <V2ContextMenuHeader
        icon={isRedis ? <HddOutlined /> : <CloudOutlined />}
        title={connectionName}
        meta={meta}
        pill={t('connection.sidebar.menu.hostBadge')}
      />

      <div className="gn-v2-context-menu-body">
        {isRedis ? renderItems([
          { action: 'refresh', icon: <ReloadOutlined />, title: t('connection.sidebar.menu.refresh'), kbd: primaryShortcut('R', shortcutPlatform), featured: true },
          { action: 'new-command', icon: <ConsoleSqlOutlined />, title: t('sidebar.menu.new_command_window'), featured: true },
          { action: 'open-monitor', icon: <DashboardOutlined />, title: t('redis_monitor.title.instance') },
        ]) : renderItems([
          ...(supportsCreateDatabase ? [{ action: 'new-db' as const, icon: <DatabaseOutlined />, title: t('connection.sidebar.menu.createDatabase'), kbd: primaryShortcut('N', shortcutPlatform), featured: true }] : []),
          { action: 'refresh', icon: <ReloadOutlined />, title: t('connection.sidebar.menu.refresh'), kbd: primaryShortcut('R', shortcutPlatform) },
          ...(supportsQueryEditor ? [
            { action: 'new-query' as const, icon: <ConsoleSqlOutlined />, title: t('sidebar.menu.new_query') },
            { action: 'open-sql-file' as const, icon: <FileAddOutlined />, title: t('sidebar.sql_file_exec.title') },
          ] : []),
        ])}

        <div className="gn-v2-context-menu-section-title">{t('connection.sidebar.menu.section')}</div>
        {renderItems([
          { action: 'edit', icon: <EditOutlined />, title: t('sidebar.menu.edit_connection'), kbd: 'F2' },
          { action: 'copy-connection', icon: <CopyOutlined />, title: t('connection.sidebar.menu.copy') },
          { action: 'disconnect', icon: <DisconnectOutlined />, title: t('connection.sidebar.menu.disconnect') },
        ])}

        {tags.length > 0 && (
          <>
            <div className="gn-v2-context-menu-section-title">{t('connection.sidebar.menu.groupSection')}</div>
            {renderItems([
              ...tags.map((tag): V2TableContextMenuItemConfig => ({
                action: `move-to-tag:${tag.id}`,
                icon: tag.selected ? <CheckSquareOutlined /> : <FolderOutlined />,
                title: tag.name,
                kbd: tag.selected ? t('connection.sidebar.menu.current') : undefined,
                selected: tag.selected,
              })),
              {
                action: 'move-to-ungrouped',
                icon: hasSelectedTag ? <FolderOpenOutlined /> : <CheckSquareOutlined />,
                title: t('connection.sidebar.menu.moveToUngrouped'),
                kbd: hasSelectedTag ? undefined : t('connection.sidebar.menu.current'),
                selected: !hasSelectedTag,
              },
            ])}
          </>
        )}

        <div className="gn-v2-context-menu-divider" />
        {renderItems([
          { action: 'delete', icon: <DeleteOutlined />, title: t('connection.sidebar.menu.delete'), tone: 'danger', kbd: '⌫' },
        ])}
      </div>
    </div>
  );
};

export type V2CellContextMenuActionKey =
  | 'copy-field-name'
  | 'copy-row-data'
  | 'copy-row-for-paste'
  | 'paste-row-as-new'
  | 'copy-column-data'
  | 'undo-cell-change'
  | 'set-null'
  | 'edit-row'
  | 'fill-selected'
  | 'paste-copied-columns'
  | 'copy-insert'
  | 'copy-update'
  | 'copy-delete'
  | 'copy-json'
  | 'copy-csv'
  | 'copy-markdown'
  | 'export-csv'
  | 'export-xlsx'
  | 'export-json'
  | 'export-html';

export type V2ColumnHeaderContextMenuActionKey =
  | 'copy-field-name'
  | 'copy-column-comment'
  | 'copy-column-data'
  | 'sort-asc'
  | 'sort-desc'
  | 'clear-sort'
  | 'auto-fit-column'
  | 'pin-column-left'
  | 'unpin-column-left'
  | 'hide-column'
  | 'show-column-type'
  | 'hide-column-type'
  | 'show-column-comment'
  | 'hide-column-comment';

export const V2ColumnHeaderContextMenuView: React.FC<{
  fieldName: string;
  shortcutPlatform?: ShortcutPlatform;
  columnType?: string;
  columnComment?: string;
  sortOrder?: 'ascend' | 'descend' | null;
  showColumnType?: boolean;
  showColumnComment?: boolean;
  pinnedLeft?: boolean;
  canPinLeft?: boolean;
  onAction?: (action: V2ColumnHeaderContextMenuActionKey) => void;
}> = ({
  fieldName,
  shortcutPlatform = DEFAULT_V2_CONTEXT_MENU_SHORTCUT_PLATFORM,
  columnType,
  columnComment,
  sortOrder,
  showColumnType = true,
  showColumnComment = true,
  pinnedLeft = false,
  canPinLeft = true,
  onAction,
}) => {
  const renderItems = (items: V2TableContextMenuItemConfig[]) => renderV2ContextMenuItems(
    items,
    onAction as (action: string) => void,
  );
  const normalizedType = String(columnType || '').trim();
  const normalizedComment = String(columnComment || '').trim();
  const meta = [
    normalizedType || t('data_grid.context_menu.column_unknown_type'),
    normalizedComment || t('data_grid.context_menu.column_no_comment'),
  ].join(' · ');

  return (
    <div className="gn-v2-table-context-menu gn-v2-column-context-menu" data-v2-column-context-menu="true" role="menu">
      <V2ContextMenuHeader
        icon={<FileTextOutlined />}
        title={fieldName || t('data_grid.context_menu.column_unnamed_field')}
        meta={meta}
        pill="FIELD"
      />

      <div className="gn-v2-context-menu-body">
        <div className="gn-v2-context-menu-section-title">{t('sidebar.v2_table_menu.copy_section')}</div>
        {renderItems([
          { action: 'copy-field-name', icon: <CopyOutlined />, title: t('data_grid.context_menu.copy_field_name'), kbd: primaryShortcut('C', shortcutPlatform), featured: true },
          ...(normalizedComment ? [{ action: 'copy-column-comment', icon: <CopyOutlined />, title: t('data_grid.context_menu.copy_column_comment') }] : []),
          { action: 'copy-column-data', icon: <CopyOutlined />, title: t('data_grid.context_menu.copy_column_data') },
        ])}

        <div className="gn-v2-context-menu-section-title">{t('data_grid.context_menu.sort_section')}</div>
        {renderItems([
          { action: 'sort-asc', icon: <SortAscendingOutlined />, title: t('data_grid.context_menu.sort_ascending'), selected: sortOrder === 'ascend', kbd: sortOrder === 'ascend' ? t('data_grid.context_menu.current_marker') : undefined },
          { action: 'sort-desc', icon: <SortDescendingOutlined />, title: t('data_grid.context_menu.sort_descending'), selected: sortOrder === 'descend', kbd: sortOrder === 'descend' ? t('data_grid.context_menu.current_marker') : undefined },
          { action: 'clear-sort', icon: <ClearOutlined />, title: t('data_grid.context_menu.clear_column_sort'), disabled: !sortOrder },
        ])}

        <div className="gn-v2-context-menu-section-title">{t('data_grid.context_menu.column_display_section')}</div>
        {renderItems([
          { action: 'auto-fit-column', icon: <ColumnWidthOutlined />, title: t('data_grid.context_menu.auto_fit_column') },
          {
            action: pinnedLeft ? 'unpin-column-left' : 'pin-column-left',
            icon: <PushpinOutlined />,
            title: pinnedLeft
              ? t('data_grid.context_menu.unpin_column_left')
              : t('data_grid.context_menu.pin_column_left'),
            selected: pinnedLeft,
            disabled: !canPinLeft && !pinnedLeft,
          },
          { action: 'hide-column', icon: <EyeInvisibleOutlined />, title: t('data_grid.context_menu.hide_column') },
          {
            action: showColumnType ? 'hide-column-type' : 'show-column-type',
            icon: <FileTextOutlined />,
            title: showColumnType ? t('data_grid.context_menu.hide_column_type') : t('data_grid.context_menu.show_column_type'),
            selected: showColumnType,
          },
          {
            action: showColumnComment ? 'hide-column-comment' : 'show-column-comment',
            icon: <FileTextOutlined />,
            title: showColumnComment ? t('data_grid.context_menu.hide_column_comment') : t('data_grid.context_menu.show_column_comment'),
            selected: showColumnComment,
          },
        ])}
      </div>
    </div>
  );
};

export const V2CellContextMenuView: React.FC<{
  fieldName: string;
  shortcutPlatform?: ShortcutPlatform;
  tableName?: string;
  rowLabel?: string;
  selectedRowCount?: number;
  canModifyData?: boolean;
  canUndoCellChange?: boolean;
  copiedRowCount?: number;
  canPasteCopiedColumns?: boolean;
  supportsCopyInsert?: boolean;
  onAction?: (action: V2CellContextMenuActionKey) => void;
}> = ({
  fieldName,
  shortcutPlatform = DEFAULT_V2_CONTEXT_MENU_SHORTCUT_PLATFORM,
  tableName,
  rowLabel,
  selectedRowCount = 0,
  canModifyData = false,
  canUndoCellChange = false,
  copiedRowCount = 0,
  canPasteCopiedColumns = false,
  supportsCopyInsert = true,
  onAction,
}) => {
  const renderItems = (items: V2TableContextMenuItemConfig[]) => renderV2ContextMenuItems(
    items,
    onAction as (action: string) => void,
  );
  const selectedCountLabel = Math.max(0, selectedRowCount).toLocaleString(getCurrentLanguage());
  const menuTitle = fieldName || t('data_grid.context_menu.column_unnamed_field');
  const meta = [tableName, rowLabel || t('data_grid.context_menu.current_row')].filter(Boolean).join(' · ') || t('data_grid.context_menu.current_cell');

  return (
    <div className="gn-v2-table-context-menu gn-v2-cell-context-menu" data-v2-cell-context-menu="true" role="menu">
      <V2ContextMenuHeader
        icon={<TableOutlined />}
        title={menuTitle}
        meta={meta}
        pill="CELL"
      />

      <div className="gn-v2-context-menu-body">
        {renderItems([
          { action: 'copy-field-name', icon: <CopyOutlined />, title: t('data_grid.context_menu.copy_field_name'), kbd: primaryShortcut('C', shortcutPlatform), featured: true },
        ])}

        {canModifyData && (
          <>
            <div className="gn-v2-context-menu-section-title">{t('data_grid.context_menu.edit_section')}</div>
            {renderItems([
              {
                action: 'undo-cell-change',
                icon: <UndoOutlined />,
                title: t('data_grid.context_menu.undo_cell_change'),
                disabled: !canUndoCellChange,
              },
              { action: 'set-null', icon: <ClearOutlined />, title: t('data_grid.batch_fill.set_null') },
              { action: 'edit-row', icon: <EditOutlined />, title: t('data_grid.context_menu.edit_row'), kbd: '↵' },
              { action: 'copy-row-for-paste', icon: <CopyOutlined />, title: t('data_grid.context_menu.copy_row_as_new') },
              {
                action: 'paste-row-as-new',
                icon: <VerticalAlignBottomOutlined />,
                title: copiedRowCount > 0
                  ? t('data_grid.context_menu.paste_row_as_new_count', { count: copiedRowCount.toLocaleString(getCurrentLanguage()) })
                  : t('data_grid.context_menu.paste_row_as_new'),
                disabled: copiedRowCount <= 0,
              },
              {
                action: 'fill-selected',
                icon: <VerticalAlignBottomOutlined />,
                title: t('data_grid.context_menu.fill_to_selected_rows', { count: selectedCountLabel }),
                disabled: selectedRowCount <= 0,
              },
              {
                action: 'paste-copied-columns',
                icon: <VerticalAlignBottomOutlined />,
                title: t('data_grid.context_menu.paste_copied_columns'),
                disabled: !canPasteCopiedColumns,
              },
            ])}
          </>
        )}

        <div className="gn-v2-context-menu-section-title">{t('sidebar.v2_table_menu.copy_section')}</div>
        {renderItems([
          { action: 'copy-row-data', icon: <CopyOutlined />, title: t('data_grid.context_menu.copy_row_data') },
          { action: 'copy-column-data', icon: <CopyOutlined />, title: t('data_grid.context_menu.copy_column_data') },
          ...(supportsCopyInsert ? [
            { action: 'copy-insert' as const, icon: <ConsoleSqlOutlined />, title: t('data_grid.context_menu.copy_as_insert'), kbd: 'SQL' },
            { action: 'copy-update' as const, icon: <ConsoleSqlOutlined />, title: t('data_grid.context_menu.copy_as_update') },
            { action: 'copy-delete' as const, icon: <ConsoleSqlOutlined />, title: t('data_grid.context_menu.copy_as_delete') },
          ] : []),
          { action: 'copy-json', icon: <FileTextOutlined />, title: t('data_grid.context_menu.copy_as_json') },
          { action: 'copy-csv', icon: <FileTextOutlined />, title: t('data_grid.context_menu.copy_as_csv') },
          { action: 'copy-markdown', icon: <CopyOutlined />, title: t('data_grid.context_menu.copy_as_markdown') },
        ])}

        <div className="gn-v2-context-menu-section-title">{t('data_grid.toolbar.export')}</div>
        {renderItems([
          { action: 'export-csv', icon: <ExportOutlined />, title: t('sidebar.v2_table_menu.item_with_suffix', { label: 'CSV', suffix: '.csv' }) },
          { action: 'export-xlsx', icon: <ExportOutlined />, title: t('sidebar.v2_table_menu.item_with_suffix', { label: 'Excel', suffix: '.xlsx' }) },
          { action: 'export-json', icon: <ExportOutlined />, title: t('sidebar.v2_table_menu.item_with_suffix', { label: 'JSON', suffix: '.json' }) },
          { action: 'export-html', icon: <ExportOutlined />, title: t('sidebar.v2_table_menu.item_with_suffix', { label: 'HTML', suffix: '.html' }) },
        ])}
      </div>
    </div>
  );
};
