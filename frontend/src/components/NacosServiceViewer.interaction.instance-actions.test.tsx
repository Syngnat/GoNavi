import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import NacosServiceViewer from './NacosServiceViewer';

const storeState = vi.hoisted(() => ({
  connections: [{
    id: 'nacos-1',
    name: 'nacos',
    config: { type: 'nacos', host: '127.0.0.1', port: 8848 },
  }],
  theme: 'light',
  appearance: {
    enabled: true,
    opacity: 1,
    blur: 0,
  },
}));

const nacosBackend = vi.hoisted(() => ({
  NacosListServices: vi.fn(),
  NacosListInstances: vi.fn(),
  NacosGetService: vi.fn(),
  NacosCreateService: vi.fn(),
  NacosRegisterInstance: vi.fn(),
  NacosUpdateInstance: vi.fn(),
  NacosUpdateInstanceHealth: vi.fn(),
  NacosDeleteService: vi.fn(),
}));

const productionConfirm = vi.hoisted(() => vi.fn());

const antdState = vi.hoisted(() => ({
  tableProps: [] as any[],
  paginationProps: [] as any[],
  forms: [] as Array<{
    validateFields: ReturnType<typeof vi.fn>;
    resetFields: ReturnType<typeof vi.fn>;
    setFieldsValue: ReturnType<typeof vi.fn>;
  }>,
  message: {
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock('../store', () => ({
  useStore: (selector: (state: typeof storeState) => unknown) => selector(storeState),
}));

vi.mock('../i18n/provider', () => ({
  useOptionalI18n: () => ({ language: 'en-US' }),
}));

vi.mock('../utils/productionRiskConfirm', () => ({
  confirmProductionMutation: productionConfirm,
}));

vi.mock('./RedisResizableDivider', async () => {
  const ReactModule = await import('react');
  return { default: () => ReactModule.createElement('nacos-divider') };
});

vi.mock('@ant-design/icons', async () => {
  const ReactModule = await import('react');
  const Icon = () => ReactModule.createElement('span', { 'data-icon': true });
  return {
    DeleteOutlined: Icon,
    DownOutlined: Icon,
    PlusOutlined: Icon,
    ReloadOutlined: Icon,
    RightOutlined: Icon,
  };
});

vi.mock('antd', async () => {
  const ReactModule = await import('react');
  const passthrough = (tag: string) => ({ children, ...props }: any) =>
    ReactModule.createElement(tag, props, children);
  const Form = Object.assign(
    passthrough('form'),
    {
      Item: passthrough('form-item'),
      useForm: () => {
        const formRef = ReactModule.useRef<any>(null);
        if (!formRef.current) {
          formRef.current = {
            validateFields: vi.fn(),
            resetFields: vi.fn(),
            setFieldsValue: vi.fn(),
          };
          antdState.forms.push(formRef.current);
        }
        return [formRef.current];
      },
    },
  );

  return {
    Button: ({ children, ...props }: any) => ReactModule.createElement('button', props, children),
    Form,
    Input: (props: any) => ReactModule.createElement('input', props),
    InputNumber: (props: any) => ReactModule.createElement('input-number', props),
    Modal: ({ open, children, ...props }: any) => open
      ? ReactModule.createElement('modal', props, children)
      : null,
    Pagination: (props: any) => {
      antdState.paginationProps.push(props);
      return ReactModule.createElement('nacos-pagination', props);
    },
    Popconfirm: ({ children, ...props }: any) =>
      ReactModule.createElement('popconfirm', props, children),
    Space: passthrough('space'),
    Switch: (props: any) => ReactModule.createElement('switch-control', props),
    Table: (props: any) => {
      antdState.tableProps.push(props);
      return ReactModule.createElement('nacos-table');
    },
    Tag: passthrough('tag'),
    message: antdState.message,
  };
});

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

const flushEffects = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
};

const latestServiceTableProps = () =>
  [...antdState.tableProps].reverse().find((props) => props.className === 'gn-nacos-service-table');

// Look the delete column up by key instead of by position: the table gained a
// health column, and positional lookups silently read the wrong cell.
const serviceDeleteColumn = (serviceTable: { columns: Array<Record<string, unknown>> }) => {
  const column = serviceTable.columns.find((item) => item.key === 'actions');
  if (!column) throw new Error('service table has no actions column');
  return column as { render: (value: unknown, row: unknown) => any };
};

const latestServicePaginationProps = () =>
  antdState.paginationProps[antdState.paginationProps.length - 1];

const instanceRows = (renderer: ReactTestRenderer) =>
  renderer.root.findAll((node) => typeof node.props['data-instance-endpoint'] === 'string');

const instanceEndpoints = (renderer: ReactTestRenderer) =>
  instanceRows(renderer).map((row) => row.props['data-instance-endpoint']);

const instanceRow = (renderer: ReactTestRenderer, endpoint: string) =>
  instanceRows(renderer).find((row) => row.props['data-instance-endpoint'] === endpoint);

const instanceHealthSwitch = (renderer: ReactTestRenderer, endpoint: string) =>
  instanceRow(renderer, endpoint)?.find((node) => (node.type as any) === 'switch-control'
    && node.props['data-instance-action'] === undefined);

const instanceEnabledSwitch = (renderer: ReactTestRenderer, endpoint: string) =>
  instanceRow(renderer, endpoint)?.find((node) => (node.type as any) === 'switch-control'
    && node.props['data-instance-action'] === 'toggle-enabled');

const instanceAction = (
  renderer: ReactTestRenderer,
  endpoint: string,
  action: 'toggle-details' | 'edit' | 'deregister',
) => instanceRow(renderer, endpoint)?.find(
  (node) => node.type === 'button' && node.props['data-instance-action'] === action,
);

describe('NacosServiceViewer interactions', () => {
  let renderer: ReactTestRenderer | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    productionConfirm.mockResolvedValue(true);
    storeState.connections[0].config = {
      type: 'nacos',
      host: '127.0.0.1',
      port: 8848,
    };
    antdState.tableProps = [];
    antdState.paginationProps = [];
    antdState.forms = [];
    nacosBackend.NacosListServices.mockResolvedValue({
      success: true,
      data: {
        count: 3,
        pageNo: 1,
        pageSize: 50,
        serviceNames: ['GROUP_A@@alpha', 'GROUP_B@@beta', 'GROUP_C@@charlie'],
      },
    });
    nacosBackend.NacosListInstances.mockResolvedValue({ success: true, data: { hosts: [] } });
    nacosBackend.NacosGetService.mockResolvedValue({
      success: true,
      data: {
        name: 'alpha',
        groupName: 'GROUP_A',
        ephemeral: false,
        clusters: [{ name: 'DEFAULT', healthChecker: { type: 'NONE' } }],
      },
    });
    nacosBackend.NacosCreateService.mockResolvedValue({ success: true });
    nacosBackend.NacosRegisterInstance.mockResolvedValue({ success: true });
    nacosBackend.NacosUpdateInstance.mockResolvedValue({ success: true });
    nacosBackend.NacosUpdateInstanceHealth.mockResolvedValue({ success: true });
    nacosBackend.NacosDeleteService.mockResolvedValue({ success: true });
    vi.stubGlobal('window', {
      go: { app: { App: nacosBackend } },
      dispatchEvent: vi.fn(),
    });
  });

  afterEach(() => {
    renderer?.unmount();
    renderer = null;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('toggles instance online state from the list and keeps disabled instances editable', async () => {
    let enabled = true;
    nacosBackend.NacosListInstances.mockImplementation(async () => ({
      success: true,
      data: {
        hosts: [{
          ip: '10.0.0.1',
          port: 8080,
          weight: 2,
          healthy: true,
          enabled,
          ephemeral: false,
          clusterName: 'DEFAULT',
          metadata: { zone: 'east' },
        }],
      },
    }));
    nacosBackend.NacosUpdateInstance.mockImplementation(
      async (_config: unknown, payload: { enabled: boolean }) => {
        enabled = payload.enabled;
        return { success: true };
      },
    );

    await act(async () => {
      renderer = create(
        <NacosServiceViewer connectionId="nacos-1" namespaceId="dev" namespaceName="dev" />,
      );
    });
    await flushEffects();

    const serviceTable = latestServiceTableProps();
    await act(async () => {
      serviceTable.onRow(serviceTable.dataSource[0]).onClick();
    });
    await flushEffects();

    const onlineSwitch = instanceEnabledSwitch(renderer!, '10.0.0.1:8080');
    expect(onlineSwitch?.props.checked).toBe(true);
    expect(onlineSwitch?.props.disabled).toBe(false);
    expect(onlineSwitch?.props['aria-label']).toContain('Take offline');

    await act(async () => {
      onlineSwitch?.props.onChange(false);
    });
    await flushEffects();

    expect(nacosBackend.NacosUpdateInstance).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        serviceName: 'alpha',
        groupName: 'GROUP_A',
        ip: '10.0.0.1',
        port: 8080,
        clusterName: 'DEFAULT',
        weight: 2,
        enabled: false,
        healthy: true,
        ephemeral: false,
        metadata: { zone: 'east' },
      }),
    );
    expect(nacosBackend.NacosListInstances).toHaveBeenCalledTimes(2);
    expect(instanceEndpoints(renderer!)).toEqual(['10.0.0.1:8080']);
    expect(instanceEnabledSwitch(renderer!, '10.0.0.1:8080')?.props.checked).toBe(false);
    expect(instanceEnabledSwitch(renderer!, '10.0.0.1:8080')?.props['aria-label'])
      .toContain('Bring online');
    expect(instanceAction(renderer!, '10.0.0.1:8080', 'edit')?.props.disabled).toBe(false);
  });

  it('keeps the current instance state when an online toggle fails', async () => {
    nacosBackend.NacosListInstances.mockResolvedValue({
      success: true,
      data: {
        hosts: [{
          ip: '10.0.0.1',
          port: 8080,
          weight: 1,
          healthy: true,
          enabled: true,
          ephemeral: false,
          clusterName: 'DEFAULT',
        }],
      },
    });
    nacosBackend.NacosUpdateInstance.mockResolvedValue({
      success: false,
      message: 'update rejected',
    });

    await act(async () => {
      renderer = create(
        <NacosServiceViewer connectionId="nacos-1" namespaceId="dev" namespaceName="dev" />,
      );
    });
    await flushEffects();

    const serviceTable = latestServiceTableProps();
    await act(async () => {
      serviceTable.onRow(serviceTable.dataSource[0]).onClick();
    });
    await flushEffects();

    await act(async () => {
      instanceEnabledSwitch(renderer!, '10.0.0.1:8080')?.props.onChange(false);
    });
    await flushEffects();

    expect(antdState.message.error).toHaveBeenCalledWith('update rejected');
    expect(nacosBackend.NacosListInstances).toHaveBeenCalledTimes(1);
    expect(instanceEnabledSwitch(renderer!, '10.0.0.1:8080')?.props.checked).toBe(true);
  });

  it('keeps the confirmed online state when the follow-up refresh fails', async () => {
    nacosBackend.NacosListInstances
      .mockResolvedValueOnce({
        success: true,
        data: {
          hosts: [{
            ip: '10.0.0.1',
            port: 8080,
            weight: 1,
            healthy: true,
            enabled: true,
            ephemeral: false,
            clusterName: 'DEFAULT',
          }],
        },
      })
      .mockResolvedValueOnce({ success: false, message: 'refresh failed' });
    nacosBackend.NacosUpdateInstance.mockResolvedValue({ success: true });

    await act(async () => {
      renderer = create(
        <NacosServiceViewer connectionId="nacos-1" namespaceId="dev" namespaceName="dev" />,
      );
    });
    await flushEffects();

    const serviceTable = latestServiceTableProps();
    await act(async () => {
      serviceTable.onRow(serviceTable.dataSource[0]).onClick();
    });
    await flushEffects();

    await act(async () => {
      instanceEnabledSwitch(renderer!, '10.0.0.1:8080')?.props.onChange(false);
    });
    await flushEffects();

    expect(antdState.message.error).toHaveBeenCalledWith('refresh failed');
    expect(instanceEnabledSwitch(renderer!, '10.0.0.1:8080')?.props.checked).toBe(false);
    expect(instanceEnabledSwitch(renderer!, '10.0.0.1:8080')?.props['aria-label'])
      .toContain('Bring online');
    expect(antdState.message.success).toHaveBeenCalledWith('Instance updated');
  });

  it('does not submit an online toggle after confirmation returns in another service', async () => {
    const confirmation = deferred<boolean>();
    productionConfirm.mockReturnValue(confirmation.promise);
    nacosBackend.NacosListInstances.mockResolvedValue({
      success: true,
      data: {
        hosts: [{
          ip: '10.0.0.1',
          port: 8080,
          weight: 1,
          healthy: true,
          enabled: true,
          ephemeral: false,
          clusterName: 'DEFAULT',
        }],
      },
    });

    await act(async () => {
      renderer = create(
        <NacosServiceViewer connectionId="nacos-1" namespaceId="dev" namespaceName="dev" />,
      );
    });
    await flushEffects();

    let serviceTable = latestServiceTableProps();
    await act(async () => {
      serviceTable.onRow(serviceTable.dataSource[0]).onClick();
    });
    await flushEffects();
    await act(async () => {
      instanceEnabledSwitch(renderer!, '10.0.0.1:8080')?.props.onChange(false);
    });

    serviceTable = latestServiceTableProps();
    await act(async () => {
      serviceTable.onRow(serviceTable.dataSource[1]).onClick();
    });
    await flushEffects();

    confirmation.resolve(true);
    await flushEffects();

    expect(nacosBackend.NacosUpdateInstance).not.toHaveBeenCalled();
  });

  it('does not let an old online toggle clear a newer ABA mutation', async () => {
    const firstUpdate = deferred<any>();
    const secondUpdate = deferred<any>();
    nacosBackend.NacosUpdateInstance
      .mockReset()
      .mockReturnValueOnce(firstUpdate.promise)
      .mockReturnValueOnce(secondUpdate.promise);
    nacosBackend.NacosListInstances.mockImplementation(
      async (_config: unknown, payload: { serviceName: string }) => ({
        success: true,
        data: {
          hosts: [{
            ip: '10.0.0.1',
            port: 8080,
            weight: 1,
            healthy: true,
            enabled: true,
            ephemeral: false,
            clusterName: 'DEFAULT',
            serviceName: payload.serviceName,
          }],
        },
      }),
    );

    await act(async () => {
      renderer = create(
        <NacosServiceViewer connectionId="nacos-1" namespaceId="dev" namespaceName="dev" />,
      );
    });
    await flushEffects();

    let serviceTable = latestServiceTableProps();
    await act(async () => {
      serviceTable.onRow(serviceTable.dataSource[0]).onClick();
    });
    await flushEffects();
    await act(async () => {
      instanceEnabledSwitch(renderer!, '10.0.0.1:8080')?.props.onChange(false);
    });

    serviceTable = latestServiceTableProps();
    await act(async () => {
      serviceTable.onRow(serviceTable.dataSource[1]).onClick();
    });
    await flushEffects();
    serviceTable = latestServiceTableProps();
    await act(async () => {
      serviceTable.onRow(serviceTable.dataSource[0]).onClick();
    });
    await flushEffects();
    await act(async () => {
      instanceEnabledSwitch(renderer!, '10.0.0.1:8080')?.props.onChange(false);
    });

    firstUpdate.resolve({ success: true });
    await flushEffects();

    expect(nacosBackend.NacosListInstances).toHaveBeenCalledTimes(3);
    expect(instanceEnabledSwitch(renderer!, '10.0.0.1:8080')?.props.loading).toBe(true);
    expect(instanceEnabledSwitch(renderer!, '10.0.0.1:8080')?.props.disabled).toBe(true);

    secondUpdate.resolve({ success: true });
    await flushEffects();

    expect(nacosBackend.NacosListInstances).toHaveBeenCalledTimes(4);
    expect(instanceEnabledSwitch(renderer!, '10.0.0.1:8080')?.props.loading).toBe(false);
  });

  it('only allows manual health changes for persistent instances with no health checker', async () => {
    nacosBackend.NacosListInstances.mockResolvedValue({
      success: true,
      data: {
        hosts: [{
          ip: '10.0.0.1',
          port: 8080,
          healthy: false,
          enabled: true,
          ephemeral: false,
          clusterName: 'DEFAULT',
          metadata: { zone: 'east' },
        }],
      },
    });
    nacosBackend.NacosGetService.mockResolvedValue({
      success: true,
      data: {
        name: 'alpha',
        groupName: 'GROUP_A',
        ephemeral: false,
        clusters: [{ name: 'DEFAULT', healthChecker: { type: 'TCP' } }],
      },
    });

    await act(async () => {
      renderer = create(
        <NacosServiceViewer connectionId="nacos-1" namespaceId="dev" namespaceName="dev" />,
      );
    });
    await flushEffects();

    const serviceTable = latestServiceTableProps();
    await act(async () => {
      serviceTable.onRow(serviceTable.dataSource[0]).onClick();
    });
    await flushEffects();

    const healthSwitch = instanceHealthSwitch(renderer!, '10.0.0.1:8080');
    expect(healthSwitch!.props.disabled).toBe(true);

    const editButton = instanceAction(renderer!, '10.0.0.1:8080', 'edit');
    await act(async () => {
      editButton!.props.onClick();
    });

    const instanceModal = renderer!.root.find((node) => (node.type as any) === 'modal');
    const healthyItem = instanceModal.findAll((node) => (node.type as any) === 'form-item')
      .find((item) => item.props.name === 'healthy');
    expect(
      healthyItem?.find((node) => (node.type as any) === 'switch-control').props.disabled,
    ).toBe(true);

    const instanceForm = antdState.forms[1];
    instanceForm.validateFields.mockResolvedValue({
      serviceName: 'alpha',
      groupName: 'GROUP_A',
      ip: '10.0.0.1',
      port: 8080,
      weight: 1,
      clusterName: 'DEFAULT',
      enabled: true,
      ephemeral: false,
      healthy: true,
    });
    await act(async () => {
      instanceModal.props.onOk();
      await Promise.resolve();
    });
    await flushEffects();

    expect(nacosBackend.NacosUpdateInstance).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        healthy: false,
        metadata: { zone: 'east' },
      }),
    );
  });

  it('locks immutable instance identity fields while editing', async () => {
    nacosBackend.NacosListInstances.mockResolvedValue({
      success: true,
      data: {
        hosts: [{
          ip: '10.0.0.1',
          port: 8080,
          weight: 1,
          healthy: true,
          enabled: true,
          ephemeral: false,
          clusterName: 'DEFAULT',
        }],
      },
    });

    await act(async () => {
      renderer = create(
        <NacosServiceViewer connectionId="nacos-1" namespaceId="dev" namespaceName="dev" />,
      );
    });
    await flushEffects();

    const serviceTable = latestServiceTableProps();
    await act(async () => {
      serviceTable.onRow(serviceTable.dataSource[0]).onClick();
    });
    await flushEffects();

    const editButton = instanceAction(renderer!, '10.0.0.1:8080', 'edit');
    await act(async () => {
      editButton!.props.onClick();
    });

    const instanceModal = renderer!.root.find((node) => (node.type as any) === 'modal');
    const clusterItem = instanceModal.findAll((node) => (node.type as any) === 'form-item')
      .find((item) => item.props.name === 'clusterName');
    const ephemeralItem = instanceModal.findAll((node) => (node.type as any) === 'form-item')
      .find((item) => item.props.name === 'ephemeral');
    expect(clusterItem?.findByType('input').props.disabled).toBe(true);
    expect(
      ephemeralItem?.find((node) => (node.type as any) === 'switch-control').props.disabled,
    ).toBe(true);
  });

  it('closes an instance modal and rejects its stale submit after selecting another service', async () => {
    nacosBackend.NacosListInstances.mockResolvedValue({
      success: true,
      data: {
        hosts: [{
          ip: '10.0.0.1',
          port: 8080,
          weight: 1,
          healthy: true,
          enabled: true,
          ephemeral: false,
          clusterName: 'DEFAULT',
        }],
      },
    });

    await act(async () => {
      renderer = create(
        <NacosServiceViewer connectionId="nacos-1" namespaceId="dev" namespaceName="dev" />,
      );
    });
    await flushEffects();

    let serviceTable = latestServiceTableProps();
    await act(async () => {
      serviceTable.onRow(serviceTable.dataSource[0]).onClick();
    });
    await flushEffects();

    const editButton = instanceAction(renderer!, '10.0.0.1:8080', 'edit');
    await act(async () => {
      editButton!.props.onClick();
    });

    const instanceForm = antdState.forms[1];
    instanceForm.validateFields.mockResolvedValue({
      serviceName: 'alpha',
      groupName: 'GROUP_A',
      ip: '10.0.0.1',
      port: 8080,
      weight: 1,
      clusterName: 'DEFAULT',
      enabled: true,
      ephemeral: false,
      healthy: true,
    });
    const staleModal = renderer!.root.find((node) => (node.type as any) === 'modal');
    const staleSubmit = staleModal.props.onOk;

    serviceTable = latestServiceTableProps();
    await act(async () => {
      serviceTable.onRow(serviceTable.dataSource[1]).onClick();
    });
    await flushEffects();

    expect(renderer!.root.findAll((node) => (node.type as any) === 'modal')).toHaveLength(0);
    await act(async () => {
      staleSubmit();
      await Promise.resolve();
    });
    await flushEffects();

    expect(nacosBackend.NacosUpdateInstance).not.toHaveBeenCalled();
  });

  it('does not let an older save close a newly opened instance modal after an ABA selection', async () => {
    const updateResponse = deferred<any>();
    nacosBackend.NacosUpdateInstance.mockReturnValue(updateResponse.promise);
    nacosBackend.NacosListInstances.mockResolvedValue({
      success: true,
      data: {
        hosts: [{
          ip: '10.0.0.1',
          port: 8080,
          weight: 1,
          healthy: true,
          enabled: true,
          ephemeral: false,
          clusterName: 'DEFAULT',
        }],
      },
    });

    await act(async () => {
      renderer = create(
        <NacosServiceViewer connectionId="nacos-1" namespaceId="dev" namespaceName="dev" />,
      );
    });
    await flushEffects();

    let serviceTable = latestServiceTableProps();
    await act(async () => {
      serviceTable.onRow(serviceTable.dataSource[0]).onClick();
    });
    await flushEffects();

    let editButton = instanceAction(renderer!, '10.0.0.1:8080', 'edit');
    await act(async () => {
      editButton!.props.onClick();
    });

    const instanceForm = antdState.forms[1];
    instanceForm.validateFields.mockResolvedValue({
      serviceName: 'alpha',
      groupName: 'GROUP_A',
      ip: '10.0.0.1',
      port: 8080,
      weight: 1,
      clusterName: 'DEFAULT',
      enabled: true,
      ephemeral: false,
      healthy: true,
    });
    let instanceModal = renderer!.root.find((node) => (node.type as any) === 'modal');
    await act(async () => {
      instanceModal.props.onOk();
      instanceModal.props.onOk();
      await Promise.resolve();
    });
    expect(nacosBackend.NacosUpdateInstance).toHaveBeenCalledTimes(1);

    serviceTable = latestServiceTableProps();
    await act(async () => {
      serviceTable.onRow(serviceTable.dataSource[1]).onClick();
    });
    await flushEffects();
    serviceTable = latestServiceTableProps();
    await act(async () => {
      serviceTable.onRow(serviceTable.dataSource[0]).onClick();
    });
    await flushEffects();

    editButton = instanceAction(renderer!, '10.0.0.1:8080', 'edit');
    await act(async () => {
      editButton!.props.onClick();
    });
    expect(renderer!.root.findAll((node) => (node.type as any) === 'modal')).toHaveLength(1);

    updateResponse.resolve({ success: true });
    await flushEffects();

    expect(renderer!.root.findAll((node) => (node.type as any) === 'modal')).toHaveLength(1);
  });

  it('disables instance mutations for an explicitly read-only Nacos connection', async () => {
    storeState.connections[0].config = {
      ...storeState.connections[0].config,
      readOnly: true,
    } as any;

    await act(async () => {
      renderer = create(
        <NacosServiceViewer connectionId="nacos-1" namespaceId="dev" namespaceName="dev" />,
      );
    });
    await flushEffects();

    const serviceTable = latestServiceTableProps();
    await act(async () => {
      serviceTable.onRow(serviceTable.dataSource[0]).onClick();
    });
    await flushEffects();

    const registerButton = renderer!.root
      .findAllByType('button')
      .find((button) => button.props.type === 'primary');
    expect(registerButton?.props.disabled).toBe(true);
  });

  it('keeps service structure actions available when only data edits are restricted', async () => {
    storeState.connections[0].config = {
      ...storeState.connections[0].config,
      protection: {
        restrictDataEdit: true,
        restrictStructureEdit: false,
      },
    } as any;

    await act(async () => {
      renderer = create(
        <NacosServiceViewer connectionId="nacos-1" namespaceId="dev" namespaceName="dev" />,
      );
    });
    await flushEffects();

    const createButton = renderer!.root
      .findAllByType('button')
      .find((button) =>
        button.props.icon
        && button.props.type !== 'primary'
        && button.props.size === undefined
        && button.props.disabled === false);
    expect(createButton).toBeDefined();

    const serviceTable = latestServiceTableProps();
    const deleteAction = serviceDeleteColumn(serviceTable).render(undefined, serviceTable.dataSource[0]);
    expect(deleteAction.props.disabled).toBe(false);
    await act(async () => {
      serviceTable.onRow(serviceTable.dataSource[0]).onClick();
    });
    await flushEffects();

    const registerButton = renderer!.root
      .findAllByType('button')
      .find((button) => button.props.type === 'primary');
    expect(registerButton?.props.disabled).toBe(true);
  });

  it('notifies the sidebar after a service is deleted', async () => {
    nacosBackend.NacosListInstances.mockResolvedValue({ success: true, data: { hosts: [] } });

    await act(async () => {
      renderer = create(
        <NacosServiceViewer connectionId="nacos-1" namespaceId="dev" namespaceName="dev" />,
      );
    });
    await flushEffects();

    const serviceTable = latestServiceTableProps();
    const deleteAction = serviceDeleteColumn(serviceTable).render(undefined, serviceTable.dataSource[0]);
    await act(async () => {
      deleteAction.props.onConfirm();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(window.dispatchEvent).toHaveBeenCalledTimes(1);
    const event = vi.mocked(window.dispatchEvent).mock.calls[0][0] as CustomEvent;
    expect(event.type).toBe('gonavi:nacos-services-changed');
    expect(event.detail).toEqual({ connectionId: 'nacos-1', namespaceId: 'dev' });
  });

  it('refreshes the latest service page after an older delete request completes', async () => {
    const deleteResponse = deferred<any>();
    nacosBackend.NacosDeleteService.mockReturnValue(deleteResponse.promise);
    nacosBackend.NacosListServices.mockImplementation(
      async (_config: unknown, payload: { pageNo: number }) => ({
        success: true,
        data: {
          count: 60,
          pageNo: payload.pageNo,
          pageSize: 50,
          serviceNames: [
            payload.pageNo === 1 ? 'GROUP_A@@alpha' : 'GROUP_B@@newest',
          ],
        },
      }),
    );

    await act(async () => {
      renderer = create(
        <NacosServiceViewer connectionId="nacos-1" namespaceId="dev" namespaceName="dev" />,
      );
    });
    await flushEffects();

    let serviceTable = latestServiceTableProps();
    const deleteAction = serviceDeleteColumn(serviceTable).render(undefined, serviceTable.dataSource[0]);
    await act(async () => {
      deleteAction.props.onConfirm();
    });

    await act(async () => {
      latestServicePaginationProps().onChange(2);
    });
    await flushEffects();
    expect(latestServicePaginationProps().current).toBe(2);

    deleteResponse.resolve({ success: true });
    await flushEffects();

    const listCalls = nacosBackend.NacosListServices.mock.calls;
    const lastListCall = listCalls[listCalls.length - 1];
    expect(lastListCall?.[1]).toEqual(expect.objectContaining({ pageNo: 2 }));
    expect(latestServiceTableProps().dataSource).toEqual([
      expect.objectContaining({ rawName: 'GROUP_B@@newest' }),
    ]);
  });

  it('preserves a newer page size when an older delete request completes', async () => {
    const deleteResponse = deferred<any>();
    nacosBackend.NacosDeleteService.mockReturnValue(deleteResponse.promise);
    nacosBackend.NacosListServices.mockImplementation(
      async (_config: unknown, payload: { pageNo: number; pageSize: number }) => ({
        success: true,
        data: {
          count: 4,
          pageNo: payload.pageNo,
          pageSize: payload.pageSize,
          serviceNames: ['GROUP_A@@alpha'],
        },
      }),
    );

    await act(async () => {
      renderer = create(
        <NacosServiceViewer connectionId="nacos-1" namespaceId="dev" namespaceName="dev" />,
      );
    });
    await flushEffects();

    const serviceTable = latestServiceTableProps();
    const deleteAction = serviceDeleteColumn(serviceTable).render(undefined, serviceTable.dataSource[0]);
    await act(async () => {
      deleteAction.props.onConfirm();
    });

    await act(async () => {
      latestServicePaginationProps().onChange(1, 100);
    });
    await flushEffects();
    expect(latestServicePaginationProps().pageSize).toBe(100);

    deleteResponse.resolve({ success: true });
    await flushEffects();

    const listCalls = nacosBackend.NacosListServices.mock.calls;
    expect(listCalls[listCalls.length - 1]?.[1]).toEqual(
      expect.objectContaining({ pageSize: 100 }),
    );
  });

  it('uses one pagination callback for page-size changes', async () => {
    await act(async () => {
      renderer = create(
        <NacosServiceViewer connectionId="nacos-1" namespaceId="dev" namespaceName="dev" />,
      );
    });
    await flushEffects();

    expect(latestServicePaginationProps().onChange).toEqual(expect.any(Function));
    expect(latestServicePaginationProps().onShowSizeChange).toBeUndefined();
  });

  it('falls back to the last valid page when a concurrent deletion leaves the page empty', async () => {
    nacosBackend.NacosListServices.mockImplementation(
      async (_config: unknown, payload: { pageNo: number }) => {
        if (payload.pageNo === 2) {
          return {
            success: true,
            data: {
              count: 50,
              pageNo: 2,
              pageSize: 50,
              serviceNames: [],
            },
          };
        }
        return {
          success: true,
          data: {
            count: 50,
            pageNo: 1,
            pageSize: 50,
            serviceNames: ['GROUP_A@@alpha'],
          },
        };
      },
    );

    await act(async () => {
      renderer = create(
        <NacosServiceViewer connectionId="nacos-1" namespaceId="dev" namespaceName="dev" />,
      );
    });
    await flushEffects();

    await act(async () => {
      latestServicePaginationProps().onChange(2);
    });
    await flushEffects();

    const listCalls = nacosBackend.NacosListServices.mock.calls;
    expect(listCalls[listCalls.length - 1]?.[1]).toEqual(
      expect.objectContaining({ pageNo: 1 }),
    );
    expect(latestServicePaginationProps().current).toBe(1);
    expect(latestServiceTableProps().dataSource).toEqual([
      expect.objectContaining({ rawName: 'GROUP_A@@alpha' }),
    ]);
  });
});
