import React from 'react';
import {
  AppstoreOutlined,
  ClearOutlined,
  CopyOutlined,
  DeleteOutlined,
  EditOutlined,
  TableOutlined,
} from '@ant-design/icons';

import { t } from '../../i18n';
import {
  renderV2ContextMenuItems,
  V2ContextMenuHeader,
  type V2TableContextMenuItemConfig,
} from './v2ContextMenuPrimitives';

// 多表右键菜单：只保留对多张表同时有意义的动作（打开数据 / 复制表名 /
// 批量重命名 / 批量表工作台 / 批量截断 / 批量清空 / 批量删除）。设计表、DDL、Rollup
// 等单对象能力仍是单表菜单专属。

export type V2MultiTableContextMenuActionKey =
  | 'open-data'
  | 'copy-table-name'
  | 'rename-table'
  | 'batch-tables'
  | 'truncate-table'
  | 'clear-table'
  | 'drop-table';

export const V2MultiTableContextMenuView: React.FC<{
  /** 表数量（菜单头部展示）；表名清单仅用于 title 提示。 */
  tableNames: string[];
  supportsOpenData?: boolean;
  supportsCopyTableName?: boolean;
  supportsRename?: boolean;
  supportsTruncate?: boolean;
  supportsClear?: boolean;
  supportsBatchTables?: boolean;
  onAction?: (action: V2MultiTableContextMenuActionKey) => void;
}> = ({
  tableNames,
  supportsOpenData = true,
  supportsCopyTableName = true,
  supportsRename = true,
  supportsTruncate = true,
  supportsClear = false,
  supportsBatchTables = true,
  onAction,
}) => {
  const renderItems = (items: V2TableContextMenuItemConfig[]) => renderV2ContextMenuItems(
    items,
    onAction as (action: string) => void,
  );
  const preview = tableNames.slice(0, 3).join('、') + (tableNames.length > 3 ? ' …' : '');
  const dangerItems: V2TableContextMenuItemConfig[] = [
    ...(supportsTruncate ? [{
      action: 'truncate-table' as const,
      icon: <DeleteOutlined />,
      title: t('sidebar.v2_table_menu.truncate_table'),
      tone: 'danger' as const,
    }] : []),
    ...(supportsClear ? [{
      action: 'clear-table' as const,
      icon: <ClearOutlined />,
      title: t('sidebar.menu.clear_table'),
      tone: 'danger' as const,
    }] : []),
    {
      action: 'drop-table',
      icon: <DeleteOutlined />,
      title: t('sidebar.menu.delete_table'),
      kbd: '⌫',
      tone: 'danger',
    },
  ];
  const actionItems: V2TableContextMenuItemConfig[] = [
    ...(supportsOpenData ? [{
      action: 'open-data',
      icon: <TableOutlined />,
      title: t('sidebar.v2_table_menu.open_data'),
      featured: true,
    }] : []),
    ...(supportsCopyTableName ? [{
      action: 'copy-table-name',
      icon: <CopyOutlined />,
      title: t('sidebar.menu.copy_table_name'),
    }] : []),
    ...(supportsRename ? [{
      action: 'rename-table',
      icon: <EditOutlined />,
      title: t('sidebar.menu.rename_table'),
      kbd: 'F2',
    }] : []),
    ...(supportsBatchTables ? [{
      action: 'batch-tables',
      icon: <AppstoreOutlined />,
      title: t('sidebar.action.batch_tables'),
    }] : []),
  ];

  return (
    <div className="gn-v2-table-context-menu" data-v2-multi-table-context-menu="true" role="menu">
      <V2ContextMenuHeader
        icon={<TableOutlined />}
        title={t('sidebar.multi_table_menu.title', { count: tableNames.length })}
        meta={preview}
      />
      <div className="gn-v2-context-menu-body">
        {actionItems.length > 0 && renderItems(actionItems)}

        <div className="gn-v2-context-menu-section-title">{t('sidebar.menu.danger_operations')}</div>
        {renderItems(dangerItems)}
      </div>
    </div>
  );
};

export default V2MultiTableContextMenuView;
