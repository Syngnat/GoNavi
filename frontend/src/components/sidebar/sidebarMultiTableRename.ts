import { message } from 'antd';

import { t } from '../../i18n';
import { buildRpcConnectionConfig } from '../../utils/connectionRpcConfig';
import { confirmProductionMutation } from '../../utils/productionRiskConfirm';
import { RenameTable } from '../../../wailsjs/go/app/App';

export type SidebarMultiTableRenameNode = {
  key?: unknown;
  title?: unknown;
  dataRef?: Record<string, any>;
};

export type SidebarMultiTableRenameEntry = {
  node: SidebarMultiTableRenameNode;
  connectionId: string;
  dbName: string;
  schemaName?: string;
  oldTableName: string;
  newTableName: string;
  databaseLabel: string;
};

export type SidebarMultiTableRenameChange = SidebarMultiTableRenameEntry & {
  nextTableName: string;
};

export type SidebarMultiTableRenameGroup = {
  connectionId: string;
  dbName: string;
  schemaName?: string;
  dataRef: Record<string, any>;
  changes: SidebarMultiTableRenameChange[];
};

export type SidebarMultiTableRenamePlan =
  | { ok: true; groups: SidebarMultiTableRenameGroup[]; total: number }
  | { ok: false; reason: 'empty' | 'required' | 'unchanged' };

export type RunSidebarMultiTableRenameDeps = {
  buildRuntimeConfig: (conn: any, overrideDatabase?: string, clearDatabase?: boolean) => any;
  loadTables: (node: any, options?: { ensureFresh?: boolean; schemaName?: string }) => Promise<void>;
  getDatabaseNodeRef: (connRef: any, dbName: string) => any;
  resolveConnection: (connRef: any) => any;
};

export type RunSidebarMultiTableRenameResult = {
  cancelled: boolean;
  succeeded: number;
  total: number;
};

const tableGroupKey = (connectionId: string, dbName: string, schemaName?: string): string => (
  `${connectionId}\u0000${dbName}\u0000${schemaName || ''}`
);

export const buildSidebarMultiTableRenameEntries = (
  nodes: ReadonlyArray<SidebarMultiTableRenameNode>,
  extractObjectName: (fullName: string) => string,
): SidebarMultiTableRenameEntry[] => {
  const entries: SidebarMultiTableRenameEntry[] = [];
  const seen = new Set<string>();
  nodes.forEach((node) => {
    const dataRef = node?.dataRef || {};
    const connectionId = String(dataRef.id || '').trim();
    const connectionName = String(dataRef.name || '').trim();
    const dbName = String(dataRef.dbName || '').trim();
    const oldTableName = String(dataRef.tableName || node?.title || '').trim();
    if (!connectionId || !dbName || !oldTableName) return;
    const schemaName = String(dataRef.schemaName ?? '').trim() || undefined;
    const entryKey = `${tableGroupKey(connectionId, dbName, schemaName)}\u0000${oldTableName}`;
    if (seen.has(entryKey)) return;
    seen.add(entryKey);
    entries.push({
      node,
      connectionId,
      dbName,
      schemaName,
      oldTableName,
      newTableName: String(extractObjectName(oldTableName) || oldTableName).trim(),
      databaseLabel: [
        connectionName,
        [dbName, schemaName].filter(Boolean).join('.'),
      ].filter(Boolean).join(' / '),
    });
  });
  return entries;
};

export const buildSidebarMultiTableRenamePlan = (
  entries: ReadonlyArray<SidebarMultiTableRenameEntry>,
  newNames: ReadonlyArray<unknown>,
  extractObjectName: (fullName: string) => string,
): SidebarMultiTableRenamePlan => {
  if (entries.length === 0) return { ok: false, reason: 'empty' };

  const groups = new Map<string, SidebarMultiTableRenameGroup>();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const nextTableName = String(newNames[index] ?? '').trim();
    if (!nextTableName) return { ok: false, reason: 'required' };
    const currentObjectName = String(extractObjectName(entry.oldTableName) || entry.oldTableName).trim();
    if (nextTableName === currentObjectName || nextTableName === entry.oldTableName) continue;

    const key = tableGroupKey(entry.connectionId, entry.dbName, entry.schemaName);
    const change: SidebarMultiTableRenameChange = { ...entry, nextTableName };
    const group = groups.get(key);
    if (group) {
      group.changes.push(change);
      continue;
    }
    groups.set(key, {
      connectionId: entry.connectionId,
      dbName: entry.dbName,
      schemaName: entry.schemaName,
      dataRef: entry.node.dataRef || {},
      changes: [change],
    });
  }

  const planGroups = Array.from(groups.values());
  const total = planGroups.reduce((sum, group) => sum + group.changes.length, 0);
  if (total === 0) return { ok: false, reason: 'unchanged' };
  return { ok: true, groups: planGroups, total };
};

const confirmEachProductionConnection = async (
  groups: ReadonlyArray<SidebarMultiTableRenameGroup>,
  deps: RunSidebarMultiTableRenameDeps,
): Promise<boolean> => {
  const scopes = new Map<string, { group: SidebarMultiTableRenameGroup; count: number }>();
  for (const group of groups) {
    const current = scopes.get(group.connectionId);
    if (current) {
      current.count += group.changes.length;
      continue;
    }
    scopes.set(group.connectionId, { group, count: group.changes.length });
  }

  for (const { group, count } of scopes.values()) {
    const target = [
      group.dbName,
      group.schemaName,
      `×${count}`,
    ].filter(Boolean).join(' / ');
    const connection = deps.resolveConnection(group.dataRef) || group.dataRef;
    const ok = await confirmProductionMutation(
      connection,
      t('sidebar.menu.rename_table'),
      target,
      t,
    );
    if (!ok) return false;
  }
  return true;
};

const refreshRenamedGroups = async (
  groups: ReadonlyArray<SidebarMultiTableRenameGroup>,
  deps: RunSidebarMultiTableRenameDeps,
): Promise<void> => {
  await Promise.all(groups.map(async (group) => {
    try {
      await deps.loadTables(
        deps.getDatabaseNodeRef(group.dataRef, group.dbName),
        { ensureFresh: true, schemaName: group.schemaName },
      );
    } catch {
      // A refresh failure must not hide the rename result or trigger an unhandled rejection.
    }
  }));
};

export const runSidebarMultiTableRename = async (
  deps: RunSidebarMultiTableRenameDeps,
  plan: Extract<SidebarMultiTableRenamePlan, { ok: true }>,
): Promise<RunSidebarMultiTableRenameResult> => {
  if (!await confirmEachProductionConnection(plan.groups, deps)) {
    return { cancelled: true, succeeded: 0, total: plan.total };
  }

  const hide = message.loading(t('sidebar.multi_table_menu.action_loading', { count: plan.total }), 0);
  let succeeded = 0;
  try {
    for (const group of plan.groups) {
      const connection = deps.resolveConnection(group.dataRef) || group.dataRef;
      const config = deps.buildRuntimeConfig(connection, group.dbName);
      for (const change of group.changes) {
        try {
          const res = await RenameTable(
            buildRpcConnectionConfig(config) as any,
            group.dbName,
            change.oldTableName,
            change.nextTableName,
          );
          if (res.success) {
            succeeded += 1;
          } else {
            message.error(t('sidebar.message.rename_failed', {
              error: `${change.oldTableName}: ${res.message}`,
            }));
          }
        } catch (error: any) {
          message.error(t('sidebar.message.rename_failed', {
            error: `${change.oldTableName}: ${error?.message || String(error)}`,
          }));
        }
      }
    }
  } finally {
    hide();
  }

  await refreshRenamedGroups(plan.groups, deps);
  if (succeeded === plan.total) {
    message.success(t('sidebar.message.table_renamed'));
  } else {
    message.warning(t('sidebar.multi_table_menu.action_done', {
      success: succeeded,
      total: plan.total,
    }));
  }
  return { cancelled: false, succeeded, total: plan.total };
};
