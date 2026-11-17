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
  | { kind: 'copy'; entries: SidebarTableClipboardEntry[] }
  | { kind: 'paste-copy-table'; entries: SidebarTableClipboardEntry[]; target: SidebarTableClipboardTarget }
  | {
      kind: 'paste-via-data-sync';
      entries: SidebarTableClipboardEntry[];
      target: SidebarTableClipboardTarget;
      prefill: DataSyncPastePrefill;
    }
  | { kind: 'paste-target-missing'; entries: SidebarTableClipboardEntry[] }
  | { kind: 'paste-mixed-sources'; entries: SidebarTableClipboardEntry[] };

export type SidebarTableClipboardCommandInput = {
  event: KeyboardEvent;
  shortcutPlatform: ShortcutPlatform;
  selectedNodes: any[];
  clipboard: SidebarTableClipboardEntry[] | null;
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
  clipboard: SidebarTableClipboardEntry[] | null;
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

export const resolveSidebarTableClipboardEntries = (
  nodes: any[],
  connectionIds: string[],
): SidebarTableClipboardEntry[] | null => {
  const selectedNodes = Array.isArray(nodes) ? nodes : [];
  if (selectedNodes.length === 0) return null;
  const entries: SidebarTableClipboardEntry[] = [];
  for (const node of selectedNodes) {
    const entry = resolveSidebarTableClipboardEntry(node, connectionIds);
    if (!entry) return null;
    entries.push(entry);
  }
  return entries;
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

export const resolveSidebarTableClipboardPasteTarget = (
  nodes: any[],
  connectionIds: string[],
): SidebarTableClipboardTarget | null => {
  const selectedNodes = Array.isArray(nodes) ? nodes : [];
  if (selectedNodes.length === 0) return null;
  if (selectedNodes.length === 1) {
    return resolveSidebarTableClipboardTarget(selectedNodes[0], connectionIds);
  }
  const targets = selectedNodes.map((node) => (
    resolveSidebarTableClipboardTarget(node, connectionIds)
  ));
  if (targets.some((target) => !target)) return null;
  const first = targets[0]!;
  return targets.every((target) => (
    target!.connectionId === first.connectionId
    && target!.database === first.database
    && target!.schema === first.schema
  ))
    ? first
    : null;
};

export const canCopySidebarTableDirectly = (
  entry: SidebarTableClipboardEntry,
): boolean => {
  const config = entry?.node?.dataRef?.config;
  return Boolean(config) && getDataSourceCapabilities(config).supportsCopyTable;
};

export const areSidebarTableClipboardEntriesFromSameSource = (
  entries: SidebarTableClipboardEntry[],
): boolean => {
  if (!Array.isArray(entries) || entries.length === 0) return false;
  const first = entries[0];
  return entries.every((entry) => (
    entry.connectionId === first.connectionId
    && entry.database === first.database
    && entry.schema === first.schema
  ));
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
  sources: SidebarTableClipboardEntry[],
  target: SidebarTableClipboardTarget,
): DataSyncPastePrefill => {
  const first = sources[0];
  const tables = sources.map((source) => source.table);
  return {
    source: {
      connectionId: first.connectionId,
      database: first.database,
      ...(first.schema ? { schema: first.schema } : {}),
      ...(tables.length === 1 ? { table: tables[0] } : {}),
      tables,
    },
    target: {
      connectionId: target.connectionId,
      database: target.database,
      ...(target.schema ? { schema: target.schema } : {}),
    },
  };
};

const resolveSidebarTablePasteCommand = ({
  selectedNodes,
  clipboard,
  connectionIds,
  supportsDirectCopy = canCopySidebarTableDirectly,
}: Pick<
  SidebarTableClipboardCommandInput,
  'selectedNodes' | 'clipboard' | 'connectionIds' | 'supportsDirectCopy'
>): SidebarTableClipboardCommand => {
  if (!clipboard || clipboard.length === 0) {
    return { kind: 'none' };
  }
  if (!areSidebarTableClipboardEntriesFromSameSource(clipboard)) {
    return { kind: 'paste-mixed-sources', entries: clipboard };
  }
  const nodes = Array.isArray(selectedNodes) ? selectedNodes : [];
  const target = resolveSidebarTableClipboardPasteTarget(nodes, connectionIds);
  if (!target) {
    return { kind: 'paste-target-missing', entries: clipboard };
  }
  const sameDatabase = clipboard.every((entry) => isSameSidebarTableDatabase(entry, target));
  if (sameDatabase && clipboard.every((entry) => supportsDirectCopy(entry))) {
    return { kind: 'paste-copy-table', entries: clipboard, target };
  }
  return {
    kind: 'paste-via-data-sync',
    entries: clipboard,
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
    const entries = resolveSidebarTableClipboardEntries(nodes, connectionIds);
    return entries ? { kind: 'copy', entries } : { kind: 'none' };
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
  const entries = resolveSidebarTableClipboardEntries(nodes, connectionIds);
  return entries ? { kind: 'copy', entries } : { kind: 'none' };
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
  onCopyTables: (nodes: any[]) => void;
  onOpenDataSyncWorkbench?: (entryMode: 'sync', prefill: DataSyncPastePrefill) => void;
  blocked?: boolean;
};

export const useSidebarTableClipboard = ({
  rootRef,
  selectedNodesRef,
  connectionIds,
  activeShortcutPlatform,
  onCopyTables,
  onOpenDataSyncWorkbench,
  blocked = false,
}: UseSidebarTableClipboardInput): void => {
  const clipboardRef = useRef<SidebarTableClipboardEntry[] | null>(null);
  const sidebarActiveRef = useRef(false);
  const lastHandledRef = useRef<{ action: 'copy' | 'paste'; at: number } | null>(null);
  const stateRef = useRef({
    selectedNodesRef,
    connectionIds,
    activeShortcutPlatform,
    onCopyTables,
    onOpenDataSyncWorkbench,
    blocked,
  });
  stateRef.current = {
    selectedNodesRef,
    connectionIds,
    activeShortcutPlatform,
    onCopyTables,
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
          clipboardRef.current = command.entries;
          if (command.entries.length === 1) {
            message.success(t('sidebar.table_clipboard.copy_success', {
              table: command.entries[0].table,
              shortcut: state.activeShortcutPlatform === 'mac' ? '⌘V' : 'Ctrl+V',
            }));
          } else {
            message.success(t('sidebar.table_clipboard.copy_success_multiple', {
              count: command.entries.length,
              shortcut: state.activeShortcutPlatform === 'mac' ? '⌘V' : 'Ctrl+V',
            }));
          }
          return;
        case 'paste-copy-table':
          state.onCopyTables(command.entries.map((entry) => entry.node));
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
        case 'paste-mixed-sources':
          message.warning(t('sidebar.table_clipboard.mixed_sources'));
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
