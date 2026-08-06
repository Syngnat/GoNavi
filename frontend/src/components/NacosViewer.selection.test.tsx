import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import NacosViewer from './NacosViewer';
import {
  nacosConfigSelectionKey,
  nacosImportSelectionKey,
} from './nacosConfigSelection';

const rows = [
  { dataId: 'app.yaml', group: 'DEFAULT_GROUP', type: 'yaml' },
  { dataId: 'shared.json', group: 'APP_GROUP', type: 'json' },
];

const storeState = vi.hoisted(() => ({
  connections: [
    {
      id: 'nacos-1',
      name: 'nacos',
      config: {
        type: 'nacos',
        host: '127.0.0.1',
        port: 8848,
        readOnly: false,
        protection: {
          restrictDataEdit: false,
          restrictDataImport: false,
        },
      },
    },
  ],
  theme: 'light',
  appearance: {
    uiVersion: 'v2',
    enabled: true,
    opacity: 1,
    blur: 0,
  },
}));

const nacosBackend = vi.hoisted(() => ({
  NacosSearchConfigs: vi.fn(),
  NacosListConfigGroups: vi.fn(),
  NacosExportConfigs: vi.fn(),
  NacosPreviewImportConfigs: vi.fn(),
  NacosImportConfigs: vi.fn(),
  NacosDeleteConfig: vi.fn(),
  NacosGetConfig: vi.fn(),
  NacosPublishConfig: vi.fn(),
  NacosGetBetaConfig: vi.fn(),
  NacosStartConfigListen: vi.fn(),
  NacosStopConfigListen: vi.fn(),
}));

const antdState = vi.hoisted(() => ({
  tableProps: [] as any[],
  message: {
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  },
}));

const runtimeState = vi.hoisted(() => ({
  configChangedHandler: null as ((event: any) => void) | null,
}));

vi.mock('../store', () => ({
  useStore: (selector: (state: typeof storeState) => unknown) => selector(storeState),
}));

vi.mock('../i18n/provider', () => ({
  useOptionalI18n: () => ({ language: 'en-US' }),
}));

vi.mock('../../wailsjs/runtime', () => ({
  EventsOn: vi.fn((_eventName: string, handler: (event: any) => void) => {
    runtimeState.configChangedHandler = handler;
    return vi.fn();
  }),
}));

vi.mock('./MonacoEditor', async () => {
  const React = await import('react');
  return { default: (props: any) => React.createElement('nacos-editor', props) };
});

vi.mock('./RedisResizableDivider', async () => {
  const React = await import('react');
  return { default: () => React.createElement('nacos-divider') };
});

vi.mock('@ant-design/icons', async () => {
  const React = await import('react');
  const Icon = () => React.createElement('span', { 'data-icon': true });
  return {
    CloseOutlined: Icon,
    CloudSyncOutlined: Icon,
    DeleteOutlined: Icon,
    DownloadOutlined: Icon,
    ExperimentOutlined: Icon,
    HistoryOutlined: Icon,
    PlusOutlined: Icon,
    ReloadOutlined: Icon,
    SaveOutlined: Icon,
    UploadOutlined: Icon,
  };
});

vi.mock('antd', async () => {
  const React = await import('react');
  const passthrough = (tag: string) => ({ children, ...props }: any) =>
    React.createElement(tag, props, children);
  const Button = ({ children, ...props }: any) => React.createElement('button', props, children);
  const Input = Object.assign(
    (props: any) => React.createElement('input', props),
    { TextArea: (props: any) => React.createElement('textarea', props) },
  );
  const Form = Object.assign(
    passthrough('form'),
    {
      Item: passthrough('form-item'),
      useForm: () => [{
        validateFields: vi.fn(),
        resetFields: vi.fn(),
        setFieldsValue: vi.fn(),
      }],
    },
  );
  const Modal = Object.assign(
    ({ open, children, ...props }: any) => open
      ? React.createElement('modal', props, children)
      : null,
    { confirm: vi.fn() },
  );

  return {
    Alert: ({ children, message, description, action, ...props }: any) =>
      React.createElement(
        'alert',
        props,
        message,
        description,
        action,
        children,
      ),
    AutoComplete: (props: any) => React.createElement('autocomplete', props),
    Button,
    Checkbox: ({ children, ...props }: any) =>
      React.createElement('checkbox-control', props, children),
    Form,
    Input,
    Modal,
    Popconfirm: ({ children, ...props }: any) =>
      React.createElement('popconfirm', props, children),
    Radio: { Group: passthrough('radio-group') },
    Select: (props: any) => React.createElement('select-control', props),
    Space: passthrough('space'),
    Spin: passthrough('spin'),
    Table: (props: any) => {
      antdState.tableProps.push(props);
      return React.createElement('nacos-table');
    },
    Tag: passthrough('tag'),
    Tooltip: ({ children }: any) => React.createElement(React.Fragment, null, children),
    message: antdState.message,
  };
});

const flushEffects = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
};

const renderedText = (node: any): string => {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(renderedText).join('');
  if (Array.isArray(node.children)) return node.children.map(renderedText).join('');
  return '';
};

const latestConfigTableProps = () =>
  [...antdState.tableProps].reverse().find((props) => props.className === 'gn-nacos-config-table');

const findButtonByText = (renderer: ReactTestRenderer, text: string) =>
  renderer.root.findAllByType('button').find((node) => renderedText(node.props.children).includes(text));

const findButtonByExactText = (renderer: ReactTestRenderer, text: string) =>
  renderer.root.findAllByType('button').find((node) => renderedText(node.props.children) === text);

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
};

describe('NacosViewer config selection actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    antdState.tableProps = [];
    runtimeState.configChangedHandler = null;
    storeState.connections[0].config.readOnly = false;
    storeState.connections[0].config.protection = {
      restrictDataEdit: false,
      restrictDataImport: false,
    };
    nacosBackend.NacosSearchConfigs.mockResolvedValue({
      success: true,
      data: {
        totalCount: rows.length,
        pageNumber: 1,
        pagesAvailable: 1,
        pageItems: rows,
      },
    });
    nacosBackend.NacosListConfigGroups.mockResolvedValue({
      success: true,
      data: ['DEFAULT_GROUP', 'APP_GROUP'],
    });
    nacosBackend.NacosExportConfigs.mockResolvedValue({
      success: true,
      data: { exported: rows.length },
    });
    nacosBackend.NacosPreviewImportConfigs.mockResolvedValue({
      success: true,
      data: { file: 'configs.zip', items: [] },
    });
    nacosBackend.NacosImportConfigs.mockResolvedValue({
      success: true,
      data: { imported: 0, skipped: 0 },
    });
    nacosBackend.NacosDeleteConfig.mockResolvedValue({ success: true });
    nacosBackend.NacosGetConfig.mockResolvedValue({
      success: true,
      data: {
        ...rows[0],
        content: 'server: value',
        md5: 'test-md5',
      },
    });
    nacosBackend.NacosPublishConfig.mockResolvedValue({ success: true });
    nacosBackend.NacosGetBetaConfig.mockResolvedValue({
      success: true,
      data: { exists: false },
    });
    nacosBackend.NacosStartConfigListen.mockResolvedValue({
      success: true,
      data: { watchId: '' },
    });
    nacosBackend.NacosStopConfigListen.mockResolvedValue({ success: true });
    vi.stubGlobal('window', {
      requestAnimationFrame: (callback: FrameRequestCallback) => callback(0),
      getSelection: () => ({ removeAllRanges: vi.fn() }),
      go: { app: { App: nacosBackend } },
    });
    vi.stubGlobal('ResizeObserver', undefined);
  });

  it('switches the single export action between all and selected scopes', async () => {
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <NacosViewer connectionId="nacos-1" namespaceId="dev" namespaceName="dev" />,
      );
    });
    await flushEffects();

    const exportAll = findButtonByText(renderer!, 'Export all');
    expect(exportAll).toBeTruthy();
    expect(findButtonByText(renderer!, 'Export selected')).toBeUndefined();
    await act(async () => {
      exportAll!.props.onClick();
    });
    await flushEffects();

    expect(nacosBackend.NacosExportConfigs).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ scope: 'all', items: [] }),
    );

    const selectPage = renderer!.root.findByProps({ 'aria-label': 'Select page' });
    await act(async () => {
      selectPage.props.onChange({ target: { checked: true } });
    });

    expect(latestConfigTableProps().rowSelection.selectedRowKeys).toEqual(
      rows.map(nacosConfigSelectionKey),
    );

    expect(findButtonByText(renderer!, 'Export all')).toBeUndefined();
    const exportSelected = findButtonByText(renderer!, 'Export selected');
    expect(exportSelected).toBeTruthy();
    await act(async () => {
      exportSelected!.props.onClick();
    });
    await flushEffects();

    expect(nacosBackend.NacosExportConfigs).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        scope: 'selected',
        items: rows.map(({ dataId, group }) => ({ dataId, group })),
      }),
    );

    renderer!.unmount();
  });

  it('keeps failed rows selected after a partial batch delete', async () => {
    nacosBackend.NacosDeleteConfig.mockImplementation(
      async (_config: unknown, _namespace: string, _group: string, dataId: string) =>
        dataId === 'shared.json'
          ? { success: false, message: 'permission denied' }
          : { success: true },
    );

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <NacosViewer connectionId="nacos-1" namespaceId="dev" namespaceName="dev" />,
      );
    });
    await flushEffects();

    const selectPage = renderer!.root.findByProps({ 'aria-label': 'Select page' });
    await act(async () => {
      selectPage.props.onChange({ target: { checked: true } });
    });

    const confirmation = renderer!.root.findAll((node) => String(node.type) === 'popconfirm').find(
      (node) => String(node.props.title).includes('Delete the 2 selected configs'),
    );
    expect(confirmation).toBeTruthy();
    const deleteSelected = findButtonByText(renderer!, 'Delete selected');
    expect(deleteSelected).toBeTruthy();
    expect(deleteSelected!.props.danger).toBe(true);
    expect(deleteSelected!.props.type).toBeUndefined();
    await act(async () => {
      await confirmation!.props.onConfirm();
    });
    await flushEffects();

    expect(nacosBackend.NacosDeleteConfig).toHaveBeenCalledTimes(2);
    expect(antdState.message.warning).toHaveBeenCalledWith('Deleted 1 configs; 1 failed');
    expect(latestConfigTableProps().rowSelection.selectedRowKeys).toEqual([
      nacosConfigSelectionKey(rows[1]),
    ]);

    const nextSelectPage = renderer!.root.findByProps({ 'aria-label': 'Select page' });
    expect(nextSelectPage.props.checked).toBe(false);
    expect(nextSelectPage.props.indeterminate).toBe(true);

    renderer!.unmount();
  });

  it('imports structurally selected identities with separators, duplicates, and empty fields intact', async () => {
    const importRows = [
      { group: 'GROUP@@blue', dataId: 'config@@prod.yaml', type: 'yaml' },
      { group: 'DUPLICATE', dataId: 'same.yaml', type: 'yaml' },
      { group: 'DUPLICATE', dataId: 'same.yaml', type: 'yaml' },
      { group: '', dataId: '', type: 'text' },
    ];
    nacosBackend.NacosPreviewImportConfigs.mockResolvedValue({
      success: true,
      data: {
        file: 'configs.zip',
        total: importRows.length,
        items: importRows,
      },
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <NacosViewer connectionId="nacos-1" namespaceId="dev" namespaceName="dev" />,
      );
    });
    await flushEffects();

    await act(async () => {
      findButtonByExactText(renderer!, 'Import')!.props.onClick();
    });
    await flushEffects();

    const allKeys = importRows.map(nacosImportSelectionKey);
    const importTable = [...antdState.tableProps]
      .reverse()
      .find(
        (props) =>
          props.dataSource?.map((row: any) => row.selectionKey).join('|') ===
          allKeys.join('|'),
      );
    expect(importTable.rowKey).toBe('selectionKey');
    expect(importTable.rowSelection.selectedRowKeys).toEqual(allKeys);

    const selectedKeys = [allKeys[0], allKeys[2], allKeys[3]];
    await act(async () => {
      importTable.rowSelection.onChange(selectedKeys);
    });
    const importModal = renderer!.root.findAll(
      (node) => String(node.type) === 'modal',
    )[0];
    await act(async () => {
      importModal.props.onOk();
    });
    await flushEffects();

    expect(nacosBackend.NacosImportConfigs).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        scope: 'selected',
        items: [
          { group: 'GROUP@@blue', dataId: 'config@@prod.yaml', index: 0 },
          { group: 'DUPLICATE', dataId: 'same.yaml', index: 2 },
          { group: '', dataId: '', index: 3 },
        ],
      }),
    );

    renderer!.unmount();
  });

  it('keeps a newer config selection when an older detail request resolves last', async () => {
    const firstDetail = deferred<any>();
    const secondDetail = deferred<any>();
    nacosBackend.NacosGetConfig.mockImplementation(
      (_config: unknown, _namespace: string, _group: string, dataId: string) =>
        dataId === rows[0].dataId ? firstDetail.promise : secondDetail.promise,
    );

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <NacosViewer connectionId="nacos-1" namespaceId="dev" namespaceName="dev" />,
      );
    });
    await flushEffects();

    act(() => {
      latestConfigTableProps().onRow(rows[0]).onClick();
      latestConfigTableProps().onRow(rows[1]).onClick();
    });

    secondDetail.resolve({
      success: true,
      data: { ...rows[1], content: 'newer detail', md5: 'second-md5' },
    });
    await flushEffects();
    expect(
      renderer!.root.find((node) => (node.type as any) === 'nacos-editor').props.value,
    ).toBe('newer detail');

    firstDetail.resolve({
      success: true,
      data: { ...rows[0], content: 'older detail', md5: 'first-md5' },
    });
    await flushEffects();

    expect(
      renderer!.root.find((node) => (node.type as any) === 'nacos-editor').props.value,
    ).toBe('newer detail');
    expect(nacosBackend.NacosStartConfigListen).toHaveBeenCalledTimes(1);
    expect(nacosBackend.NacosStartConfigListen).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ dataId: rows[1].dataId }),
    );

    renderer!.unmount();
  });

  it('does not apply stale beta metadata after selecting another config', async () => {
    const firstBeta = deferred<any>();
    nacosBackend.NacosGetConfig.mockImplementation(
      async (_config: unknown, _namespace: string, group: string, dataId: string) => ({
        success: true,
        data: {
          dataId,
          group,
          content: `${dataId} detail`,
          md5: `${dataId}-md5`,
        },
      }),
    );
    nacosBackend.NacosGetBetaConfig.mockImplementation(
      (_config: unknown, _namespace: string, _group: string, dataId: string) =>
        dataId === rows[0].dataId
          ? firstBeta.promise
          : Promise.resolve({ success: true, data: { exists: false } }),
    );

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <NacosViewer connectionId="nacos-1" namespaceId="dev" namespaceName="dev" />,
      );
    });
    await flushEffects();

    act(() => {
      latestConfigTableProps().onRow(rows[0]).onClick();
    });
    await flushEffects();
    act(() => {
      latestConfigTableProps().onRow(rows[1]).onClick();
    });
    await flushEffects();
    act(() => {
      renderer!.root.find(
        (node) => String(node.type) === 'radio-group',
      ).props.onChange({
        target: { value: 'beta' },
      });
    });
    expect(findButtonByExactText(renderer!, 'Load beta content')?.props.disabled).toBe(
      true,
    );

    firstBeta.resolve({
      success: true,
      data: { exists: true, betaIps: '10.0.0.1' },
    });
    await flushEffects();

    expect(findButtonByExactText(renderer!, 'Load beta content')?.props.disabled).toBe(
      true,
    );

    renderer!.unmount();
  });

  it('stops a stale listener immediately when its start request resolves after the current selection', async () => {
    const firstListen = deferred<any>();
    nacosBackend.NacosGetConfig.mockImplementation(
      async (_config: unknown, _namespace: string, group: string, dataId: string) => ({
        success: true,
        data: {
          dataId,
          group,
          content: `${dataId} detail`,
          md5: `${dataId}-md5`,
        },
      }),
    );
    nacosBackend.NacosStartConfigListen.mockImplementation(
      (_config: unknown, request: any) =>
        request.dataId === rows[0].dataId
          ? firstListen.promise
          : Promise.resolve({
              success: true,
              data: { watchId: 'watch-current' },
            }),
    );

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <NacosViewer connectionId="nacos-1" namespaceId="dev" namespaceName="dev" />,
      );
    });
    await flushEffects();

    act(() => {
      latestConfigTableProps().onRow(rows[0]).onClick();
    });
    await flushEffects();
    act(() => {
      latestConfigTableProps().onRow(rows[1]).onClick();
    });
    await flushEffects();

    firstListen.resolve({
      success: true,
      data: { watchId: 'watch-stale' },
    });
    await flushEffects();

    expect(nacosBackend.NacosStopConfigListen).toHaveBeenCalledWith(
      'watch-stale',
    );
    expect(renderedText(renderer!.toJSON())).toContain('Listening');

    await act(async () => {
      renderer!.unmount();
    });
    await flushEffects();
  });

  it('consumes an immediate one-shot event before the start RPC resolves', async () => {
    const pendingListen = deferred<any>();
    let pendingRequest: any;
    nacosBackend.NacosStartConfigListen.mockImplementation(
      (_config: unknown, request: any) => {
        pendingRequest = request;
        return pendingListen.promise;
      },
    );

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <NacosViewer connectionId="nacos-1" namespaceId="dev" namespaceName="dev" />,
      );
    });
    await flushEffects();

    act(() => {
      latestConfigTableProps().onRow(rows[0]).onClick();
    });
    await flushEffects();
    expect(pendingRequest?.watchId).toMatch(/^nacos-/);

    await act(async () => {
      runtimeState.configChangedHandler!({
        watchId: pendingRequest.watchId,
        connectionId: 'nacos-1',
        namespaceId: 'dev',
        group: rows[0].group,
        dataId: rows[0].dataId,
      });
    });
    await flushEffects();

    expect(nacosBackend.NacosStopConfigListen).toHaveBeenCalledWith(
      pendingRequest.watchId,
    );
    expect(antdState.message.info).toHaveBeenCalledTimes(1);

    pendingListen.resolve({
      success: true,
      data: { watchId: pendingRequest.watchId },
    });
    await flushEffects();
    expect(renderedText(renderer!.toJSON())).not.toContain('Listening');

    await act(async () => {
      renderer!.unmount();
    });
    await flushEffects();
  });

  it.each([
    {
      context: 'namespace',
      nextProps: {
        connectionId: 'nacos-1',
        namespaceId: 'prod',
        namespaceName: 'prod',
      },
    },
    {
      context: 'connection',
      nextProps: {
        connectionId: 'missing-nacos-connection',
        namespaceId: 'dev',
        namespaceName: 'dev',
      },
    },
  ])('invalidates the selected detail and active listener when the $context context changes', async ({
    nextProps,
  }) => {
    nacosBackend.NacosStartConfigListen.mockResolvedValue({
      success: true,
      data: { watchId: 'watch-dev' },
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <NacosViewer connectionId="nacos-1" namespaceId="dev" namespaceName="dev" />,
      );
    });
    await flushEffects();
    act(() => {
      latestConfigTableProps().onRow(rows[0]).onClick();
    });
    await flushEffects();
    expect(renderedText(renderer!.toJSON())).toContain('Listening');

    await act(async () => {
      renderer!.update(
        <NacosViewer {...nextProps} />,
      );
    });
    await flushEffects();

    expect(nacosBackend.NacosStopConfigListen).toHaveBeenCalledWith('watch-dev');
    expect(renderedText(renderer!.toJSON())).not.toContain('Listening');
    expect(
      renderer!.root.findAll((node) => (node.type as any) === 'nacos-editor'),
    ).toHaveLength(0);

    await act(async () => {
      renderer!.unmount();
    });
  });

  it('ignores a detail response from the previous namespace context', async () => {
    const oldContextDetail = deferred<any>();
    nacosBackend.NacosGetConfig.mockReturnValue(oldContextDetail.promise);

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <NacosViewer connectionId="nacos-1" namespaceId="dev" namespaceName="dev" />,
      );
    });
    await flushEffects();
    act(() => {
      latestConfigTableProps().onRow(rows[0]).onClick();
    });

    await act(async () => {
      renderer!.update(
        <NacosViewer connectionId="nacos-1" namespaceId="prod" namespaceName="prod" />,
      );
    });
    oldContextDetail.resolve({
      success: true,
      data: { ...rows[0], content: 'stale context detail', md5: 'stale-md5' },
    });
    await flushEffects();

    expect(
      renderer!.root.findAll((node) => (node.type as any) === 'nacos-editor'),
    ).toHaveLength(0);
    expect(nacosBackend.NacosStartConfigListen).not.toHaveBeenCalled();

    await act(async () => {
      renderer!.unmount();
    });
  });

  it('consumes a matching remote-change watch once and suppresses duplicate event prompts', async () => {
    nacosBackend.NacosStartConfigListen.mockResolvedValue({
      success: true,
      data: { watchId: 'watch-event' },
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <NacosViewer connectionId="nacos-1" namespaceId="dev" namespaceName="dev" />,
      );
    });
    await flushEffects();
    act(() => {
      latestConfigTableProps().onRow(rows[0]).onClick();
    });
    await flushEffects();
    expect(renderedText(renderer!.toJSON())).toContain('Listening');

    const event = {
      watchId: 'watch-event',
      connectionId: 'nacos-1',
      namespaceId: 'dev',
      group: rows[0].group,
      dataId: rows[0].dataId,
    };
    await act(async () => {
      runtimeState.configChangedHandler!(event);
      runtimeState.configChangedHandler!(event);
    });
    await flushEffects();

    expect(nacosBackend.NacosStopConfigListen).toHaveBeenCalledTimes(1);
    expect(nacosBackend.NacosStopConfigListen).toHaveBeenCalledWith(
      'watch-event',
    );
    expect(antdState.message.info).toHaveBeenCalledTimes(1);
    expect(renderedText(renderer!.toJSON())).not.toContain('Listening');

    expect(renderer!.root.findAll((node) => String(node.type) === 'alert')).toHaveLength(0);
    const compactNotice = renderer!.root.findByProps({
      className: 'gn-v2-nacos-remote-notice',
    });
    expect(renderedText(compactNotice)).toContain('Remote config update detected');
    expect(renderedText(compactNotice)).toContain('Reload remote');
    expect(renderedText(compactNotice)).not.toContain('Dismiss');
    expect(renderedText(compactNotice)).not.toContain('Local draft is clean');
    expect(compactNotice.findByProps({ 'aria-label': 'Dismiss' })).toBeTruthy();
    expect(
      renderer!.root.findByProps({ className: 'gn-v2-nacos-detail-pane' })
        .findByProps({ className: 'gn-v2-nacos-remote-notice' }),
    ).toBeTruthy();

    await act(async () => {
      findButtonByExactText(renderer!, 'Reload remote')!.props.onClick();
    });
    await flushEffects();
    expect(nacosBackend.NacosStartConfigListen).toHaveBeenCalledTimes(2);
    expect(renderedText(renderer!.toJSON())).toContain('Listening');

    await act(async () => {
      renderer!.unmount();
    });
    await flushEffects();
  });

  it('stops a listener whose start request resolves after unmount', async () => {
    const pendingListen = deferred<any>();
    nacosBackend.NacosStartConfigListen.mockReturnValue(pendingListen.promise);

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <NacosViewer connectionId="nacos-1" namespaceId="dev" namespaceName="dev" />,
      );
    });
    await flushEffects();
    act(() => {
      latestConfigTableProps().onRow(rows[0]).onClick();
    });
    await flushEffects();

    await act(async () => {
      renderer!.unmount();
    });
    pendingListen.resolve({
      success: true,
      data: { watchId: 'watch-after-unmount' },
    });
    await flushEffects();

    expect(nacosBackend.NacosStopConfigListen).toHaveBeenCalledWith(
      'watch-after-unmount',
    );
  });

  it.each([
    {
      name: 'explicit readOnly',
      configure: () => {
        storeState.connections[0].config.readOnly = true;
      },
    },
    {
      name: 'restrictDataEdit protection',
      configure: () => {
        storeState.connections[0].config.protection.restrictDataEdit = true;
      },
    },
  ])('disables config publishing and deletion for $name', async ({ configure }) => {
    configure();

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <NacosViewer connectionId="nacos-1" namespaceId="dev" namespaceName="dev" />,
      );
    });
    await flushEffects();

    await act(async () => {
      latestConfigTableProps().onRow(rows[0]).onClick();
    });
    await flushEffects();

    const editor = renderer!.root.find((node) => (node.type as any) === 'nacos-editor');
    await act(async () => {
      editor.props.onChange('changed: value');
    });

    expect(findButtonByExactText(renderer!, 'Publish')?.props.disabled).toBe(true);
    expect(findButtonByExactText(renderer!, 'Delete')?.props.disabled).toBe(true);

    renderer!.unmount();
  });

  it('does not flash an internal dirty badge while publishing edited content', async () => {
    const pendingPublish = deferred<any>();
    nacosBackend.NacosPublishConfig.mockReturnValue(pendingPublish.promise);

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <NacosViewer connectionId="nacos-1" namespaceId="dev" namespaceName="dev" />,
      );
    });
    await flushEffects();

    await act(async () => {
      latestConfigTableProps().onRow(rows[0]).onClick();
    });
    await flushEffects();

    await act(async () => {
      renderer!.root.find(
        (node) => (node.type as any) === 'nacos-editor',
      ).props.onChange('server: changed');
    });

    const publish = findButtonByExactText(renderer!, 'Publish');
    expect(publish?.props.disabled).toBe(false);
    expect(renderedText(renderer!.toJSON())).not.toContain('dirty');

    act(() => {
      publish!.props.onClick();
    });
    await flushEffects();

    expect(renderedText(renderer!.toJSON())).not.toContain('dirty');

    pendingPublish.resolve({ success: true });
    await flushEffects();

    expect(antdState.message.success).toHaveBeenCalledWith('Published successfully');
    expect(renderedText(renderer!.toJSON())).not.toContain('dirty');

    await act(async () => {
      renderer!.unmount();
    });
  });

  it('does not report its own publish event as a remote config change', async () => {
    const pendingListReload = deferred<any>();
    let pageListCalls = 0;
    nacosBackend.NacosSearchConfigs.mockImplementation(
      async (_config: unknown, query: any) => {
        if (query?.pageSize === 50) {
          pageListCalls += 1;
          if (pageListCalls === 2) return pendingListReload.promise;
        }
        return {
          success: true,
          data: {
            totalCount: rows.length,
            pageNumber: 1,
            pagesAvailable: 1,
            pageItems: rows,
          },
        };
      },
    );
    nacosBackend.NacosStartConfigListen.mockResolvedValue({
      success: true,
      data: { watchId: 'watch-publish' },
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <NacosViewer connectionId="nacos-1" namespaceId="dev" namespaceName="dev" />,
      );
    });
    await flushEffects();

    await act(async () => {
      latestConfigTableProps().onRow(rows[0]).onClick();
    });
    await flushEffects();

    await act(async () => {
      renderer!.root.find(
        (node) => (node.type as any) === 'nacos-editor',
      ).props.onChange('server: published locally');
    });
    act(() => {
      findButtonByExactText(renderer!, 'Publish')!.props.onClick();
    });
    await flushEffects();

    expect(antdState.message.success).not.toHaveBeenCalled();

    await act(async () => {
      runtimeState.configChangedHandler!({
        watchId: 'watch-publish',
        connectionId: 'nacos-1',
        namespaceId: 'dev',
        group: rows[0].group,
        dataId: rows[0].dataId,
      });
    });
    await flushEffects();

    const infoCallsDuringPublish = antdState.message.info.mock.calls.length;
    const remoteBannerDuringPublish = renderedText(renderer!.toJSON()).includes(
      'Remote config update detected',
    );

    pendingListReload.resolve({
      success: true,
      data: {
        totalCount: rows.length,
        pageNumber: 1,
        pagesAvailable: 1,
        pageItems: rows,
      },
    });
    await flushEffects();
    expect(antdState.message.success).toHaveBeenCalledWith('Published successfully');
    await act(async () => {
      renderer!.unmount();
    });

    expect(infoCallsDuringPublish).toBe(0);
    expect(remoteBannerDuringPublish).toBe(false);
  });

  it('disables config import for restrictDataImport protection only', async () => {
    storeState.connections[0].config.protection.restrictDataImport = true;

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <NacosViewer connectionId="nacos-1" namespaceId="dev" namespaceName="dev" />,
      );
    });
    await flushEffects();

    expect(findButtonByExactText(renderer!, 'Import')?.props.disabled).toBe(true);
    expect(findButtonByExactText(renderer!, 'New')?.props.disabled).toBe(false);

    renderer!.unmount();
  });
});
