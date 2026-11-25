import React, { useCallback, useRef, useState } from 'react';
import { message } from 'antd';

import { t } from '../../i18n';
import { SidebarMultiTableRenameModal } from './SidebarMultiTableRenameModal';
import {
  buildSidebarMultiTableRenameEntries,
  buildSidebarMultiTableRenamePlan,
  runSidebarMultiTableRename,
  type RunSidebarMultiTableRenameDeps,
  type SidebarMultiTableRenameEntry,
  type SidebarMultiTableRenameNode,
} from './sidebarMultiTableRename';

type UseSidebarMultiTableRenameOptions = RunSidebarMultiTableRenameDeps & {
  extractObjectName: (fullName: string) => string;
};

export const useSidebarMultiTableRename = ({
  buildRuntimeConfig,
  loadTables,
  getDatabaseNodeRef,
  resolveConnection,
  extractObjectName,
}: UseSidebarMultiTableRenameOptions) => {
  const [entries, setEntries] = useState<SidebarMultiTableRenameEntry[] | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);

  const openMultiTableRenameModal = useCallback((nodes: SidebarMultiTableRenameNode[]) => {
    const nextEntries = buildSidebarMultiTableRenameEntries(nodes, extractObjectName);
    if (nextEntries.length === 0) {
      message.warning(t('sidebar.multi_table_menu.rename_no_tables'));
      return;
    }
    setEntries(nextEntries);
  }, [extractObjectName]);

  const closeMultiTableRenameModal = useCallback(() => {
    if (submittingRef.current) return;
    setEntries(null);
  }, []);

  const submitMultiTableRename = useCallback(async (newNames: string[]) => {
    if (!entries || submittingRef.current) return;
    const plan = buildSidebarMultiTableRenamePlan(entries, newNames, extractObjectName);
    if (!plan.ok) {
      if (plan.reason === 'required') {
        message.warning(t('sidebar.validation.new_table_name_required'));
      } else if (plan.reason === 'unchanged') {
        message.warning(t('sidebar.message.table_name_unchanged'));
      } else {
        message.warning(t('sidebar.multi_table_menu.rename_no_tables'));
      }
      return;
    }

    submittingRef.current = true;
    setSubmitting(true);
    try {
      const result = await runSidebarMultiTableRename(
        { buildRuntimeConfig, loadTables, getDatabaseNodeRef, resolveConnection },
        plan,
      );
      if (!result.cancelled) {
        setEntries(null);
      }
    } catch (error: any) {
      message.error(t('sidebar.message.rename_failed', {
        error: error?.message || String(error),
      }));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }, [
    buildRuntimeConfig,
    entries,
    extractObjectName,
    getDatabaseNodeRef,
    loadTables,
    resolveConnection,
  ]);

  const multiTableRenameModal = (
    <SidebarMultiTableRenameModal
      open={entries !== null}
      entries={entries || []}
      submitting={submitting}
      onCancel={closeMultiTableRenameModal}
      onSubmit={(newNames) => { void submitMultiTableRename(newNames); }}
    />
  );

  return {
    openMultiTableRenameModal,
    multiTableRenameModal,
  };
};

export type SidebarMultiTableRenameApi = ReturnType<typeof useSidebarMultiTableRename>;
