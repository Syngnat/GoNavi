import React from 'react';
import { AppstoreOutlined, CopyOutlined, DeleteOutlined, TableOutlined } from '@ant-design/icons';

import { t } from '../../i18n';
import {
  renderV2ContextMenuItems,
  V2ContextMenuHeader,
  type V2TableContextMenuItemConfig,
} from './v2ContextMenuPrimitives';

// 多表右键菜单：只保留对多张表同时有意义的动作（打开数据 / 复制表名 /
// 批量表工作台 / 批量截断 / 批量删除）。单表专属能力（重命名、设计表、
// DDL、Rollup 等）由单表菜单提供，多选时不出现。

export type V2MultiTableContextMenuActionKey =
  | 'open-data'
  | 'copy-table-name'
  | 'batch-tables'
  | 'truncate-table'
  | 'drop-table';

export const V2MultiTableContextMenuView: React.FC<{
  /** 表数量（菜单头部展示）；表名清单仅用于 title 提示。 */
  tableNames: string[];
  supportsTruncate?: boolean;
  supportsBatchTables?: boolean;
  onAction?: (action: V2MultiTableContextMenuActionKey) => void;
}> = ({
  tableNames,
  supportsTruncate = true,
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
    {
      action: 'drop-table',
      icon: <DeleteOutlined />,
      title: t('sidebar.menu.delete_table'),
      kbd: '⌫',
      tone: 'danger',
    },
  ];

  return (
    <div className="gn-v2-table-context-menu" data-v2-multi-table-context-menu="true" role="menu">
      <V2ContextMenuHeader
        icon={<TableOutlined />}
        title={t('sidebar.multi_table_menu.title', { count: tableNames.length })}
        meta={preview}
      />
      <div className="gn-v2-context-menu-body">
        {renderItems([
          { action: 'open-data', icon: <TableOutlined />, title: t('sidebar.v2_table_menu.open_data'), featured: true },
          { action: 'copy-table-name', icon: <CopyOutlined />, title: t('sidebar.menu.copy_table_name') },
          ...(supportsBatchTables ? [{ action: 'batch-tables' as const, icon: <AppstoreOutlined />, title: t('sidebar.action.batch_tables') }] : []),
        ])}

        <div className="gn-v2-context-menu-section-title">{t('sidebar.menu.danger_operations')}</div>
        {renderItems(dangerItems)}
      </div>
    </div>
  );
};

export default V2MultiTableContextMenuView;
