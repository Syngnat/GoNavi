import type { SavedConnection } from '../../types';
import { getDataSourceSpec } from '../../utils/dataSourceRegistry';
import type { SidebarTreeNode } from './sidebarV2TreeNodes';

/** 描述表声明为隐藏的 schema（扩展内部 schema，如 TimescaleDB 的 _timescaledb_catalog、GBase 8c 的 dbe_perf）。 */
export const isRegistryHiddenSchema = (conn: SavedConnection | undefined, schemaName: string): boolean => {
  const ui = getDataSourceSpec(conn?.config?.type)?.ui;
  const normalized = String(schemaName || '').trim().toLowerCase();
  if (!ui || normalized === '') return false;
  return (ui.hiddenSchemas ?? []).some((name) => name.toLowerCase() === normalized)
    || (ui.hiddenSchemaPrefixes ?? []).some((prefix) => normalized.startsWith(prefix.toLowerCase()));
};

/**
 * 去掉描述表声明为不支持的对象分组（如 TiDB 没有存储过程、触发器与事件），
 * 避免借用 MySQL / PostgreSQL 方言的数据源在侧栏出现永远为空的分组。
 */
export const filterRegistryObjectGroups = (
  conn: SavedConnection | undefined,
  groups: SidebarTreeNode[],
): SidebarTreeNode[] => {
  const hidden = getDataSourceSpec(conn?.config?.type)?.ui?.hiddenObjectGroups;
  if (!hidden || hidden.length === 0) return groups;
  return groups.filter((group) => !hidden.includes(String(group.dataRef?.groupKey ?? '')));
};
