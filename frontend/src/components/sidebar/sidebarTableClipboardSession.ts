import { message } from 'antd';

import { t } from '../../i18n';
import type {
  SidebarTableClipboardCommand,
  SidebarTableClipboardEntry,
  UseSidebarTableClipboardInput,
} from './useSidebarTableClipboard';

let clipboardEntries: SidebarTableClipboardEntry[] | null = null;

export const getSidebarTableClipboardEntries = (): SidebarTableClipboardEntry[] | null => clipboardEntries;

export const clearSidebarTableClipboard = (): void => { clipboardEntries = null; };

export const getSidebarTableClipboardCommandKey = (command: SidebarTableClipboardCommand): string => {
  if (command.kind === 'none') return '';
  const target = 'target' in command
    ? [command.target.connectionId, command.target.database, command.target.schema]
    : null;
  return JSON.stringify([
    command.kind,
    command.entries.map((entry) => [entry.connectionId, entry.database, entry.schema, entry.table]),
    target,
  ]);
};

const copyTableNames = async (entries: SidebarTableClipboardEntry[]): Promise<void> => {
  try {
    await navigator.clipboard.writeText(entries.map((entry) => entry.table).join('\n'));
    message.success(t('sidebar.multi_table_menu.copy_names_done', { count: entries.length }));
  } catch (error: unknown) {
    message.error(t('sidebar.copy_object_name.failed', {
      label: t('sidebar.copy_object_name.label.table'),
      error: error instanceof Error ? error.message : String(error),
    }));
  }
};

export const applySidebarTableClipboardCommand = (
  command: SidebarTableClipboardCommand,
  state: Pick<UseSidebarTableClipboardInput, 'activeShortcutPlatform' | 'onCopyTables' | 'onOpenDataSyncWorkbench'>,
): void => {
  switch (command.kind) {
    case 'copy':
      clipboardEntries = command.entries;
      message.success(t(command.entries.length === 1
        ? 'sidebar.table_clipboard.copy_success'
        : 'sidebar.table_clipboard.copy_success_multiple', {
        table: command.entries[0].table,
        count: command.entries.length,
        shortcut: state.activeShortcutPlatform === 'mac' ? '⌘V' : 'Ctrl+V',
      }));
      return;
    case 'copy-names':
      clearSidebarTableClipboard();
      void copyTableNames(command.entries);
      return;
    case 'paste-copy-table':
      state.onCopyTables(command.entries.map((entry) => entry.node));
      return;
    case 'paste-via-data-sync':
      if (state.onOpenDataSyncWorkbench) state.onOpenDataSyncWorkbench('sync', command.prefill);
      else message.warning(t('sidebar.table_clipboard.data_sync_unavailable'));
      return;
    case 'paste-target-missing':
      message.warning(t('sidebar.table_clipboard.target_required'));
      return;
    case 'paste-mixed-sources':
      message.warning(t('sidebar.table_clipboard.mixed_sources'));
      return;
    default:
      return;
  }
};
