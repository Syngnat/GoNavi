import { describe, expect, it } from 'vitest';
import {
  isSidebarSwitcherLoading,
  resolveSidebarSwitcherLoadKey,
  shouldKeepSidebarSwitcherCollapsedWhileLoading,
} from './sidebarSwitcherState';

// Nacos 命名空间下的两个入口节点（配置管理 / 服务管理）走的是手动 onLoadData，
// loadKey 由各自 loader 写入 loadingNodesRef。这两条 key 一旦和 loader 不一致，
// 双击后界面就没有任何加载反馈，所以这里把键名逐字锁死。
const buildNacosNode = (
  type: 'nacos-config-entry' | 'nacos-services-entry',
  dataRef: Record<string, unknown>,
) => ({
  key: `${String(dataRef.id)}-${type}`,
  data: {
    key: `${String(dataRef.id)}-${type}`,
    title: type,
    type,
    dataRef,
    isLeaf: false,
  },
});

describe('sidebarSwitcherState Nacos load keys', () => {
  it('maps the config entry to the key loadNacosConfigGroups writes', () => {
    const node = buildNacosNode('nacos-config-entry', {
      id: 'nacos-1',
      nacosNamespaceId: 'dev-ns',
    });

    expect(resolveSidebarSwitcherLoadKey(node)).toBe('nacos-groups-nacos-1-dev-ns');
  });

  it('maps the services entry to the key loadNacosServiceGroups writes', () => {
    const node = buildNacosNode('nacos-services-entry', {
      id: 'nacos-1',
      nacosNamespaceId: 'dev-ns',
    });

    expect(resolveSidebarSwitcherLoadKey(node)).toBe(
      'nacos-service-groups-nacos-1-dev-ns',
    );
  });

  it('falls back to the public namespace when the id is empty', () => {
    const configNode = buildNacosNode('nacos-config-entry', { id: 'nacos-1' });
    const servicesNode = buildNacosNode('nacos-services-entry', {
      id: 'nacos-1',
      nacosNamespaceId: '',
    });

    expect(resolveSidebarSwitcherLoadKey(configNode)).toBe('nacos-groups-nacos-1-public');
    expect(resolveSidebarSwitcherLoadKey(servicesNode)).toBe(
      'nacos-service-groups-nacos-1-public',
    );
  });

  it('returns null when the connection id is missing', () => {
    const node = buildNacosNode('nacos-config-entry', { id: '' });

    expect(resolveSidebarSwitcherLoadKey(node)).toBeNull();
  });

  it('reports loading for a Nacos node while its key is pending', () => {
    const node = buildNacosNode('nacos-config-entry', {
      id: 'nacos-1',
      nacosNamespaceId: 'dev-ns',
    });

    expect(isSidebarSwitcherLoading(node, new Set(['nacos-groups-nacos-1-dev-ns']))).toBe(true);
    expect(isSidebarSwitcherLoading(node, new Set())).toBe(false);
    // A key belonging to another namespace must not light up this row.
    expect(isSidebarSwitcherLoading(node, new Set(['nacos-groups-nacos-1-other-ns']))).toBe(false);
  });

  it('keeps the legacy collapsed-arrow predicate behaviour', () => {
    const node = buildNacosNode('nacos-services-entry', {
      id: 'nacos-1',
      nacosNamespaceId: 'dev-ns',
    });

    expect(
      shouldKeepSidebarSwitcherCollapsedWhileLoading(
        node,
        new Set(['nacos-service-groups-nacos-1-dev-ns']),
      ),
    ).toBe(true);
    expect(shouldKeepSidebarSwitcherCollapsedWhileLoading(node, new Set())).toBe(false);
  });

  it('treats the rc-tree loading flag as loading even without a registered key', () => {
    const node = {
      key: 'conn-1-main',
      data: {
        key: 'conn-1-main',
        title: 'main',
        type: 'database' as const,
        dataRef: { id: 'conn-1', dbName: 'main' },
      },
      loading: true,
    };

    expect(isSidebarSwitcherLoading(node, new Set())).toBe(true);
  });

  it('never reports loading for a leaf node', () => {
    const node = {
      key: 'table-users',
      data: {
        key: 'table-users',
        title: 'users',
        type: 'table' as const,
        dataRef: { id: 'conn-1', dbName: 'main', tableName: 'users' },
      },
      isLeaf: true,
    };

    expect(isSidebarSwitcherLoading(node, new Set(['nacos-groups-conn-1-public']))).toBe(false);
  });
});
