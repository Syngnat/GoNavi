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

export type SidebarTableClipboardCopyEventInput = {
  event: ClipboardEvent;
  selectedNodes: any[];
  connectionIds: string[];
};

export type SidebarTableClipboardPasteEventInput = {
  event: ClipboardEvent;
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

const resolveSidebarTablePasteCommand = ({
  selectedNodes,
  clipboard,
  connectionIds,
  supportsDirectCopy = canCopySidebarTableDirectly,
}: Pick<
  SidebarTableClipboardCommandInput,
  'selectedNodes' | 'clipboard' | 'connectionIds' | 'supportsDirectCopy'
>): SidebarTableClipboardCommand => {
  if (!clipboard) {
    return { kind: 'none' };
  }
  const nodes = Array.isArray(selectedNodes) ? selectedNodes : [];
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
  return resolveSidebarTablePasteCommand({
    selectedNodes: nodes,
    clipboard,
    connectionIds,
    supportsDirectCopy,
  });
};

export const resolveSidebarTableClipboardCopyEventCommand = ({
  event,
  selectedNodes,
  connectionIds,
}: SidebarTableClipboardCopyEventInput): SidebarTableClipboardCommand => {
  if (event.defaultPrevented || isEditableElement(event.target)) {
    return { kind: 'none' };
  }
  const nodes = Array.isArray(selectedNodes) ? selectedNodes : [];
  if (nodes.length !== 1) return { kind: 'none' };
  const entry = resolveSidebarTableClipboardEntry(nodes[0], connectionIds);
  return entry ? { kind: 'copy', entry } : { kind: 'none' };
};

export const resolveSidebarTableClipboardPasteEventCommand = ({
  event,
  selectedNodes,
  clipboard,
  connectionIds,
  supportsDirectCopy,
}: SidebarTableClipboardPasteEventInput): SidebarTableClipboardCommand => {
  if (event.defaultPrevented || isEditableElement(event.target)) {
    return { kind: 'none' };
  }
  return resolveSidebarTablePasteCommand({
    selectedNodes,
    clipboard,
    connectionIds,
    supportsDirectCopy,
  });
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
  const lastHandledRef = useRef<{ action: 'copy' | 'paste'; at: number } | null>(null);
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
    const handleMouseDown = (event: MouseEvent) => {
      sidebarActiveRef.current = isInsideActiveRegion(event.target);
    };
    const handleFocusIn = (event: FocusEvent) => {
      sidebarActiveRef.current = isInsideActiveRegion(event.target);
    };
    const applyCommand = (
      command: SidebarTableClipboardCommand,
      state: typeof stateRef.current,
      event: Event,
      action: 'copy' | 'paste',
    ) => {
      if (command.kind === 'none') return;
      event.preventDefault();

      // macOS 原生编辑菜单和 keydown 可能先后触发同一操作，去重避免重复弹窗。
      const now = Date.now();
      const previous = lastHandledRef.current;
      if (previous && previous.action === action && now - previous.at < 150) {
        return;
      }
      lastHandledRef.current = { action, at: now };

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
      applyCommand(command, state, event, command.kind === 'copy' ? 'copy' : 'paste');
    };
    const handleCopy = (event: ClipboardEvent) => {
      if (!sidebarActiveRef.current && !isInsideActiveRegion(event.target)) return;
      const state = stateRef.current;
      if (state.blocked) return;
      const command = resolveSidebarTableClipboardCopyEventCommand({
        event,
        selectedNodes: state.selectedNodesRef.current,
        connectionIds: state.connectionIds,
      });
      applyCommand(command, state, event, 'copy');
    };
    const handlePaste = (event: ClipboardEvent) => {
      if (!sidebarActiveRef.current && !isInsideActiveRegion(event.target)) return;
      const state = stateRef.current;
      if (state.blocked) return;
      const command = resolveSidebarTableClipboardPasteEventCommand({
        event,
        selectedNodes: state.selectedNodesRef.current,
        clipboard: clipboardRef.current,
        connectionIds: state.connectionIds,
      });
      applyCommand(command, state, event, 'paste');
    };

    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('mousedown', handleMouseDown, true);
    document.addEventListener('focusin', handleFocusIn, true);
    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('copy', handleCopy);
    document.addEventListener('paste', handlePaste);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('mousedown', handleMouseDown, true);
      document.removeEventListener('focusin', handleFocusIn, true);
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('copy', handleCopy);
      document.removeEventListener('paste', handlePaste);
    };
  }, [rootRef]);
};
