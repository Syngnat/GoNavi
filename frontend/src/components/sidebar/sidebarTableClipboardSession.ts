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
    command.entries.map((entry) => [entry.objectKind, entry.connectionId, entry.database, entry.schema, entry.table]),
    target,
  ]);
};

const copyTableNames = async (entries: SidebarTableClipboardEntry[]): Promise<void> => {
  const isView = entries[0]?.objectKind === 'view';
  try {
    await navigator.clipboard.writeText(entries.map((entry) => entry.table).join('\n'));
    message.success(t(isView
      ? 'sidebar.view_clipboard.copy_names_done'
      : 'sidebar.multi_table_menu.copy_names_done', { count: entries.length }));
  } catch (error: unknown) {
    message.error(t('sidebar.copy_object_name.failed', {
      label: t(isView ? 'sidebar.copy_object_name.label.view' : 'sidebar.copy_object_name.label.table'),
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
      {
        const isView = command.entries[0]?.objectKind === 'view';
        message.success(t(isView
          ? (command.entries.length === 1
            ? 'sidebar.view_clipboard.copy_success'
            : 'sidebar.view_clipboard.copy_success_multiple')
          : (command.entries.length === 1
            ? 'sidebar.table_clipboard.copy_success'
            : 'sidebar.table_clipboard.copy_success_multiple'), {
          ...(isView
            ? { view: command.entries[0].table }
            : { table: command.entries[0].table }),
          count: command.entries.length,
          shortcut: state.activeShortcutPlatform === 'mac' ? '⌘V' : 'Ctrl+V',
        }));
      }
      return;
    case 'copy-names':
      clearSidebarTableClipboard();
      void copyTableNames(command.entries);
      return;
    case 'paste-copy-table':
    case 'paste-copy-view':
      // 粘贴是显式动作，直接执行；右键「复制整表」等显式复制仍保留确认弹窗。
      state.onCopyTables(
        command.entries.map((entry) => entry.node),
        command.target,
        { skipConfirmation: true },
      );
      return;
    case 'paste-views-cross-connection':
      message.warning(t('sidebar.view_clipboard.same_connection_required'));
      return;
    case 'paste-views-unsupported':
      message.warning(t('sidebar.view_clipboard.unsupported'));
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
