/** @vitest-environment jsdom */

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSidebarTreeEvents } from './useSidebarTreeEvents';
import {
  resetTableDdlOpenPreferenceForTests,
  writeTableDdlOpenOnClick,
} from '../../utils/tableDdlOpenPreference';

vi.mock('../../store', () => ({
  useStore: (selector: (state: any) => unknown) => selector({
    appearance: { uiLayoutMode: 'classic' },
  }),
}));

const tableNode = {
  key: 'table-main-users',
  title: 'users',
  type: 'table',
  dataRef: {
    id: 'conn-1',
    dbName: 'main',
    tableName: 'users',
  },
};

const captureEvents = () => {
  let api: ReturnType<typeof useSidebarTreeEvents> | null = null;
  const addTab = vi.fn();
  const noop = vi.fn();
  const Probe = () => {
    api = useSidebarTreeEvents({
      loadDatabases: noop,
      loadJVMResources: noop,
      loadTables: noop,
      loadNacosConfigGroups: noop,
      loadNacosServiceGroups: noop,
      refreshGlobalExternalSQLRootNode: noop,
      replaceTreeNodeChildren: noop,
      connections: [],
      addTab,
      openEventDefinition: noop,
      openSequenceDefinition: noop,
      openPackageDefinition: noop,
      openMessageQueueWorkbench: noop,
      selectedSidebarKeyRef: { current: '' },
      setConnectionStates: noop,
      resolveSidebarSelectionContext: () => null,
      publishTitlebarSnapshotUpdate: noop,
      treeDragSelectSuppressUntilRef: { current: 0 },
      isTreeDragging: false,
      setSidebarSelectedKeys: noop,
      selectedNodesRef: { current: [] },
      publishTitlebarSelection: noop,
      connectionIds: [],
      publishTitlebarSelectionForNode: noop,
      setActiveContext: noop,
      clickTimerRef: { current: null },
      sidebarTreeDragNodeRef: { current: null },
      setExpandedKeys: noop,
      setAutoExpandParent: noop,
      clearTreeNodeChildrenByKeys: noop,
      recordTableAccess: noop,
      tableDoubleClickAction: 'open-data',
      resolveSavedQueryDisplayName: (name: string | null | undefined) => name || '',
      openExternalSQLFile: noop,
      openJVMOverviewTab: noop,
      openJVMResourceTab: noop,
      openJVMMonitoringTab: noop,
      openJVMDiagnosticTab: noop,
      expandedKeys: [],
    } as any);
    return null;
  };
  const container = document.createElement('div');
  const root = createRoot(container);
  act(() => root.render(<Probe />));
  act(() => root.unmount());
  return { api: api as unknown as ReturnType<typeof useSidebarTreeEvents>, addTab };
};

describe('sidebar table DDL toggle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    window.localStorage.clear();
    resetTableDdlOpenPreferenceForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetTableDdlOpenPreferenceForTests();
  });

  it('opens DDL on a single table click when the toggle is on', () => {
    writeTableDdlOpenOnClick(true);
    const { api, addTab } = captureEvents();

    act(() => {
      api.onSelect([tableNode.key], {
        node: tableNode,
        selectedNodes: [tableNode],
        selected: true,
      });
    });
    act(() => {
      vi.advanceTimersByTime(250);
    });

    expect(addTab).toHaveBeenCalledWith(expect.objectContaining({
      id: 'table-main-users',
      tableName: 'users',
      initialViewMode: 'ddl',
    }));
  });

  it('keeps the single click inert when the toggle is off', () => {
    const { api, addTab } = captureEvents();

    act(() => {
      api.onSelect([tableNode.key], {
        node: tableNode,
        selectedNodes: [tableNode],
        selected: true,
      });
    });
    act(() => {
      vi.advanceTimersByTime(250);
    });

    expect(addTab).not.toHaveBeenCalled();
  });

  it('does not open DDL for a modifier multi-select click', () => {
    writeTableDdlOpenOnClick(true);
    const { api, addTab } = captureEvents();

    act(() => {
      api.onSelect([tableNode.key], {
        node: tableNode,
        selectedNodes: [tableNode],
        selected: true,
        nativeEvent: { metaKey: true },
      });
    });
    act(() => {
      vi.advanceTimersByTime(250);
    });

    expect(addTab).not.toHaveBeenCalled();
  });

  it('opens DDL on a table double click when the toggle is on', () => {
    writeTableDdlOpenOnClick(true);
    const { api, addTab } = captureEvents();

    act(() => {
      api.onDoubleClick(null, tableNode);
    });

    expect(addTab).toHaveBeenCalledWith(expect.objectContaining({
      id: 'table-main-users',
      initialViewMode: 'ddl',
    }));
  });
});
