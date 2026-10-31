import { Modal, message } from 'antd';

import { t } from '../../i18n';
import { buildRpcConnectionConfig } from '../../utils/connectionRpcConfig';
import { confirmProductionMutation } from '../../utils/productionRiskConfirm';
import { ClearTables, DropTable, TruncateTables } from '../../../wailsjs/go/app/App';
import { showCountdownDangerConfirm } from '../common/countdownDangerConfirm';
import { resolveNodeSchemaName } from './sidebarObjectActionHelpers';

// 多表右键菜单里的批量动作。truncate 走后端批量接口；drop 后端只有单表
// 接口，前端按表循环并在结束后统一刷新涉及的库。生产确认（productionRiskConfirm）
// 逐连接执行一次，不允许绕过。

export type SidebarMultiTableNode = {
  key?: unknown;
  type?: string;
  title?: unknown;
  dataRef?: Record<string, any>;
};

type RunSidebarMultiTableDangerActionDeps = {
  buildRuntimeConfig: (conn: any, overrideDatabase?: string, clearDatabase?: boolean) => any;
  loadTables: (node: any, options?: { ensureFresh?: boolean; schemaName?: string }) => Promise<void>;
  getDatabaseNodeRef: (connRef: any, dbName: string) => any;
};

type TableGroup = {
  connectionId: string;
  dbName: string;
  schemaName?: string;
  dataRef: Record<string, any>;
  tableNames: string[];
  nodes: SidebarMultiTableNode[];
};

const groupTablesByDatabase = (nodes: SidebarMultiTableNode[]): TableGroup[] => {
  const groups = new Map<string, TableGroup>();
  nodes.forEach((node) => {
    const dataRef = node.dataRef || {};
    const connectionId = String(dataRef.id || '');
    const dbName = String(dataRef.dbName || '');
    const tableName = String(dataRef.tableName || node.title || '').trim();
    if (!connectionId || !dbName || !tableName) return;
    const groupKey = `${connectionId}\u0000${dbName}\u0000${String(dataRef.schemaName || '')}`;
    const existing = groups.get(groupKey);
    if (existing) {
      existing.tableNames.push(tableName);
      existing.nodes.push(node);
      return;
    }
    groups.set(groupKey, {
      connectionId,
      dbName,
      schemaName: resolveNodeSchemaName(node),
      dataRef,
      tableNames: [tableName],
      nodes: [node],
    });
  });
  return Array.from(groups.values());
};

const refreshGroups = async (
  groups: TableGroup[],
  deps: RunSidebarMultiTableDangerActionDeps,
) => {
  await Promise.all(groups.map((group) => deps.loadTables(
    deps.getDatabaseNodeRef(group.dataRef, group.dbName),
    { ensureFresh: true, schemaName: group.schemaName },
  )));
};

const confirmEachProductionConnection = async (groups: TableGroup[]): Promise<boolean> => {
  const confirmed = new Set<string>();
  for (const group of groups) {
    if (confirmed.has(group.connectionId)) continue;
    const ok = await confirmProductionMutation(
      group.dataRef as any,
      t('connection.production_risk.action.execute_sql'),
      [group.dbName, `×${group.tableNames.length}`].filter(Boolean).join(' / '),
      t,
    );
    if (!ok) return false;
    confirmed.add(group.connectionId);
  }
  return true;
};

/** 复制多张表的表名（按可视选择顺序逐行拼接）。 */
export const copySidebarMultiTableNames = async (nodes: SidebarMultiTableNode[]): Promise<void> => {
  const names = nodes
    .map((node) => String(node.dataRef?.tableName || node.title || '').trim())
    .filter(Boolean);
  if (names.length === 0) return;
  try {
    await navigator.clipboard.writeText(names.join('\n'));
    message.success(t('sidebar.multi_table_menu.copy_names_done', { count: names.length }));
  } catch (error: any) {
    message.error(t('sidebar.copy_object_name.failed', { label: '', error: error?.message || String(error) }));
  }
};

export const runSidebarMultiTableTruncate = async (
  deps: RunSidebarMultiTableDangerActionDeps,
  nodes: SidebarMultiTableNode[],
): Promise<void> => {
  const groups = groupTablesByDatabase(nodes);
  const total = groups.reduce((sum, group) => sum + group.tableNames.length, 0);
  if (total === 0) return;
  const confirmed = await new Promise<boolean>((resolve) => {
    Modal.confirm({
      title: t('sidebar.multi_table_menu.confirm_truncate_title', { count: total }),
      content: t('sidebar.multi_table_menu.confirm_truncate_content'),
      okText: t('sidebar.action.continue'),
      cancelText: t('common.cancel'),
      okButtonProps: { danger: true },
      onOk: () => resolve(true),
      onCancel: () => resolve(false),
    });
  });
  if (!confirmed) return;
  if (!await confirmEachProductionConnection(groups)) return;

  const hide = message.loading(t('sidebar.multi_table_menu.action_loading', { count: total }), 0);
  let succeeded = 0;
  try {
    for (const group of groups) {
      const config = deps.buildRuntimeConfig(group.dataRef, group.dbName);
      const res = await TruncateTables(buildRpcConnectionConfig(config) as any, group.dbName, group.tableNames);
      if (res.success) succeeded += group.tableNames.length;
      else message.error(res.message);
    }
  } finally {
    hide();
  }
  await refreshGroups(groups, deps);
  message.success(t('sidebar.multi_table_menu.action_done', { success: succeeded, total }));
};

export const runSidebarMultiTableDrop = async (
  deps: RunSidebarMultiTableDangerActionDeps,
  nodes: SidebarMultiTableNode[],
): Promise<void> => {
  const groups = groupTablesByDatabase(nodes);
  const total = groups.reduce((sum, group) => sum + group.tableNames.length, 0);
  if (total === 0) return;
  showCountdownDangerConfirm({
    title: t('sidebar.multi_table_menu.confirm_drop_title', { count: total }),
    content: t('sidebar.multi_table_menu.confirm_drop_content'),
    onOk: async () => {
      if (!await confirmEachProductionConnection(groups)) return;
      const hide = message.loading(t('sidebar.multi_table_menu.action_loading', { count: total }), 0);
      let succeeded = 0;
      try {
        for (const group of groups) {
          const config = deps.buildRuntimeConfig(group.dataRef, group.dbName);
          for (const tableName of group.tableNames) {
            const res = await DropTable(buildRpcConnectionConfig(config) as any, group.dbName, tableName);
            if (res.success) succeeded += 1;
            else message.error(res.message);
          }
        }
      } finally {
        hide();
      }
      await refreshGroups(groups, deps);
      message.success(t('sidebar.multi_table_menu.action_done', { success: succeeded, total }));
    },
  });
};

// ClearTables 与 Truncate 共用批量接口；菜单按能力开关单独呈现。
export const runSidebarMultiTableClear = async (
  deps: RunSidebarMultiTableDangerActionDeps,
  nodes: SidebarMultiTableNode[],
): Promise<void> => {
  const groups = groupTablesByDatabase(nodes);
  const total = groups.reduce((sum, group) => sum + group.tableNames.length, 0);
  if (total === 0) return;
  const confirmed = await new Promise<boolean>((resolve) => {
    Modal.confirm({
      title: t('sidebar.multi_table_menu.confirm_truncate_title', { count: total }),
      content: t('sidebar.multi_table_menu.confirm_truncate_content'),
      okText: t('sidebar.action.continue'),
      cancelText: t('common.cancel'),
      okButtonProps: { danger: true },
      onOk: () => resolve(true),
      onCancel: () => resolve(false),
    });
  });
  if (!confirmed) return;
  if (!await confirmEachProductionConnection(groups)) return;

  const hide = message.loading(t('sidebar.multi_table_menu.action_loading', { count: total }), 0);
  let succeeded = 0;
  try {
    for (const group of groups) {
      const config = deps.buildRuntimeConfig(group.dataRef, group.dbName);
      const res = await ClearTables(buildRpcConnectionConfig(config) as any, group.dbName, group.tableNames);
      if (res.success) succeeded += group.tableNames.length;
      else message.error(res.message);
    }
  } finally {
    hide();
  }
  await refreshGroups(groups, deps);
  message.success(t('sidebar.multi_table_menu.action_done', { success: succeeded, total }));
};
