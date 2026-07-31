import React from 'react';
import { message } from 'antd';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useSidebarTreeLoaders } from './useSidebarTreeLoaders';

const mocks = vi.hoisted(() => ({
  replaceTreeNodeChildren: vi.fn(),
  setLoadedKeys: vi.fn(),
  storeState: {
    connections: [] as any[],
    tableSortPreference: {} as Record<string, string>,
    tableAccessCount: {} as Record<string, number>,
    pinnedSidebarTables: [] as string[],
  },
}));

vi.mock('antd', () => ({
  message: {
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock('../../store', async () => {
  const actual = await vi.importActual<typeof import('../../store')>('../../store');
  const useStore = Object.assign(vi.fn(), {
    getState: () => mocks.storeState,
  });
  return { ...actual, useStore };
});

vi.mock('../../../wailsjs/go/app/App', () => ({
  DBGetDatabases: vi.fn(),
  DBGetTables: vi.fn(),
  DBQuery: vi.fn(),
  GetDriverStatusList: vi.fn(),
  JVMProbeCapabilities: vi.fn(),
}));

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

const deferred = <T,>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
};

describe('useSidebarTreeLoaders Nacos service groups', () => {
  let renderer: ReactTestRenderer | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.replaceTreeNodeChildren.mockImplementation((_key, children) => children || []);
  });

  afterEach(() => {
    act(() => renderer?.unmount());
    renderer = null;
    vi.unstubAllGlobals();
  });

  it('keeps a forced refresh result when an older group request resolves later', async () => {
    const oldResponse = deferred<any>();
    const refreshedResponse = deferred<any>();
    const listServices = vi.fn()
      .mockReturnValueOnce(oldResponse.promise)
      .mockReturnValueOnce(refreshedResponse.promise);
    vi.stubGlobal('window', {
      go: { app: { App: { NacosListServices: listServices } } },
    });

    let loaders: ReturnType<typeof useSidebarTreeLoaders> | undefined;
    const loadingNodesRef = { current: new Set<string>() };
    const Harness = () => {
      loaders = useSidebarTreeLoaders({
        savedQueries: [],
        tableSortPreference: {},
        tableAccessCount: {},
        pinnedSidebarTables: [],
        isV2Ui: true,
        loadingNodesRef,
        setConnectionStates: vi.fn(),
        setLoadedKeys: mocks.setLoadedKeys,
        replaceTreeNodeChildren: mocks.replaceTreeNodeChildren,
        buildRuntimeConfig: (conn) => conn.config,
        buildJVMRuntimeConfig: (conn) => conn.config,
        buildJVMDiagnosticTreeNodes: () => [],
        resolveSavedQueryDisplayName: (name) => String(name || ''),
      });
      return null;
    };

    act(() => {
      renderer = create(<Harness />);
    });

    const node = {
      key: 'nacos-1-nacos-ns-dev-services',
      dataRef: {
        id: 'nacos-1',
        nacosNamespaceId: 'dev',
        nacosNamespaceName: 'Development',
        config: { type: 'nacos', host: '127.0.0.1', port: 8848 },
      },
    };
    const oldLoad = loaders!.loadNacosServiceGroups(node);
    const refreshedLoad = loaders!.loadNacosServiceGroups(node, { force: true });

    refreshedResponse.resolve({
      success: true,
      data: { count: 1, serviceNames: ['NEW_GROUP@@orders'] },
    });
    await act(async () => {
      expect(await refreshedLoad).toBe(true);
    });

    expect(mocks.replaceTreeNodeChildren).toHaveBeenCalledTimes(1);
    expect(mocks.replaceTreeNodeChildren.mock.calls[0][1].map((item: any) => item.dataRef.nacosGroup))
      .toEqual(['', 'NEW_GROUP']);

    oldResponse.resolve({
      success: true,
      data: { count: 1, serviceNames: ['OLD_GROUP@@legacy'] },
    });
    await act(async () => {
      expect(await oldLoad).toBe(false);
    });

    expect(mocks.replaceTreeNodeChildren).toHaveBeenCalledTimes(1);
    expect(loadingNodesRef.current.size).toBe(0);
  });
});

describe('useSidebarTreeLoaders Nacos namespace discovery', () => {
  let renderer: ReactTestRenderer | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.storeState.connections = [];
    mocks.replaceTreeNodeChildren.mockImplementation((_key, children) => children || []);
  });

  afterEach(() => {
    act(() => renderer?.unmount());
    renderer = null;
    vi.unstubAllGlobals();
  });

  const renderNamespaceLoader = () => {
    let loaders: ReturnType<typeof useSidebarTreeLoaders> | undefined;
    let connectionStates: Record<string, string> = {};
    const setConnectionStates = vi.fn((updater: any) => {
      connectionStates =
        typeof updater === 'function' ? updater(connectionStates) : updater;
    });
    const loadingNodesRef = { current: new Set<string>() };
    const Harness = () => {
      loaders = useSidebarTreeLoaders({
        savedQueries: [],
        tableSortPreference: {},
        tableAccessCount: {},
        pinnedSidebarTables: [],
        isV2Ui: true,
        loadingNodesRef,
        setConnectionStates,
        setLoadedKeys: mocks.setLoadedKeys,
        replaceTreeNodeChildren: mocks.replaceTreeNodeChildren,
        buildRuntimeConfig: (conn) => conn.config,
        buildJVMRuntimeConfig: (conn) => conn.config,
        buildJVMDiagnosticTreeNodes: () => [],
        resolveSavedQueryDisplayName: (name) => String(name || ''),
      });
      return null;
    };

    act(() => {
      renderer = create(<Harness />);
    });
    return {
      get loaders() {
        return loaders!;
      },
      get connectionStates() {
        return connectionStates;
      },
      loadingNodesRef,
    };
  };

  const buildNode = (connectionParams = '') => {
    const dataRef = {
      id: 'nacos-1',
      name: 'Nacos',
      config: {
        type: 'nacos',
        host: '127.0.0.1',
        port: 8848,
        connectionParams,
      },
    };
    mocks.storeState.connections = [dataRef];
    return {
      key: 'nacos-1',
      dataRef,
    };
  };

  it('discards a stale namespace response without clearing the newer load marker', async () => {
    const staleResponse = deferred<any>();
    const currentResponse = deferred<any>();
    const listNamespaces = vi.fn()
      .mockReturnValueOnce(staleResponse.promise)
      .mockReturnValueOnce(currentResponse.promise);
    vi.stubGlobal('window', {
      go: { app: { App: { NacosListNamespaces: listNamespaces } } },
    });
    const harness = renderNamespaceLoader();
    const staleNode = buildNode('namespaceId=old-scope');
    mocks.storeState.connections = [staleNode.dataRef];

    const staleLoad = harness.loaders.loadDatabases(staleNode);
    const duplicateLoad = harness.loaders.loadDatabases(staleNode);
    expect(listNamespaces).toHaveBeenCalledTimes(1);
    await expect(duplicateLoad).resolves.toBeUndefined();

    const currentNode = buildNode('namespaceId=current-scope');
    mocks.storeState.connections = [currentNode.dataRef];
    const currentLoad = harness.loaders.loadDatabases(currentNode);

    expect(listNamespaces).toHaveBeenCalledTimes(2);
    expect(harness.loadingNodesRef.current.has('dbs-nacos-1')).toBe(true);

    staleResponse.resolve({
      success: false,
      message: 'forbidden',
      data: { errorCode: 'nacos_namespace_list_forbidden' },
    });
    await act(async () => {
      await staleLoad;
    });

    expect(mocks.replaceTreeNodeChildren).not.toHaveBeenCalled();
    expect(harness.loadingNodesRef.current.has('dbs-nacos-1')).toBe(true);
    expect(message.warning).not.toHaveBeenCalled();

    currentResponse.resolve({
      success: false,
      message: 'forbidden',
      data: { errorCode: 'nacos_namespace_list_forbidden' },
    });
    await act(async () => {
      await currentLoad;
    });

    expect(mocks.replaceTreeNodeChildren).toHaveBeenCalledTimes(1);
    const [, namespaces, rootDataRef] =
      mocks.replaceTreeNodeChildren.mock.calls[0];
    expect(namespaces[0]).toMatchObject({
      title: 'current-scope',
      dataRef: {
        nacosNamespaceId: 'current-scope',
        nacosNamespaceDiscoveryMode: 'configured',
      },
    });
    expect(rootDataRef.config.connectionParams).toBe(
      'namespaceId=current-scope',
    );
    expect(harness.loadingNodesRef.current.size).toBe(0);
    expect(harness.connectionStates['nacos-1']).toBe('success');
  });

  it('keeps the full namespace list when discovery is allowed even if a scope is configured', async () => {
    vi.stubGlobal('window', {
      go: {
        app: {
          App: {
            NacosListNamespaces: vi.fn().mockResolvedValue({
              success: true,
              data: [
                { id: '', showName: 'public' },
                { id: 'dev', showName: 'Development' },
              ],
            }),
          },
        },
      },
    });
    const harness = renderNamespaceLoader();

    await act(async () => {
      await harness.loaders.loadDatabases(buildNode('namespaceId=dev'));
    });

    const [, namespaces, rootDataRef] =
      mocks.replaceTreeNodeChildren.mock.calls[0];
    expect(namespaces).toHaveLength(2);
    expect(
      namespaces.map((namespace: any) => namespace.dataRef.nacosNamespaceId),
    ).toEqual(['', 'dev']);
    expect(
      namespaces.every(
        (namespace: any) =>
          namespace.dataRef.nacosNamespaceDiscoveryMode === 'listed',
      ),
    ).toBe(true);
    expect(rootDataRef.nacosNamespaceDiscoveryMode).toBe('listed');
    expect(harness.connectionStates['nacos-1']).toBe('success');
    expect(message.warning).not.toHaveBeenCalled();
  });

  it('falls back to the explicitly configured namespace only for the stable forbidden code', async () => {
    const listNamespaces = vi.fn().mockResolvedValue({
      success: false,
      message: 'forbidden',
      data: { errorCode: 'nacos_namespace_list_forbidden' },
    });
    vi.stubGlobal('window', {
      go: { app: { App: { NacosListNamespaces: listNamespaces } } },
    });
    const harness = renderNamespaceLoader();

    await act(async () => {
      await harness.loaders.loadDatabases(
        buildNode('contextPath=%2Fnacos&namespaceId=dev'),
      );
    });

    expect(mocks.replaceTreeNodeChildren).toHaveBeenCalledTimes(1);
    const [key, namespaces, rootDataRef] =
      mocks.replaceTreeNodeChildren.mock.calls[0];
    expect(key).toBe('nacos-1');
    expect(namespaces).toHaveLength(1);
    expect(namespaces[0]).toMatchObject({
      title: 'dev',
      type: 'nacos-namespace',
      dataRef: {
        nacosNamespaceId: 'dev',
        nacosNamespaceName: 'dev',
        nacosNamespaceDiscoveryMode: 'configured',
      },
      children: [
        { type: 'nacos-config-entry' },
        { type: 'nacos-services-entry' },
      ],
    });
    expect(rootDataRef).toMatchObject({
      id: 'nacos-1',
      nacosNamespaceDiscoveryMode: 'configured',
    });
    expect(harness.connectionStates['nacos-1']).toBe('success');
    expect(message.warning).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('dev'),
      }),
    );
    expect(message.error).not.toHaveBeenCalled();
  });

  it('keeps explicit public scope configured while sending the Nacos public namespace id', async () => {
    vi.stubGlobal('window', {
      go: {
        app: {
          App: {
            NacosListNamespaces: vi.fn().mockResolvedValue({
              success: false,
              data: { errorCode: 'nacos_namespace_list_forbidden' },
            }),
          },
        },
      },
    });
    const harness = renderNamespaceLoader();

    await act(async () => {
      await harness.loaders.loadDatabases(buildNode('namespaceId=public'));
    });

    const namespace = mocks.replaceTreeNodeChildren.mock.calls[0][1][0];
    expect(namespace).toMatchObject({
      title: 'public',
      dataRef: {
        nacosNamespaceId: '',
        nacosNamespaceName: 'public',
        nacosNamespaceDiscoveryMode: 'configured',
      },
    });
  });

  it('prompts for a scope instead of fabricating one when discovery is forbidden and none is configured', async () => {
    vi.stubGlobal('window', {
      go: {
        app: {
          App: {
            NacosListNamespaces: vi.fn().mockResolvedValue({
              success: false,
              message: 'forbidden',
              data: { errorCode: 'nacos_namespace_list_forbidden' },
            }),
          },
        },
      },
    });
    const harness = renderNamespaceLoader();

    await act(async () => {
      await harness.loaders.loadDatabases(buildNode('contextPath=/nacos'));
    });

    expect(mocks.replaceTreeNodeChildren).not.toHaveBeenCalled();
    expect(harness.connectionStates['nacos-1']).toBe('error');
    expect(message.error).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('Namespace ID'),
      }),
    );
    expect(message.warning).not.toHaveBeenCalled();
  });

  it('does not use the configured namespace for unrelated namespace-list errors', async () => {
    vi.stubGlobal('window', {
      go: {
        app: {
          App: {
            NacosListNamespaces: vi.fn().mockResolvedValue({
              success: false,
              message: 'server unavailable',
              data: { errorCode: 'nacos_server_unavailable' },
            }),
          },
        },
      },
    });
    const harness = renderNamespaceLoader();

    await act(async () => {
      await harness.loaders.loadDatabases(buildNode('namespaceId=dev'));
    });

    expect(mocks.replaceTreeNodeChildren).not.toHaveBeenCalled();
    expect(harness.connectionStates['nacos-1']).toBe('error');
    expect(message.error).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'server unavailable' }),
    );
    expect(message.warning).not.toHaveBeenCalled();
  });
});
