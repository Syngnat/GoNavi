import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const modalState = vi.hoisted(() => ({
  confirm: vi.fn(),
}));

const antdState = vi.hoisted(() => ({
  message: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

const nacosBackend = vi.hoisted(() => ({
  NacosCreateNamespace: vi.fn(),
  NacosUpdateNamespace: vi.fn(),
  NacosDeleteNamespace: vi.fn(),
}));

vi.mock('../common/ResizableDraggableModal', () => ({
  default: {
    confirm: modalState.confirm,
  },
}));

vi.mock('antd', async (importOriginal) => {
  const actual = await importOriginal<typeof import('antd')>();
  return {
    ...actual,
    message: antdState.message,
  };
});

import { useStore } from '../../store';
import { buildSidebarLegacyNodeMenuItems } from './sidebarLegacyNodeMenu';

const createNacosConnection = (protection: {
  readOnly?: boolean;
  restrictDataEdit?: boolean;
  restrictStructureEdit?: boolean;
} = {}) => ({
  id: 'nacos-permission-test',
  name: 'Nacos permission test',
  config: {
    type: 'nacos',
    host: '127.0.0.1',
    port: 8848,
    readOnly: protection.readOnly === true,
    protection: {
      restrictDataEdit: protection.restrictDataEdit === true,
      restrictStructureEdit: protection.restrictStructureEdit === true,
      restrictScriptExecution: false,
      restrictDataImport: false,
    },
  },
} as any);

const buildNacosRootItems = (
  connection: any,
  loadDatabases = vi.fn(),
  context: Record<string, any> = {},
) =>
  buildSidebarLegacyNodeMenuItems({
    key: connection.id,
    type: 'connection',
    dataRef: connection,
  }, {
    loadDatabases,
    setExpandedKeys: vi.fn(),
    setLoadedKeys: vi.fn(),
    ...context,
  }) as any[];

const buildNacosNamespaceItems = (
  connection: any,
  loadDatabases = vi.fn(),
  context: Record<string, any> = {},
) =>
  buildSidebarLegacyNodeMenuItems({
    type: 'nacos-namespace',
    dataRef: {
      ...connection,
      nacosNamespaceId: 'mkefu-dev',
      nacosNamespaceName: 'mkefu development',
    },
  }, {
    addTab: vi.fn(),
    loadDatabases,
    ...context,
  }) as any[];

const findItem = (items: any[], key: string) => items.find((item) => item?.key === key);

describe('Nacos service group context menu', () => {
  const originalConnections = useStore.getState().connections;

  beforeEach(() => {
    vi.clearAllMocks();
    useStore.setState({ connections: [] });
    nacosBackend.NacosCreateNamespace.mockResolvedValue({ success: true });
    nacosBackend.NacosUpdateNamespace.mockResolvedValue({ success: true });
    nacosBackend.NacosDeleteNamespace.mockResolvedValue({ success: true });
    vi.stubGlobal('window', {
      go: {
        app: {
          App: nacosBackend,
        },
      },
    });
  });

  afterEach(() => {
    useStore.setState({ connections: originalConnections });
    vi.unstubAllGlobals();
  });

  it('opens the selected service group with its group filter', () => {
    const addTab = vi.fn();
    const items = buildSidebarLegacyNodeMenuItems({
      type: 'nacos-service-group',
      dataRef: {
        id: 'nacos-1',
        nacosNamespaceId: 'mkefu-dev',
        nacosNamespaceName: 'mkefu development',
        nacosGroup: 'MKEFU_SERVICE',
      },
    }, { addTab }) as any[];

    expect(items).toHaveLength(1);
    expect(items[0]?.key).toBe('open-nacos-service-group');
    items[0]?.onClick?.();
    expect(addTab).toHaveBeenCalledWith(expect.objectContaining({
      id: 'nacos-services-nacos-1-ns-mkefu-dev-g-MKEFU_SERVICE',
      type: 'nacos-services',
      nacosGroup: 'MKEFU_SERVICE',
    }));
  });

  it('does not attach a group filter to the all-services node', () => {
    const addTab = vi.fn();
    const items = buildSidebarLegacyNodeMenuItems({
      type: 'nacos-service-group',
      dataRef: {
        id: 'nacos-1',
        nacosNamespaceId: 'mkefu-dev',
        nacosNamespaceName: 'mkefu development',
        nacosGroup: '',
      },
    }, { addTab }) as any[];

    items[0]?.onClick?.();
    const tab = addTab.mock.calls[0]?.[0];
    expect(tab?.id).toBe('nacos-services-nacos-1-ns-mkefu-dev');
    expect(tab).not.toHaveProperty('nacosGroup');
  });

  it.each([
    {
      name: 'legacy readOnly',
      connection: createNacosConnection({ readOnly: true }),
      disabled: true,
    },
    {
      name: 'structure edit protection',
      connection: createNacosConnection({ restrictStructureEdit: true }),
      disabled: true,
    },
    {
      name: 'data edit protection only',
      connection: createNacosConnection({ restrictDataEdit: true }),
      disabled: false,
    },
  ])('applies $name only to Nacos namespace structure actions', ({
    connection,
    disabled,
  }) => {
    useStore.setState({ connections: [connection] });

    const rootItems = buildNacosRootItems(connection);
    const namespaceItems = buildNacosNamespaceItems(connection);

    expect(findItem(rootItems, 'create-nacos-namespace')?.disabled).toBe(disabled);
    expect(findItem(namespaceItems, 'edit-nacos-namespace')?.disabled).toBe(disabled);
    expect(findItem(namespaceItems, 'delete-nacos-namespace')?.disabled).toBe(disabled);
  });

  it('rechecks structure protection before opening a stale namespace menu action', () => {
    const connection = createNacosConnection();
    useStore.setState({ connections: [connection] });
    const rootItems = buildNacosRootItems(connection);
    const namespaceItems = buildNacosNamespaceItems(connection);

    useStore.setState({
      connections: [createNacosConnection({ restrictStructureEdit: true })],
    });

    findItem(rootItems, 'create-nacos-namespace')?.onClick?.();
    findItem(namespaceItems, 'edit-nacos-namespace')?.onClick?.();
    findItem(namespaceItems, 'delete-nacos-namespace')?.onClick?.();

    expect(modalState.confirm).not.toHaveBeenCalled();
  });

  it('rechecks structure protection in namespace create, edit, and delete confirmations', async () => {
    const connection = createNacosConnection();
    useStore.setState({ connections: [connection] });
    const rootItems = buildNacosRootItems(connection);
    const namespaceItems = buildNacosNamespaceItems(connection);

    findItem(rootItems, 'create-nacos-namespace')?.onClick?.();
    const createConfirmation = modalState.confirm.mock.calls[0]?.[0];
    expect(createConfirmation).toBeDefined();

    useStore.setState({
      connections: [createNacosConnection({ restrictStructureEdit: true })],
    });
    await expect(createConfirmation.onOk()).rejects.toThrow();
    expect(nacosBackend.NacosCreateNamespace).not.toHaveBeenCalled();

    useStore.setState({ connections: [connection] });
    findItem(namespaceItems, 'edit-nacos-namespace')?.onClick?.();
    const editConfirmation = modalState.confirm.mock.calls[1]?.[0];
    expect(editConfirmation).toBeDefined();

    useStore.setState({
      connections: [createNacosConnection({ readOnly: true })],
    });
    await expect(editConfirmation.onOk()).rejects.toThrow();
    expect(nacosBackend.NacosUpdateNamespace).not.toHaveBeenCalled();

    useStore.setState({ connections: [connection] });
    findItem(namespaceItems, 'delete-nacos-namespace')?.onClick?.();
    const deleteConfirmation = modalState.confirm.mock.calls[2]?.[0];
    expect(deleteConfirmation).toBeDefined();

    useStore.setState({
      connections: [createNacosConnection({ restrictStructureEdit: true })],
    });
    await expect(deleteConfirmation.onOk()).rejects.toThrow();
    expect(nacosBackend.NacosDeleteNamespace).not.toHaveBeenCalled();
    expect(antdState.message.error).toHaveBeenCalledTimes(3);
  });

  it('allows namespace edits when only data edits are restricted', async () => {
    const connection = createNacosConnection({ restrictDataEdit: true });
    const loadDatabases = vi.fn();
    useStore.setState({ connections: [connection] });
    const namespaceItems = buildNacosNamespaceItems(connection, loadDatabases);

    findItem(namespaceItems, 'edit-nacos-namespace')?.onClick?.();
    const confirmation = modalState.confirm.mock.calls[0]?.[0];
    await confirmation.onOk();

    expect(nacosBackend.NacosUpdateNamespace).toHaveBeenCalledTimes(1);
    expect(loadDatabases).toHaveBeenCalledTimes(1);
  });

  it('disables namespace CRUD for a configured-scope fallback tree', () => {
    const connection = createNacosConnection();
    const configuredScopeConnection = {
      ...connection,
      nacosNamespaceDiscoveryMode: 'configured',
    };
    useStore.setState({ connections: [connection] });

    const rootItems = buildNacosRootItems(configuredScopeConnection);
    const namespaceItems = buildNacosNamespaceItems(configuredScopeConnection);

    expect(findItem(rootItems, 'create-nacos-namespace')?.disabled).toBe(true);
    expect(findItem(namespaceItems, 'edit-nacos-namespace')?.disabled).toBe(true);
    expect(findItem(namespaceItems, 'delete-nacos-namespace')?.disabled).toBe(true);

    findItem(rootItems, 'create-nacos-namespace')?.onClick?.();
    findItem(namespaceItems, 'edit-nacos-namespace')?.onClick?.();
    findItem(namespaceItems, 'delete-nacos-namespace')?.onClick?.();
    expect(modalState.confirm).not.toHaveBeenCalled();
  });

  it('uses the live runtime discovery mode when rebuilt nodes no longer carry the root marker', () => {
    const connection = createNacosConnection();
    const context = {
      getNacosNamespaceDiscoveryMode: vi.fn(() => 'configured'),
    };
    useStore.setState({ connections: [connection] });

    const rootItems = buildNacosRootItems(connection, vi.fn(), context);
    const namespaceItems = buildNacosNamespaceItems(connection, vi.fn(), context);

    expect(connection).not.toHaveProperty('nacosNamespaceDiscoveryMode');
    expect(findItem(rootItems, 'create-nacos-namespace')?.disabled).toBe(true);
    expect(findItem(namespaceItems, 'edit-nacos-namespace')?.disabled).toBe(true);
    expect(findItem(namespaceItems, 'delete-nacos-namespace')?.disabled).toBe(true);
  });

  it('rechecks the live discovery mode before stale namespace CRUD actions and confirmations', async () => {
    const connection = createNacosConnection();
    let discoveryMode: 'listed' | 'configured' = 'listed';
    const context = {
      getNacosNamespaceDiscoveryMode: () => discoveryMode,
    };
    useStore.setState({ connections: [connection] });
    const rootItems = buildNacosRootItems(connection, vi.fn(), context);
    const namespaceItems = buildNacosNamespaceItems(connection, vi.fn(), context);

    const createItem = findItem(rootItems, 'create-nacos-namespace');
    expect(createItem?.disabled).toBe(false);
    createItem?.onClick?.();
    const createConfirmation = modalState.confirm.mock.calls[0]?.[0];
    expect(createConfirmation).toBeDefined();
    const createContentChildren = createConfirmation.content.props.children;
    createContentChildren[1].props.children[1].props.onChange({
      target: { value: 'Scoped namespace' },
    });

    discoveryMode = 'configured';
    await expect(createConfirmation.onOk()).rejects.toThrow();
    expect(nacosBackend.NacosCreateNamespace).not.toHaveBeenCalled();
    createItem?.onClick?.();
    expect(modalState.confirm).toHaveBeenCalledTimes(1);

    discoveryMode = 'listed';
    findItem(namespaceItems, 'edit-nacos-namespace')?.onClick?.();
    const editConfirmation = modalState.confirm.mock.calls[1]?.[0];
    discoveryMode = 'configured';
    await expect(editConfirmation.onOk()).rejects.toThrow();
    expect(nacosBackend.NacosUpdateNamespace).not.toHaveBeenCalled();

    discoveryMode = 'listed';
    findItem(namespaceItems, 'delete-nacos-namespace')?.onClick?.();
    const deleteConfirmation = modalState.confirm.mock.calls[2]?.[0];
    discoveryMode = 'configured';
    await expect(deleteConfirmation.onOk()).rejects.toThrow();
    expect(nacosBackend.NacosDeleteNamespace).not.toHaveBeenCalled();
  });
});
