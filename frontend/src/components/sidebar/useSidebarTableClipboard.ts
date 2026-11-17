import { useEffect, useRef, type MutableRefObject, type RefObject } from 'react';
import { message } from 'antd';

import { t } from '../../i18n';
import type { DataSyncPastePrefill } from '../dataSyncEntryMode';
import {
  isEditableElement,
  isShortcutMatch,
  type ShortcutPlatform,
} from '../../utils/shortcuts';
import { getDataSourceCapabilities } from '../../utils/dataSourceCapabilities';
import { resolveSidebarNodeConnectionId } from '../sidebarV2Utils';

export type SidebarTableClipboardEntry = {
  node: any;
  connectionId: string;
  database: string;
  schema: string;
  table: string;
};

export type SidebarTableClipboardTarget = {
  connectionId: string;
  database: string;
  schema: string;
};

export type SidebarTableClipboardCommand =
  | { kind: 'none' }
  | { kind: 'copy'; entry: SidebarTableClipboardEntry }
  | { kind: 'paste-copy-table'; entry: SidebarTableClipboardEntry; target: SidebarTableClipboardTarget }
  | {
      kind: 'paste-via-data-sync';
      entry: SidebarTableClipboardEntry;
      target: SidebarTableClipboardTarget;
      prefill: DataSyncPastePrefill;
    }
  | { kind: 'paste-target-missing'; entry: SidebarTableClipboardEntry };

export type SidebarTableClipboardCommandInput = {
  event: KeyboardEvent;
  shortcutPlatform: ShortcutPlatform;
  selectedNodes: any[];
  clipboard: SidebarTableClipboardEntry | null;
  connectionIds: string[];
  supportsDirectCopy?: (entry: SidebarTableClipboardEntry) => boolean;
};

const normalizePart = (value: unknown): string => String(value ?? '').trim();

export const resolveSidebarTableClipboardEntry = (
  node: any,
  connectionIds: string[],
): SidebarTableClipboardEntry | null => {
  if (!node || node.type !== 'table') return null;
  const dataRef = node.dataRef;
  const connectionId = resolveSidebarNodeConnectionId(node, connectionIds)
    || normalizePart(dataRef?.id)
    || normalizePart(dataRef?.connectionId);
  const database = normalizePart(dataRef?.dbName);
  const table = normalizePart(dataRef?.tableName) || normalizePart(node.title);
  if (!connectionId || !database || !table) return null;
  return {
    node,
    connectionId,
    database,
    schema: normalizePart(dataRef?.schemaName),
    table,
  };
};

export const resolveSidebarTableClipboardTarget = (
  node: any,
  connectionIds: string[],
): SidebarTableClipboardTarget | null => {
  if (!node) return null;
  const dataRef = node.dataRef;
  const type = String(node.type || '');
  const isSupportedType = type === 'database'
    || type === 'table'
    || (type === 'object-group'
      && (dataRef?.groupKey === 'schema' || dataRef?.groupKey === 'tables'));
  if (!isSupportedType) return null;

  const connectionId = resolveSidebarNodeConnectionId(node, connectionIds)
    || normalizePart(dataRef?.id)
    || normalizePart(dataRef?.connectionId);
  const database = normalizePart(dataRef?.dbName);
  if (!connectionId || !database) return null;
  return {
    connectionId,
    database,
    schema: normalizePart(dataRef?.schemaName),
  };
};

export const canCopySidebarTableDirectly = (
  entry: SidebarTableClipboardEntry,
): boolean => {
  const config = entry?.node?.dataRef?.config;
  return Boolean(config) && getDataSourceCapabilities(config).supportsCopyTable;
};

export const isSameSidebarTableDatabase = (
  source: SidebarTableClipboardEntry,
  target: SidebarTableClipboardTarget,
): boolean => {
  if (source.connectionId !== target.connectionId) return false;
  if (source.database !== target.database) return false;
  const targetSchema = target.schema;
  if (!targetSchema) return true;
  const sourceSchema = source.schema;
  return Boolean(sourceSchema) && sourceSchema === targetSchema;
};

export const buildSidebarTablePastePrefill = (
  source: SidebarTableClipboardEntry,
  target: SidebarTableClipboardTarget,
): DataSyncPastePrefill => ({
  source: {
    connectionId: source.connectionId,
    database: source.database,
    ...(source.schema ? { schema: source.schema } : {}),
    table: source.table,
  },
  target: {
    connectionId: target.connectionId,
    database: target.database,
    ...(target.schema ? { schema: target.schema } : {}),
  },
});

export const resolveSidebarTableClipboardCommand = ({
  event,
  shortcutPlatform,
  selectedNodes,
  clipboard,
  connectionIds,
  supportsDirectCopy = canCopySidebarTableDirectly,
}: SidebarTableClipboardCommandInput): SidebarTableClipboardCommand => {
  if (event.defaultPrevented || isEditableElement(event.target)) {
    return { kind: 'none' };
  }

  const nodes = Array.isArray(selectedNodes) ? selectedNodes : [];
  const copyShortcut = shortcutPlatform === 'mac' ? 'Meta+C' : 'Ctrl+C';
  if (isShortcutMatch(event, copyShortcut)) {
    if (nodes.length !== 1) return { kind: 'none' };
    const entry = resolveSidebarTableClipboardEntry(nodes[0], connectionIds);
    return entry ? { kind: 'copy', entry } : { kind: 'none' };
  }

  const pasteShortcut = shortcutPlatform === 'mac' ? 'Meta+V' : 'Ctrl+V';
  if (!isShortcutMatch(event, pasteShortcut) || !clipboard) {
    return { kind: 'none' };
  }
  if (nodes.length !== 1) {
    return { kind: 'paste-target-missing', entry: clipboard };
  }
  const target = resolveSidebarTableClipboardTarget(nodes[0], connectionIds);
  if (!target) {
    return { kind: 'paste-target-missing', entry: clipboard };
  }
  if (isSameSidebarTableDatabase(clipboard, target) && supportsDirectCopy(clipboard)) {
    return { kind: 'paste-copy-table', entry: clipboard, target };
  }
  return {
    kind: 'paste-via-data-sync',
    entry: clipboard,
    target,
    prefill: buildSidebarTablePastePrefill(clipboard, target),
  };
};

export type UseSidebarTableClipboardInput = {
  rootRef: RefObject<HTMLElement | null>;
  selectedNodesRef: MutableRefObject<any[]>;
  connectionIds: string[];
  activeShortcutPlatform: ShortcutPlatform;
  onCopyTable: (node: any) => void;
  onOpenDataSyncWorkbench?: (entryMode: 'sync', prefill: DataSyncPastePrefill) => void;
  blocked?: boolean;
};

export const useSidebarTableClipboard = ({
  rootRef,
  selectedNodesRef,
  connectionIds,
  activeShortcutPlatform,
  onCopyTable,
  onOpenDataSyncWorkbench,
  blocked = false,
}: UseSidebarTableClipboardInput): void => {
  const clipboardRef = useRef<SidebarTableClipboardEntry | null>(null);
  const sidebarActiveRef = useRef(false);
  const stateRef = useRef({
    selectedNodesRef,
    connectionIds,
    activeShortcutPlatform,
    onCopyTable,
    onOpenDataSyncWorkbench,
    blocked,
  });
  stateRef.current = {
    selectedNodesRef,
    connectionIds,
    activeShortcutPlatform,
    onCopyTable,
    onOpenDataSyncWorkbench,
    blocked,
  };

  useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof document === 'undefined') return;

    const resolveActiveRegion = (): HTMLElement => (
      root.querySelector<HTMLElement>('[data-sidebar-tree-panel="true"]') || root
    );
    const isInsideActiveRegion = (target: EventTarget | null): boolean => {
      const element = target as Node | null;
      if (!element) return false;
      return resolveActiveRegion().contains(element);
    };

    const handlePointerDown = (event: PointerEvent) => {
      sidebarActiveRef.current = isInsideActiveRegion(event.target);
    };
    const handleFocusIn = (event: FocusEvent) => {
      sidebarActiveRef.current = isInsideActiveRegion(event.target);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!sidebarActiveRef.current && !isInsideActiveRegion(event.target)) return;
      const state = stateRef.current;
      if (state.blocked) return;

      const command = resolveSidebarTableClipboardCommand({
        event,
        shortcutPlatform: state.activeShortcutPlatform,
        selectedNodes: state.selectedNodesRef.current,
        clipboard: clipboardRef.current,
        connectionIds: state.connectionIds,
      });
      if (command.kind === 'none') return;

      event.preventDefault();
      switch (command.kind) {
        case 'copy':
          clipboardRef.current = command.entry;
          message.success(t('sidebar.table_clipboard.copy_success', {
            table: command.entry.table,
            shortcut: state.activeShortcutPlatform === 'mac' ? '⌘V' : 'Ctrl+V',
          }));
          return;
        case 'paste-copy-table':
          state.onCopyTable(command.entry.node);
          return;
        case 'paste-via-data-sync':
          if (state.onOpenDataSyncWorkbench) {
            state.onOpenDataSyncWorkbench('sync', command.prefill);
          } else {
            message.warning(t('sidebar.table_clipboard.data_sync_unavailable'));
          }
          return;
        case 'paste-target-missing':
          message.warning(t('sidebar.table_clipboard.target_required'));
          return;
        default:
          return;
      }
    };

    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('focusin', handleFocusIn, true);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('focusin', handleFocusIn, true);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [rootRef]);
};
