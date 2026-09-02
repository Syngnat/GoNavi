import type { SetStateAction } from 'react';
import type { SavedConnection, TabData } from '../types';
import { resolveConnectionHostSummary } from './tabDisplay';

export type TitlebarSelectionContext = {
  connectionId: string;
  dbName: string;
  tableName?: string;
  /** Canonical Host row key used by the Sidebar connection-state renderer. */
  sidebarStateKey?: string;
};

export type TitlebarActiveContext = TitlebarSelectionContext | null | undefined;

export type TitlebarContext = {
  connection: SavedConnection | null;
  connectionId: string;
  connectionName: string;
  hostSummary: string;
  databaseName: string;
  tableName: string;
  sidebarStateKey: string;
};

/**
 * Status values rendered by the title bar connection marker.
 *
 * `default` means that a saved connection is selected but the Sidebar has no
 * current Host-row load result. It is intentionally distinct from `success`,
 * which mirrors the Sidebar Host row after a metadata request has completed
 * successfully.
 */
export type TitlebarConnectionStatus =
  | 'idle'
  | 'default'
  | 'loading'
  | 'success'
  | 'error';

export type TitlebarSidebarConnectionState = Exclude<TitlebarConnectionStatus, 'idle' | 'default'>;

/**
 * The Sidebar publishes selection and Host-row state together so the title
 * bar never renders a selection from one update with a state from another.
 */
export type TitlebarSidebarSnapshot = {
  selection: TitlebarSelectionContext | null;
  connectionStates: Readonly<Record<string, TitlebarSidebarConnectionState>>;
  /** Monotonic Sidebar publication revision used to reject stale renders. */
  revision?: number;
};

/**
 * Merge a Sidebar publication into the title-bar snapshot.
 *
 * Sidebar selection and loader state are produced by different React updates.
 * A layout effect from an older render can therefore arrive after a newer
 * selection event. Revisions let the App keep the newest complete snapshot
 * without changing the local Sidebar state model.
 */
export const mergeTitlebarSidebarSnapshot = (
  current: TitlebarSidebarSnapshot,
  incoming: TitlebarSidebarSnapshot,
): TitlebarSidebarSnapshot => {
  const currentRevision = Number.isFinite(current.revision) ? Number(current.revision) : 0;
  const incomingRevision = Number.isFinite(incoming.revision) ? Number(incoming.revision) : 0;
  return incomingRevision < currentRevision ? current : incoming;
};

/**
 * Applies a Sidebar selection update while retaining the newest Host state
 * map held by the title bar. The one-argument form returns a functional
 * React state action so an event can publish selection without overwriting a
 * connection-state result that arrived in the same render batch. The
 * two-argument form is kept as a pure convenience for callers/tests that
 * already have a snapshot value.
 */
export function updateTitlebarSidebarSelection(
  selection: TitlebarSelectionContext | null,
): (snapshot: TitlebarSidebarSnapshot) => TitlebarSidebarSnapshot;
export function updateTitlebarSidebarSelection(
  snapshot: TitlebarSidebarSnapshot,
  selection: TitlebarSelectionContext | null,
): TitlebarSidebarSnapshot;
export function updateTitlebarSidebarSelection(
  snapshotOrSelection: TitlebarSidebarSnapshot | TitlebarSelectionContext | null,
  selection?: TitlebarSelectionContext | null,
): SetStateAction<TitlebarSidebarSnapshot> | TitlebarSidebarSnapshot {
  if (isTitlebarSidebarSnapshot(snapshotOrSelection)) {
    return {
      ...snapshotOrSelection,
      selection: selection ?? null,
    };
  }

  const nextSelection = snapshotOrSelection;
  return (snapshot) => ({
    ...snapshot,
    selection: nextSelection,
  });
}

const isTitlebarSidebarSnapshot = (
  value: TitlebarSidebarSnapshot | TitlebarSelectionContext | null,
): value is TitlebarSidebarSnapshot => Boolean(
  value
  && typeof value === 'object'
  && 'connectionStates' in value
  && 'selection' in value,
);

/**
 * Maps the selected connection and the Sidebar's latest Host-row state to a
 * title-bar status. The Sidebar state is a load/result indicator rather than
 * a long-lived transport-health probe, but the title bar should still mirror
 * the same state that the selected Host row renders.
 */
export const resolveTitlebarConnectionStatus = ({
  connectionId,
  sidebarStateKey,
  hasConnection,
  connectionStates,
}: {
  connectionId?: unknown;
  /** Canonical Host-row key; child-row keys are intentionally ignored. */
  sidebarStateKey?: unknown;
  hasConnection: boolean;
  connectionStates?: Readonly<Record<string, TitlebarSidebarConnectionState>> | null;
}): TitlebarConnectionStatus => {
  const normalizedConnectionId = toTrimmedString(connectionId);
  if (!hasConnection || !normalizedConnectionId) return 'idle';

  // The title-bar marker represents the Host row, not a database/table's
  // metadata request. Database rows use the same state map for their own
  // spinners, so consulting a selected child row here makes the marker drift
  // away from the Host shown in the Sidebar.
  const normalizedStateKey = toTrimmedString(sidebarStateKey);
  const hostStateKey = normalizedStateKey === normalizedConnectionId
    ? normalizedStateKey
    : normalizedConnectionId;
  const sidebarState = connectionStates?.[hostStateKey];
  if (sidebarState === 'loading' || sidebarState === 'success' || sidebarState === 'error') {
    return sidebarState;
  }

  return 'default';
};

const toTrimmedString = (value: unknown): string => String(value || '').trim();

/**
 * Resolves the context shown in the title bar. Sidebar context takes priority,
 * while the active workbench tab fills the gap only when nothing is selected.
 */
export const resolveTitlebarContext = ({
  activeContext,
  sidebarContext,
  activeTab,
  connections,
}: {
  activeContext: TitlebarActiveContext;
  /** The current tree selection, when the Sidebar has one. */
  sidebarContext?: TitlebarActiveContext;
  activeTab: TabData | null | undefined;
  connections: SavedConnection[];
}): TitlebarContext => {
  // The workbench tab can belong to another connection than the tree row the
  // user is currently inspecting. Keep the title bar anchored to that row;
  // activeContext remains the fallback for views without a tree selection.
  const selectedContext = toTrimmedString(sidebarContext?.connectionId)
    ? sidebarContext
    : activeContext;
  const contextConnectionId = toTrimmedString(selectedContext?.connectionId);
  const contextDatabaseName = toTrimmedString(selectedContext?.dbName);
  const contextTableName = toTrimmedString(selectedContext?.tableName);
  const sidebarStateKey = toTrimmedString(selectedContext?.sidebarStateKey);
  const activeTabConnectionId = toTrimmedString(activeTab?.connectionId);
  const activeTabDatabaseName = toTrimmedString(activeTab?.dbName);
  const connectionId = contextConnectionId || activeTabConnectionId;
  const connection = connections.find((item) => item.id === connectionId) || null;
  const hasExplicitContext = Boolean(contextConnectionId);
  const contextMatchesConnection = Boolean(
    connection && contextConnectionId === connection.id,
  );
  const databaseName = contextMatchesConnection
    ? contextDatabaseName
    : hasExplicitContext
      ? ''
      : activeTabDatabaseName;
  const activeTabMatchesContext = !hasExplicitContext
    ? true
    : contextMatchesConnection
      && Boolean(contextDatabaseName)
      && contextDatabaseName === activeTabDatabaseName;
  const tableName = contextMatchesConnection && contextDatabaseName && contextTableName
    ? contextTableName
    : connection
      && activeTabConnectionId === connection.id
      && activeTabMatchesContext
      ? toTrimmedString(activeTab?.tableName)
      : '';

  return {
    connection,
    connectionId,
    connectionName: toTrimmedString(connection?.name),
    hostSummary: resolveConnectionHostSummary(connection?.config),
    databaseName,
    tableName,
    sidebarStateKey,
  };
};
