import React from 'react';
import {
  AppstoreOutlined,
  ClearOutlined,
  CodeOutlined,
  ConsoleSqlOutlined,
  CopyOutlined,
  DeleteOutlined,
  EditOutlined,
  ExperimentOutlined,
  ExportOutlined,
  FileAddOutlined,
  LinkOutlined,
  PushpinOutlined,
  ReloadOutlined,
  SendOutlined,
  TableOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { t } from '../../i18n';
import type { ShortcutPlatform } from '../../utils/shortcuts';
import { GnNewQueryIcon } from '../icons/gnIcons';
import {
  DEFAULT_V2_CONTEXT_MENU_SHORTCUT_PLATFORM,
  primaryShortcut,
  renderV2ContextMenuItems,
  V2ContextMenuHeader,
  V2TableContextMenuItem,
  type V2TableContextMenuItemConfig,
} from './v2ContextMenuPrimitives';
import { resolveV2TableContextMenuMeta, type V2TableContextMenuStats } from './v2TableContextMenuMeta';

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
  | 'mock-data'
  | 'ai-explain'
  | 'ai-generate-query'
  | 'truncate-table'
  | 'clear-table'
  | 'drop-table';

export const V2TableContextMenuView: React.FC<{
  tableName: string;
  shortcutPlatform?: ShortcutPlatform;
  stats?: V2TableContextMenuStats;
  isPinned?: boolean;
  supportsTruncate?: boolean;
  supportsClear?: boolean;
  supportsCopyTable?: boolean;
  supportsStarRocksRollup?: boolean;
  supportsMessagePublish?: boolean;
  supportsBatchTables?: boolean;
  // SQL 形式的导出（复制全表为 INSERT、SQL Dump 备份）：非 SQL 数据源生成的语句无法回灌，不提供。
  supportsSqlExport?: boolean;
  // 生成模拟数据：关系型数据源且连接没有禁止编辑/导入数据。
  supportsMockData?: boolean;
  pluginActions?: { key: string; title: string; onSelect: () => void }[];
  onAction?: (action: V2TableContextMenuActionKey) => void;
}> = ({
  tableName,
  shortcutPlatform = DEFAULT_V2_CONTEXT_MENU_SHORTCUT_PLATFORM,
  stats,
  isPinned = false,
  supportsTruncate = true,
  supportsClear = false,
  supportsCopyTable = false,
  supportsStarRocksRollup = false,
  supportsMessagePublish = false,
  supportsBatchTables = true,
  supportsSqlExport = true,
  supportsMockData = false,
  pluginActions = [],
  onAction,
}) => {
  const renderItems = (items: V2TableContextMenuItemConfig[]) => renderV2ContextMenuItems(
    items,
    onAction as (action: string) => void,
  );

  const maintenanceItems: V2TableContextMenuItemConfig[] = [
    { action: 'rename-table', icon: <EditOutlined />, title: t('sidebar.v2_table_menu.rename_compact'), kbd: 'F2' },
    ...(supportsStarRocksRollup ? [{ action: 'new-rollup' as const, icon: <ThunderboltOutlined />, title: t('sidebar.v2_table_menu.new_rollup', { keyword: 'Rollup' }) }] : []),
    ...(supportsSqlExport ? [{ action: 'backup-table' as const, icon: <ExportOutlined />, title: t('sidebar.v2_table_menu.backup_sql_dump', { keyword: 'SQL Dump' }) }] : []),
    { action: 'refresh-stats', icon: <ReloadOutlined />, title: t('sidebar.v2_table_menu.refresh_stats') },
  ];

  const dangerItems: V2TableContextMenuItemConfig[] = [
    ...(supportsTruncate ? [{
      action: 'truncate-table' as const,
      icon: <DeleteOutlined />,
      title: t('sidebar.v2_table_menu.item_with_suffix', { label: t('sidebar.v2_table_menu.truncate_table'), suffix: 'TRUNCATE' }),
      tone: 'danger' as const,
    }] : []),
    ...(supportsClear ? [{
      action: 'clear-table' as const,
      icon: <ClearOutlined />,
      title: t('sidebar.v2_table_menu.item_with_suffix', { label: t('sidebar.menu.clear_table'), suffix: 'DELETE' }),
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
          { action: 'new-query', icon: <GnNewQueryIcon />, title: t('sidebar.menu.new_query') },
          ...(supportsMessagePublish ? [{ action: 'publish-message' as const, icon: <SendOutlined />, title: t('message_publish_modal.title') }] : []),
        ])}

        {pluginActions.length > 0 && <>
          <div className="gn-v2-context-menu-section-title">{t('plugin.connection_actions.menu')}</div>
          {pluginActions.map((item) => <V2TableContextMenuItem key={item.key}
            item={{ action: item.key, icon: <CodeOutlined />, title: item.title }} onAction={() => item.onSelect()} />)}
        </>}

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
          ...(supportsSqlExport ? [{ action: 'copy-insert' as const, icon: <CopyOutlined />, title: t('sidebar.v2_table_menu.copy_table_as_insert', { keyword: 'INSERT' }) }] : []),
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
          ...(supportsMockData ? [{ action: 'mock-data' as const, icon: <ExperimentOutlined />, title: t('sidebar.v2_table_menu.generate_mock_data') }] : []),
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
