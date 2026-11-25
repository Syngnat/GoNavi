/** @vitest-environment jsdom */

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { useSidebarTreeEvents } from './useSidebarTreeEvents';

vi.mock('../../store', () => ({
  useStore: (selector: (state: any) => unknown) => selector({
    appearance: { uiLayoutMode: 'classic' },
  }),
}));

const agentNode = {
  key: 'agent-codex',
  title: 'ChatGPT',
  type: 'agent-integration',
  dataRef: {
    integrationId: 'codex',
    kind: 'codex',
    displayName: 'ChatGPT',
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

describe('sidebar agent session entry', () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

  it('opens the agent session workbench on a plain click', () => {
    const { api, addTab } = captureEvents();

    act(() => {
      api.onSelect(['agent-codex'], {
        node: agentNode,
        selectedNodes: [agentNode],
        selected: true,
      });
    });

    expect(addTab).toHaveBeenCalledWith(expect.objectContaining({
      id: 'agent-assets:codex',
      type: 'agent-assets',
      agentIntegrationId: 'codex',
    }));
  });

  it('keeps the workbench entry working on double click', () => {
    const { api, addTab } = captureEvents();

    act(() => {
      api.onDoubleClick(null, agentNode);
    });

    expect(addTab).toHaveBeenCalledWith(expect.objectContaining({
      id: 'agent-assets:codex',
      type: 'agent-assets',
      agentIntegrationId: 'codex',
    }));
  });
});
