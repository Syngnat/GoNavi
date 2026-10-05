import { getCurrentLanguage, t } from '../../i18n';
import { formatSidebarTableSize } from '../sidebar/sidebarHelpers';

// 表右键菜单头部的统计摘要（行数、数据与索引大小），从 V2TableContextMenu 拆出。

export type V2TableContextMenuStats = {
  rowCount?: number;
  dataLength?: number;
  indexLength?: number;
  engine?: string;
  loading?: boolean;
  unavailable?: boolean;
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

export const resolveV2TableContextMenuMeta = (stats?: V2TableContextMenuStats): string => {
  if (!stats) return t('sidebar.v2_table_menu.meta.idle');
  if (stats?.loading) return t('sidebar.v2_table_menu.meta.loading');
  if (stats?.unavailable) return t('sidebar.v2_table_menu.meta.unavailable');
  return t('sidebar.v2_table_menu.meta.summary', {
    rows: formatV2TableContextMenuRows(stats?.rowCount),
    data: formatV2TableContextMenuSize(stats?.dataLength),
    indexes: formatV2TableContextMenuSize(stats?.indexLength),
  });
};
