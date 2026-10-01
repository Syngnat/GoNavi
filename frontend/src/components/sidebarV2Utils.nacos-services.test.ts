import { describe, expect, it } from 'vitest';

import {
  applySidebarDatabasePinning,
  buildV2SidebarDatabaseSectionedChildren,
  buildNacosServicesTabData,
  resolveNacosNamespaceDiscoveryModeFromTreeNode,
  resolveNacosServicesDoubleClickAction,
  shouldLoadSidebarNodeOnExpand as shouldLoadV2SidebarNodeOnExpand,
} from './sidebarV2Utils';
import { buildSidebarDatabasePinKey } from '../store';
import { shouldLoadSidebarNodeOnExpand } from './sidebar/sidebarHelpers';

const namespaceData = {
  id: 'nacos-1',
  nacosNamespaceId: 'mkefu-dev',
  nacosNamespaceName: 'mkefu development',
};

describe('Nacos service group navigation', () => {
  it('pins namespaces by stable namespace id while retaining their children and display names', () => {
    const namespaces = [
      { key: 'nacos-1-nacos-ns-dev', title: 'Development', type: 'nacos-namespace' as const,
        dataRef: { id: 'nacos-1', nacosNamespaceId: 'dev', nacosNamespaceName: 'Development' },
        children: [{ key: 'dev-config', title: 'Config' }] },
      { key: 'nacos-1-nacos-ns-prod', title: 'Production', type: 'nacos-namespace' as const,
        dataRef: { id: 'nacos-1', nacosNamespaceId: 'prod', nacosNamespaceName: 'Production' } },
    ];
    const pinned = applySidebarDatabasePinning(namespaces, {
      connectionId: 'nacos-1',
      pinnedSidebarDatabases: [buildSidebarDatabasePinKey('nacos-1', 'prod')],
    });
    expect(pinned.map((node) => node.title)).toEqual(['Production', 'Development']);
    expect(pinned[0].dataRef.pinnedSidebarDatabase).toBe(true);
    expect(pinned[1].children).toEqual(namespaces[0].children);
    expect(buildV2SidebarDatabaseSectionedChildren('nacos-1', pinned).map((node) => node.type)).toEqual([
      'v2-database-section', 'nacos-namespace', 'v2-database-section', 'nacos-namespace',
    ]);
  });
  it('recovers configured namespace discovery mode from preserved children after a root rebuild', () => {
    expect(resolveNacosNamespaceDiscoveryModeFromTreeNode({
      type: 'connection',
      dataRef: {
        id: 'nacos-1',
        config: { type: 'nacos' },
      },
      children: [
        {
          title: 'Development',
          key: 'nacos-1-nacos-ns-dev',
          type: 'nacos-namespace',
          dataRef: {
            id: 'nacos-1',
            nacosNamespaceDiscoveryMode: 'configured',
          },
        },
      ],
    })).toBe('configured');
  });

  it('keeps the service explorer entry as a lazy folder on double click', () => {
    const entryNode = {
      type: 'nacos-services-entry' as const,
      children: [],
      isLeaf: false,
    };
    expect(shouldLoadV2SidebarNodeOnExpand(entryNode)).toBe(true);
    expect(shouldLoadSidebarNodeOnExpand(entryNode)).toBe(true);
    expect(resolveNacosServicesDoubleClickAction({
      type: 'nacos-services-entry',
      dataRef: namespaceData,
    })).toEqual({ kind: 'expand' });
  });

  it('opens the all-services tab without a group filter', () => {
    const tab = buildNacosServicesTabData({
      ...namespaceData,
      nacosGroup: '',
    });

    expect(tab).toMatchObject({
      id: 'nacos-services-nacos-1-ns-mkefu-dev',
      type: 'nacos-services',
      connectionId: 'nacos-1',
      nacosNamespaceId: 'mkefu-dev',
      nacosNamespaceName: 'mkefu development',
    });
    expect(tab).not.toHaveProperty('nacosGroup');
  });

  it('opens a group-specific tab with an isolated id and filter', () => {
    const action = resolveNacosServicesDoubleClickAction({
      type: 'nacos-service-group',
      dataRef: {
        ...namespaceData,
        nacosGroup: 'MKEFU SERVICE',
      },
    });

    expect(action).toEqual({
      kind: 'open',
      tab: expect.objectContaining({
        id: 'nacos-services-nacos-1-ns-mkefu-dev-g-MKEFU%20SERVICE',
        title: 'mkefu development · MKEFU SERVICE',
        type: 'nacos-services',
        nacosGroup: 'MKEFU SERVICE',
      }),
    });
  });

  it('does not collide when a namespace contains the group delimiter', () => {
    const allServices = buildNacosServicesTabData({
      id: 'nacos-1',
      nacosNamespaceId: 'dev-g-orders',
      nacosNamespaceName: 'Combined namespace',
    });
    const groupServices = buildNacosServicesTabData({
      id: 'nacos-1',
      nacosNamespaceId: 'dev',
      nacosNamespaceName: 'Development',
      nacosGroup: 'orders',
    });

    expect(allServices.id).not.toBe(groupServices.id);
  });
});
