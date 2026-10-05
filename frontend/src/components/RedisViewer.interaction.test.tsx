import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import RedisViewer from './RedisViewer';

const storeState = vi.hoisted(() => ({
  connections: [
    {
      id: 'redis-1',
      name: 'redis',
      config: {
        type: 'redis',
        host: '127.0.0.1',
        port: 6379,
        password: '',
        database: '',
      },
    },
  ],
  theme: 'light',
  appearance: {
    enabled: true,
    opacity: 1,
    blur: 0,
  },
}));

const redisBackend = vi.hoisted(() => ({
  RedisScanKeys: vi.fn(),
  RedisGetValue: vi.fn(),
  RedisGetListValue: vi.fn(),
  RedisListPush: vi.fn(),
  RedisListRemove: vi.fn(),
  RedisListSet: vi.fn(),
  RedisExportKeys: vi.fn(),
  RedisPreviewImportKeys: vi.fn(),
  RedisImportKeys: vi.fn(),
}));

const antdState = vi.hoisted(() => ({
  treeProps: null as any,
  tableProps: [] as any[],
  modalConfirm: vi.fn(),
  message: {
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock('../store', () => {
  const useStore = Object.assign(
    (selector: (state: typeof storeState) => any) => selector(storeState),
    { getState: () => storeState },
  );
  return { useStore };
});

vi.mock('@monaco-editor/react', async () => {
  const React = await import('react');
  return {
    default: () => React.createElement('div', { 'data-monaco-editor': true }),
  };
});

vi.mock('@ant-design/icons', async () => {
  const React = await import('react');
  const Icon = () => React.createElement('span', { 'data-icon': true });
  return {
    ReloadOutlined: Icon,
    DeleteOutlined: Icon,
    PlusOutlined: Icon,
    EditOutlined: Icon,
    EyeOutlined: Icon,
    SearchOutlined: Icon,
    ClockCircleOutlined: Icon,
    CopyOutlined: Icon,
    FolderOpenOutlined: Icon,
    KeyOutlined: Icon,
    PartitionOutlined: Icon,
    UnorderedListOutlined: Icon,
    TagsOutlined: Icon,
    RightOutlined: Icon,
    DownOutlined: Icon,
  };
});

vi.mock('antd', async () => {
  const React = await import('react');
  const passthrough = (tag: string) => ({ children, ...props }: any) => React.createElement(tag, props, children);
  const Button = ({ children, ...props }: any) => React.createElement('button', props, children);
  const Input = Object.assign(
    ({ ...props }: any) => React.createElement('input', props),
    {
      Search: ({ ...props }: any) => React.createElement('input', props),
      TextArea: ({ ...props }: any) => React.createElement('textarea', props),
    },
  );
  const FormComponent = Object.assign(
    ({ children, ...props }: any) => React.createElement('form', props, children),
    {
      Item: passthrough('div'),
      useForm: () => [{
        validateFields: vi.fn(),
        resetFields: vi.fn(),
        setFieldsValue: vi.fn(),
      }],
    },
  );

  return {
    Table: (props: any) => {
      antdState.tableProps.push(props);
      return React.createElement('redis-table');
    },
    Input,
    Button,
    Space: Object.assign(passthrough('div'), { Compact: passthrough('div') }),
    Tag: passthrough('span'),
    Tree: (props: any) => {
      antdState.treeProps = props;
      return React.createElement('redis-tree');
    },
    Spin: ({ children }: any) => React.createElement(React.Fragment, null, children),
    message: antdState.message,
    Modal: Object.assign(({ children, open, onOk, onCancel, okButtonProps, title, ...props }: any) => {
      if (!open) {
        return null;
      }
      return React.createElement('div', props, [
        React.createElement('div', { key: 'title', 'data-modal-title': true }, title),
        children,
        onOk ? React.createElement('button', { key: 'ok', onClick: onOk, disabled: okButtonProps?.disabled }, 'modal-ok') : null,
        onCancel ? React.createElement('button', { key: 'cancel', onClick: onCancel }, 'modal-cancel') : null,
      ]);
    }, { confirm: antdState.modalConfirm }),
    Form: FormComponent,
    InputNumber: ({ ...props }: any) => React.createElement('input', props),
    Popconfirm: passthrough('span'),
    Tooltip: ({ children }: any) => React.createElement(React.Fragment, null, children),
    Radio: {
      Group: passthrough('div'),
      Button,
    },
  };
});

const flushEffects = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
};

const collectRenderedText = (node: any): string => {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(collectRenderedText).join('');
  if (Array.isArray(node.children)) return node.children.map(collectRenderedText).join('');
  return '';
};

const findButtonByText = (renderer: ReactTestRenderer, text: string) => {
  return renderer.root.findAllByType('button').find((node) => collectRenderedText(node.props.children).includes(text));
};

const createRedisKeyBatch = (start: number, count: number) => Array.from({ length: count }, (_, index) => ({
  key: `matched:${start + index}`,
  type: 'string',
  ttl: -1,
}));

const countLeafNodes = (nodes: any[]): number => {
  return nodes.reduce((total, node) => {
    if (!node || typeof node !== 'object') {
      return total;
    }
    if (node.nodeType === 'leaf') {
      return total + 1;
    }
    return total + countLeafNodes(Array.isArray(node.children) ? node.children : []);
  }, 0);
};

const findFirstLeafNode = (nodes: any[]): any | null => {
  for (const node of nodes) {
    if (!node || typeof node !== 'object') {
      continue;
    }
    if (node.nodeType === 'leaf') {
      return node;
    }
    if (Array.isArray(node.children)) {
      const nested = findFirstLeafNode(node.children);
      if (nested) {
        return nested;
      }
    }
  }
  return null;
};

const findLeafNodeByRawKey = (nodes: any[], rawKey: string): any | null => {
  for (const node of nodes) {
    if (!node || typeof node !== 'object') {
      continue;
    }
    if (node.nodeType === 'leaf' && node.rawKey === rawKey) {
      return node;
    }
    if (Array.isArray(node.children)) {
      const nested = findLeafNodeByRawKey(node.children, rawKey);
      if (nested) {
        return nested;
      }
    }
  }
  return null;
};

describe('RedisViewer tree interactions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    antdState.treeProps = null;
    antdState.tableProps = [];
    antdState.modalConfirm.mockImplementation(() => ({ update: vi.fn(), destroy: vi.fn() }));
    storeState.connections = [
      {
        id: 'redis-1',
        name: 'redis',
        config: {
          type: 'redis',
          host: '127.0.0.1',
          port: 6379,
          password: '',
          database: '',
        },
      },
    ];

    redisBackend.RedisScanKeys.mockResolvedValue({
      success: true,
      data: {
        cursor: '0',
        keys: [
          { key: 'app:user:1', type: 'string', ttl: -1 },
          { key: 'app:user:2', type: 'string', ttl: -1 },
        ],
      },
    });
    redisBackend.RedisGetValue.mockResolvedValue({
      success: true,
      data: { key: 'app:user:1', type: 'string', ttl: -1, value: 'demo', length: 4 },
    });
    redisBackend.RedisGetListValue.mockResolvedValue({
      success: true,
      data: { key: 'app:user:1', type: 'list', ttl: -1, value: [], length: 0 },
    });
    redisBackend.RedisListPush.mockResolvedValue({ success: true });
    redisBackend.RedisListRemove.mockResolvedValue({ success: true });
    redisBackend.RedisListSet.mockResolvedValue({ success: true });
    redisBackend.RedisExportKeys.mockResolvedValue({
      success: true,
      data: { exported: 2 },
    });
    redisBackend.RedisPreviewImportKeys.mockResolvedValue({
      success: true,
      data: {
        file: 'C:\\tmp\\redis-keys.json',
        database: 0,
        total: 2,
        keys: [
          { key: 'app:user:1', type: 'string', ttl: -1 },
          { key: 'app:user:2', type: 'string', ttl: 120 },
        ],
      },
    });
    redisBackend.RedisImportKeys.mockResolvedValue({
      success: true,
      data: { imported: 1, skipped: 0, total: 1 },
    });
    vi.stubGlobal('window', {
      innerWidth: 1280,
      innerHeight: 800,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      go: {
        app: {
          App: redisBackend,
        },
      },
    });
    vi.stubGlobal('ResizeObserver', undefined);
  });

  it('requests regular key pages in batches of one hundred', async () => {
    redisBackend.RedisScanKeys.mockReset();
    redisBackend.RedisScanKeys
      .mockResolvedValueOnce({
        success: true,
        data: {
          cursor: '27',
          keys: [{ key: 'app:user:1', type: 'string', ttl: -1 }],
        },
      })
      .mockResolvedValueOnce({
        success: true,
        data: {
          cursor: '0',
          keys: [{ key: 'app:user:2', type: 'string', ttl: -1 }],
        },
      });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<RedisViewer connectionId="redis-1" redisDB={0} />);
    });
    await flushEffects();

    expect(redisBackend.RedisScanKeys.mock.calls[0]?.slice(1)).toEqual(['*', '0', 100]);

    const loadMoreButton = findButtonByText(renderer!, 'Load more');
    expect(loadMoreButton).toBeTruthy();
    await act(async () => {
      loadMoreButton!.props.onClick?.();
    });
    await flushEffects();

    expect(redisBackend.RedisScanKeys.mock.calls[1]?.slice(1)).toEqual(['*', '27', 100]);
    expect(countLeafNodes(antdState.treeProps.treeData)).toBe(2);

    renderer!.unmount();
  });

  it('uses native scrolling for a small Key page and virtualizes larger loaded sets', async () => {
    redisBackend.RedisScanKeys.mockResolvedValue({
      success: true,
      data: {
        cursor: '0',
        keys: createRedisKeyBatch(0, 101),
      },
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<RedisViewer connectionId="redis-1" redisDB={0} />);
    });
    await flushEffects();

    expect(antdState.treeProps.virtual).toBe(false);
    renderer!.unmount();

    redisBackend.RedisScanKeys.mockResolvedValue({
      success: true,
      data: {
        cursor: '0',
        keys: createRedisKeyBatch(0, 500),
      },
    });

    await act(async () => {
      renderer = create(<RedisViewer connectionId="redis-1" redisDB={0} />);
    });
    await flushEffects();

    expect(antdState.treeProps.virtual).toBe(false);
    renderer!.unmount();

    redisBackend.RedisScanKeys.mockResolvedValue({
      success: true,
      data: {
        cursor: '0',
        keys: createRedisKeyBatch(0, 501),
      },
    });

    await act(async () => {
      renderer = create(<RedisViewer connectionId="redis-1" redisDB={0} />);
    });
    await flushEffects();

    expect(antdState.treeProps.virtual).toBe(true);
    const largeSetScanCount = redisBackend.RedisScanKeys.mock.calls.length;
    for (const mode of ['list', 'type'] as const) {
      await act(async () => {
        renderer!.root.findByProps({ 'data-redis-key-view-mode': mode }).props.onClick?.();
      });
      await flushEffects();
      expect(antdState.treeProps.virtual).toBe(true);
      expect(redisBackend.RedisScanKeys).toHaveBeenCalledTimes(largeSetScanCount);
    }
    renderer!.unmount();
  });

  it('switches between tree, list, and type Key views without rescanning', async () => {
    redisBackend.RedisScanKeys.mockResolvedValue({
      success: true,
      data: {
        cursor: '0',
        keys: [
          { key: 'app:user:1', type: 'string', ttl: -1 },
          { key: 'app:user:2', type: 'string', ttl: 120 },
          { key: 'app:order:1', type: 'hash', ttl: -1 },
          { key: 'misc', type: 'set', ttl: -1 },
        ],
      },
    });

    let renderer: ReactTestRenderer;
    let typeGroupTitleRenderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<RedisViewer connectionId="redis-1" redisDB={0} />);
    });
    await flushEffects();

    const initialScanCount = redisBackend.RedisScanKeys.mock.calls.length;
    const treeButton = renderer!.root.findByProps({ 'data-redis-key-view-mode': 'tree' });
    const listButton = renderer!.root.findByProps({ 'data-redis-key-view-mode': 'list' });
    const typeButton = renderer!.root.findByProps({ 'data-redis-key-view-mode': 'type' });
    expect(treeButton.props['aria-pressed']).toBe(true);
    expect(treeButton.props['aria-label']).toBe('Tree view');
    expect(listButton.props['aria-label']).toBe('List view');
    expect(typeButton.props['aria-label']).toBe('Group by type');
    expect(antdState.treeProps.virtual).toBe(false);

    const appGroup = antdState.treeProps.treeData.find((node: any) => node.key === 'group:app');
    const appGroupTitle = antdState.treeProps.titleRender(appGroup);
    await act(async () => {
      appGroupTitle.props.onClick({ preventDefault: vi.fn(), stopPropagation: vi.fn() });
    });
    expect(antdState.treeProps.expandedKeys).toContain('group:app');

    const selectedLeaf = findLeafNodeByRawKey(antdState.treeProps.treeData, 'app:user:1');
    const checkedLeaf = findLeafNodeByRawKey(antdState.treeProps.treeData, 'app:order:1');
    await act(async () => {
      antdState.treeProps.onSelect?.([selectedLeaf.key]);
      antdState.treeProps.onCheck?.(
        { checked: [checkedLeaf.key], halfChecked: [] },
        { checked: true, node: checkedLeaf },
      );
    });
    await flushEffects();

    await act(async () => {
      listButton.props.onClick?.();
    });
    await flushEffects();

    expect(redisBackend.RedisScanKeys).toHaveBeenCalledTimes(initialScanCount);
    expect(antdState.treeProps.virtual).toBe(false);
    expect(antdState.treeProps.treeData.every((node: any) => node.nodeType === 'leaf')).toBe(true);
    expect(antdState.treeProps.treeData.map((node: any) => node.leafLabel)).toEqual([
      'app:order:1',
      'app:user:1',
      'app:user:2',
      'misc',
    ]);
    expect(antdState.treeProps.selectedKeys).toEqual(['key:app:user:1']);
    expect(antdState.treeProps.checkedKeys.checked).toContain('key:app:order:1');
    expect(renderer!.root.findByProps({ 'data-redis-key-view-mode': 'list' }).props['aria-pressed']).toBe(true);

    await act(async () => {
      typeButton.props.onClick?.();
    });
    await flushEffects();

    expect(redisBackend.RedisScanKeys).toHaveBeenCalledTimes(initialScanCount);
    expect(antdState.treeProps.virtual).toBe(false);
    expect(antdState.treeProps.treeData.map((node: any) => node.key)).toEqual([
      'type-group:string',
      'type-group:hash',
      'type-group:set',
    ]);
    expect(antdState.treeProps.treeData.map((node: any) => node.groupLeafCount)).toEqual([2, 1, 1]);
    expect(antdState.treeProps.selectedKeys).toEqual(['key:app:user:1']);
    expect(antdState.treeProps.checkedKeys.checked).toEqual(expect.arrayContaining([
      'key:app:order:1',
      'type-group:hash',
    ]));

    const stringTypeGroup = antdState.treeProps.treeData[0];
    await act(async () => {
      typeGroupTitleRenderer = create(antdState.treeProps.titleRender(stringTypeGroup));
    });
    expect(typeGroupTitleRenderer!.root.findAllByProps({ 'aria-label': 'Filter by namespace' })).toHaveLength(0);
    const typeGroupEvent = { preventDefault: vi.fn(), stopPropagation: vi.fn() };
    await act(async () => {
      typeGroupTitleRenderer!.root.findByProps({ role: 'button' }).props.onClick(typeGroupEvent);
    });
    expect(antdState.treeProps.expandedKeys).toContain('type-group:string');

    await act(async () => {
      renderer!.root.findByProps({ 'data-redis-key-view-mode': 'tree' }).props.onClick?.();
    });
    await flushEffects();
    expect(antdState.treeProps.expandedKeys).toContain('group:app');
    expect(antdState.treeProps.virtual).toBe(false);

    await act(async () => {
      renderer!.root.findByProps({ 'data-redis-key-view-mode': 'type' }).props.onClick?.();
    });
    await flushEffects();
    expect(antdState.treeProps.expandedKeys).toContain('type-group:string');
    expect(antdState.treeProps.virtual).toBe(false);

    typeGroupTitleRenderer!.unmount();
    renderer!.unmount();
  });

  it('toggles namespace expansion from row clicks without checking the group', async () => {
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<RedisViewer connectionId="redis-1" redisDB={0} />);
    });
    await flushEffects();

    const appGroup = antdState.treeProps.treeData.find((node: any) => node.key === 'group:app');
    expect(appGroup).toBeTruthy();
    // rc-tree maps a click on an unselectable, checkable node to onCheck.
    // Groups must remain selectable so a row click reaches onSelect (which
    // RedisViewer safely ignores for nodes without a raw Redis key).
    expect(appGroup.selectable).not.toBe(false);
    expect(antdState.treeProps.expandedKeys).not.toContain('group:app');

    const groupTitle = antdState.treeProps.titleRender(appGroup);
    expect(typeof groupTitle.props.onClick).toBe('function');

    const event = {
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };
    await act(async () => {
      groupTitle.props.onClick(event);
    });

    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalled();
    expect(antdState.treeProps.expandedKeys).toContain('group:app');
    expect(antdState.treeProps.checkedKeys.checked).toEqual([]);

    renderer!.unmount();
  });

  it('filters keys by the full namespace path from a group action', async () => {
    let renderer: ReactTestRenderer;
    let groupTitleRenderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<RedisViewer connectionId="redis-1" redisDB={0} />);
    });
    await flushEffects();

    const searchModeGroup = renderer!.root.findAll(
      node => node.props.buttonStyle === 'solid' && typeof node.props.onChange === 'function',
    )[0];
    await act(async () => {
      searchModeGroup.props.onChange({ target: { value: 'exact' } });
    });
    await flushEffects();

    const appGroup = antdState.treeProps.treeData.find((node: any) => node.key === 'group:app');
    const userGroup = appGroup.children.find((node: any) => node.key === 'group:app:user');
    await act(async () => {
      groupTitleRenderer = create(antdState.treeProps.titleRender(userGroup));
    });

    const filterButton = groupTitleRenderer!.root.findByProps({ 'aria-label': 'Filter by namespace' });
    const event = {
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };
    await act(async () => {
      filterButton.props.onClick(event);
    });
    await flushEffects();

    const searchInput = renderer!.root.findAllByType('input').find(node => typeof node.props.onSearch === 'function');
    const updatedSearchModeGroup = renderer!.root.findAll(
      node => node.props.buttonStyle === 'solid' && typeof node.props.onChange === 'function',
    )[0];

    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalled();
    expect(searchInput?.props.value).toBe('app:user');
    expect(updatedSearchModeGroup.props.value).toBe('prefix');
    expect(redisBackend.RedisScanKeys).toHaveBeenLastCalledWith(
      expect.any(Object),
      '[aA][pP][pP]:[uU][sS][eE][rR]*',
      '0',
      100,
    );

    groupTitleRenderer!.unmount();
    renderer!.unmount();
  });

  it('shows Redis Cluster topology context in the key explorer header', async () => {
    storeState.connections = [
      {
        id: 'redis-1',
        name: 'redis-cluster',
        config: {
          type: 'redis',
          host: '10.0.0.1',
          port: 6379,
          hosts: ['10.0.0.2:6379', '10.0.0.3:6379'],
          topology: 'cluster',
          password: '',
          database: '',
        } as any,
      },
    ];

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<RedisViewer connectionId="redis-1" redisDB={2} />);
    });
    await flushEffects();

    const renderedText = collectRenderedText(renderer!.toJSON());
    expect(renderedText).toContain('db2');
    expect(renderedText).toContain('Cluster');
    expect(renderedText).toContain('3 nodes');
    expect(redisBackend.RedisScanKeys).toHaveBeenLastCalledWith(
      expect.any(Object),
      '*',
      '0',
      2000,
    );

    renderer!.unmount();
  });

  it('renders key detail actions on a separate row below the metadata', async () => {
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<RedisViewer connectionId="redis-1" redisDB={0} />);
    });
    await flushEffects();

    const leafNode = findFirstLeafNode(antdState.treeProps.treeData);
    await act(async () => {
      antdState.treeProps.onSelect?.([leafNode.key]);
    });
    await flushEffects();

    const header = renderer!.root.find((node) => String(node.props.className || '').split(/\s+/).includes('redis-key-detail-header'));
    const top = renderer!.root.find((node) => String(node.props.className || '').split(/\s+/).includes('redis-key-detail-top'));
    const viewMode = renderer!.root.find((node) => String(node.props.className || '').split(/\s+/).includes('redis-key-view-mode'));
    const summary = renderer!.root.findByProps({ className: 'redis-key-detail-summary' });
    const identity = renderer!.root.findByProps({ className: 'redis-key-detail-identity' });
    const metadata = renderer!.root.findByProps({ className: 'redis-key-detail-metadata' });
    const actions = renderer!.root.findByProps({ className: 'redis-key-detail-actions' });

    expect(header.props.style).toMatchObject({ flexDirection: 'column' });
    expect(header.parent).toBe(top);
    expect(viewMode.parent).toBe(top);
    expect(summary.props.style).toMatchObject({ minWidth: 0, width: '100%' });
    expect(identity.props.style).toMatchObject({ minWidth: 0, width: '100%' });
    expect(identity.parent).toBe(summary);
    expect(metadata.parent).toBe(summary);
    expect(actions.parent).toBe(summary);
    expect(summary.children.indexOf(identity)).toBeLessThan(summary.children.indexOf(metadata));
    expect(summary.children.indexOf(metadata)).toBeLessThan(summary.children.indexOf(actions));
    expect(actions.props.style).toMatchObject({
      alignSelf: 'flex-start',
      flexWrap: 'wrap',
      maxWidth: '100%',
    });
    const activeKey = renderer!.root.findByProps({ 'data-redis-active-key': 'true' });
    expect(activeKey.props.style).toMatchObject({ flex: '0 1 auto', minWidth: 0, textOverflow: 'ellipsis' });
    expect(activeKey.props.style).not.toHaveProperty('maxWidth');
    expect(findButtonByText(renderer!, 'Set TTL')).toBeTruthy();
    expect(findButtonByText(renderer!, 'Refresh')).toBeTruthy();
    expect(findButtonByText(renderer!, 'Delete Key')).toBeTruthy();

    renderer!.unmount();
  });

  it('keeps the V2 value grid mounted while refresh and key switches are pending', async () => {


    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<RedisViewer connectionId="redis-1" redisDB={0} />);
    });
    await flushEffects();

    const firstLeaf = findFirstLeafNode(antdState.treeProps.treeData);
    await act(async () => {
      antdState.treeProps.onSelect?.([firstLeaf.key]);
    });
    await flushEffects();

    let resolveRefresh!: (value: any) => void;
    const pendingRefresh = new Promise<any>((resolve) => {
      resolveRefresh = resolve;
    });
    redisBackend.RedisGetValue.mockReturnValueOnce(pendingRefresh);

    const detailActions = renderer!.root.findByProps({ className: 'redis-key-detail-actions' });
    const refreshButton = detailActions.findAllByType('button')
      .find((node) => collectRenderedText(node.props.children).includes('Refresh'));
    await act(async () => {
      refreshButton!.props.onClick?.();
      await Promise.resolve();
    });

    expect(renderer!.root.findByProps({ 'data-redis-active-key': 'true' }).children).toEqual(['app:user:1']);
    const loadingOverlay = renderer!.root.findByProps({ 'data-redis-value-loading-overlay': 'true' });
    expect(loadingOverlay.parent?.props.className).toBe('gn-v2-redis-value-pane');
    expect(loadingOverlay.props.style).toMatchObject({
      position: 'absolute',
      inset: 0,
    });
    expect(loadingOverlay.props.style).not.toHaveProperty('gridColumn');
    expect(loadingOverlay.props.style).not.toHaveProperty('gridRow');

    await act(async () => {
      resolveRefresh({
        success: true,
        data: { key: 'app:user:1', type: 'string', ttl: -1, value: 'refreshed', length: 9 },
      });
      await pendingRefresh;
    });
    await flushEffects();
    expect(renderer!.root.findAllByProps({ 'data-redis-value-loading-overlay': 'true' })).toHaveLength(0);

    const secondLeaf = antdState.treeProps.treeData
      .flatMap((node: any) => node.children || [])
      .flatMap((node: any) => node.children || [])
      .find((node: any) => node.rawKey === 'app:user:2');
    let resolveSwitch!: (value: any) => void;
    const pendingSwitch = new Promise<any>((resolve) => {
      resolveSwitch = resolve;
    });
    redisBackend.RedisGetValue.mockReturnValueOnce(pendingSwitch);

    await act(async () => {
      antdState.treeProps.onSelect?.([secondLeaf.key]);
      await Promise.resolve();
    });

    expect(renderer!.root.findByProps({ 'data-redis-active-key': 'true' }).children).toEqual(['app:user:1']);
    expect(renderer!.root.findAllByProps({ 'data-redis-value-loading-overlay': 'true' })).toHaveLength(1);

    await act(async () => {
      resolveSwitch({
        success: true,
        data: { key: 'app:user:2', type: 'string', ttl: -1, value: 'next', length: 4 },
      });
      await pendingSwitch;
    });
    await flushEffects();

    expect(renderer!.root.findByProps({ 'data-redis-active-key': 'true' }).children).toEqual(['app:user:2']);
    expect(renderer!.root.findAllByProps({ 'data-redis-value-loading-overlay': 'true' })).toHaveLength(0);

    renderer!.unmount();
  });

  it('continues a filtered scan when the first cursor page has no matching keys', async () => {
    redisBackend.RedisScanKeys.mockReset();
    redisBackend.RedisScanKeys
      .mockResolvedValueOnce({
        success: true,
        data: {
          cursor: '0',
          keys: [{ key: 'app:user:1', type: 'string', ttl: -1 }],
        },
      })
      .mockResolvedValueOnce({
        success: true,
        data: { cursor: '27', keys: [] },
      })
      .mockResolvedValueOnce({
        success: true,
        data: {
          cursor: '0',
          keys: [{ key: 'sub:v2:lock', type: 'string', ttl: 2400 }],
        },
      });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<RedisViewer connectionId="redis-1" redisDB={0} />);
    });
    await flushEffects();

    const searchInput = renderer!.root.findAllByType('input')
      .find((node) => typeof node.props.onSearch === 'function');
    expect(searchInput).toBeTruthy();

    await act(async () => {
      searchInput!.props.onSearch('sub:v2');
    });
    await flushEffects();

    expect(redisBackend.RedisScanKeys).toHaveBeenCalledTimes(3);
    expect(redisBackend.RedisScanKeys.mock.calls[1]?.[2]).toBe('0');
    expect(redisBackend.RedisScanKeys.mock.calls[2]?.[2]).toBe('27');
    expect(countLeafNodes(antdState.treeProps.treeData)).toBe(1);
    expect(findFirstLeafNode(antdState.treeProps.treeData)?.rawKey).toBe('sub:v2:lock');

    renderer!.unmount();
  });

  it('loads and deduplicates every filtered cursor page automatically', async () => {
    redisBackend.RedisScanKeys.mockReset();
    redisBackend.RedisScanKeys
      .mockResolvedValueOnce({
        success: true,
        data: {
          cursor: '0',
          keys: [{ key: 'app:user:1', type: 'string', ttl: -1 }],
        },
      })
      .mockResolvedValueOnce({
        success: true,
        data: {
          cursor: '27',
          keys: [
            { key: 'sub:v2:first', type: 'string', ttl: -1 },
            { key: 'sub:v2:shared', type: 'string', ttl: -1 },
          ],
        },
      })
      .mockResolvedValueOnce({
        success: true,
        data: { cursor: '31', keys: [] },
      })
      .mockResolvedValueOnce({
        success: true,
        data: {
          cursor: '0',
          keys: [
            { key: 'sub:v2:shared', type: 'string', ttl: -1 },
            { key: 'sub:v2:last', type: 'string', ttl: -1 },
          ],
        },
      });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<RedisViewer connectionId="redis-1" redisDB={0} />);
    });
    await flushEffects();

    const searchInput = renderer!.root.findAllByType('input')
      .find((node) => typeof node.props.onSearch === 'function');
    await act(async () => {
      searchInput!.props.onSearch('sub:v2');
    });
    await flushEffects();

    expect(redisBackend.RedisScanKeys).toHaveBeenCalledTimes(4);
    expect(redisBackend.RedisScanKeys.mock.calls.slice(1).map((call) => call[2])).toEqual(['0', '27', '31']);
    expect(countLeafNodes(antdState.treeProps.treeData)).toBe(3);
    expect(collectRenderedText(renderer!.toJSON())).toContain('Loaded 3 Keys');
    expect(findButtonByText(renderer!, 'Load more')).toBeUndefined();

    renderer!.unmount();
  });

  it('loads more than two thousand filtered keys without manual paging', async () => {
    redisBackend.RedisScanKeys.mockReset();
    redisBackend.RedisScanKeys
      .mockResolvedValueOnce({
        success: true,
        data: {
          cursor: '0',
          keys: [{ key: 'app:user:1', type: 'string', ttl: -1 }],
        },
      })
      .mockResolvedValueOnce({
        success: true,
        data: { cursor: '27', keys: createRedisKeyBatch(0, 1000) },
      })
      .mockResolvedValueOnce({
        success: true,
        data: { cursor: '31', keys: createRedisKeyBatch(1000, 1000) },
      })
      .mockResolvedValueOnce({
        success: true,
        data: { cursor: '0', keys: createRedisKeyBatch(2000, 1) },
      });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<RedisViewer connectionId="redis-1" redisDB={0} />);
    });
    await flushEffects();

    const searchInput = renderer!.root.findAllByType('input')
      .find((node) => typeof node.props.onSearch === 'function');
    await act(async () => {
      searchInput!.props.onSearch('matched');
    });
    await flushEffects();

    expect(redisBackend.RedisScanKeys.mock.calls.slice(1).map((call) => call[2])).toEqual(['0', '27', '31']);
    expect(countLeafNodes(antdState.treeProps.treeData)).toBe(2001);
    expect(collectRenderedText(renderer!.toJSON())).toContain('Loaded 2001 Keys');
    expect(findButtonByText(renderer!, 'Load more')).toBeUndefined();

    renderer!.unmount();
  });

  it('rejects filtered searches that exceed the result safety limit', async () => {
    redisBackend.RedisScanKeys.mockReset();
    redisBackend.RedisScanKeys
      .mockResolvedValueOnce({
        success: true,
        data: {
          cursor: '0',
          keys: [{ key: 'app:user:1', type: 'string', ttl: -1 }],
        },
      })
      .mockResolvedValueOnce({
        success: true,
        data: { cursor: '27', keys: createRedisKeyBatch(0, 5000) },
      })
      .mockResolvedValueOnce({
        success: true,
        data: { cursor: '0', keys: createRedisKeyBatch(5000, 5001) },
      });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<RedisViewer connectionId="redis-1" redisDB={0} />);
    });
    await flushEffects();

    const searchInput = renderer!.root.findAllByType('input')
      .find((node) => typeof node.props.onSearch === 'function');
    await act(async () => {
      searchInput!.props.onSearch('matched');
    });
    await flushEffects();

    expect(redisBackend.RedisScanKeys).toHaveBeenCalledTimes(3);
    expect(antdState.message.error).toHaveBeenCalledWith(expect.stringContaining('10000'));
    expect(countLeafNodes(antdState.treeProps.treeData)).toBe(1);

    renderer!.unmount();
  });

  it('keeps exact searches on the existing initial page size', async () => {
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<RedisViewer connectionId="redis-1" redisDB={0} />);
    });
    await flushEffects();

    const searchModeGroup = renderer!.root.findAll(
      node => node.props.buttonStyle === 'solid' && typeof node.props.onChange === 'function',
    )[0];
    await act(async () => {
      searchModeGroup.props.onChange({ target: { value: 'exact' } });
    });
    await flushEffects();

    const searchInput = renderer!.root.findAllByType('input')
      .find((node) => typeof node.props.onSearch === 'function');
    await act(async () => {
      searchInput!.props.onSearch('app:user');
    });
    await flushEffects();

    expect(redisBackend.RedisScanKeys).toHaveBeenLastCalledWith(
      expect.any(Object),
      'app:user',
      '0',
      100,
    );

    renderer!.unmount();
  });

  it('runs and refreshes fuzzy searches to completion with the same pattern', async () => {
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<RedisViewer connectionId="redis-1" redisDB={0} />);
    });
    await flushEffects();

    expect(findButtonByText(renderer!, 'Fuzzy')).toBeTruthy();
    const searchModeGroup = renderer!.root.findAll(
      node => node.props.buttonStyle === 'solid' && typeof node.props.onChange === 'function',
    )[0];
    await act(async () => {
      searchModeGroup.props.onChange({ target: { value: 'fuzzy' } });
    });
    await flushEffects();

    redisBackend.RedisScanKeys.mockReset();
    redisBackend.RedisScanKeys
      .mockResolvedValueOnce({
        success: true,
        data: { cursor: '27', keys: [{ key: 'TmpProxy', type: 'string', ttl: -1 }] },
      })
      .mockResolvedValueOnce({
        success: true,
        data: { cursor: '0', keys: [{ key: 'app:TmpProfile', type: 'string', ttl: -1 }] },
      });

    const searchInput = renderer!.root.findAllByType('input')
      .find((node) => typeof node.props.onSearch === 'function');
    await act(async () => {
      searchInput!.props.onSearch('mpP');
    });
    await flushEffects();

    expect(redisBackend.RedisScanKeys.mock.calls.map((call) => call.slice(1))).toEqual([
      ['*[mM][pP][pP]*', '0', 100],
      ['*[mM][pP][pP]*', '27', 100],
    ]);
    expect(countLeafNodes(antdState.treeProps.treeData)).toBe(2);

    redisBackend.RedisScanKeys.mockClear();
    redisBackend.RedisScanKeys
      .mockResolvedValueOnce({
        success: true,
        data: { cursor: '27', keys: [{ key: 'TmpProxy', type: 'string', ttl: -1 }] },
      })
      .mockResolvedValueOnce({
        success: true,
        data: { cursor: '0', keys: [{ key: 'app:TmpProfile', type: 'string', ttl: -1 }] },
      });
    await act(async () => {
      findButtonByText(renderer!, 'Refresh')!.props.onClick?.();
    });
    await flushEffects();

    expect(redisBackend.RedisScanKeys.mock.calls.map((call) => call.slice(1))).toEqual([
      ['*[mM][pP][pP]*', '0', 100],
      ['*[mM][pP][pP]*', '27', 100],
    ]);
    expect(countLeafNodes(antdState.treeProps.treeData)).toBe(2);

    renderer!.unmount();
  });

  it('keeps exact search continuation available after the first page', async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      key: `app:user:${index}`,
      type: 'string',
      ttl: -1,
    }));
    redisBackend.RedisScanKeys.mockReset();
    redisBackend.RedisScanKeys
      .mockResolvedValueOnce({
        success: true,
        data: {
          cursor: '0',
          keys: [{ key: 'app:user:1', type: 'string', ttl: -1 }],
        },
      })
      .mockResolvedValueOnce({
        success: true,
        data: { cursor: '27', keys: firstPage },
      })
      .mockResolvedValueOnce({
        success: true,
        data: { cursor: '0', keys: [{ key: 'app:user:100', type: 'string', ttl: -1 }] },
      });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<RedisViewer connectionId="redis-1" redisDB={0} />);
    });
    await flushEffects();

    const searchModeGroup = renderer!.root.findAll(
      node => node.props.buttonStyle === 'solid' && typeof node.props.onChange === 'function',
    )[0];
    await act(async () => {
      searchModeGroup.props.onChange({ target: { value: 'exact' } });
    });
    await flushEffects();

    redisBackend.RedisScanKeys.mockReset();
    redisBackend.RedisScanKeys
      .mockResolvedValueOnce({
        success: true,
        data: { cursor: '27', keys: firstPage },
      })
      .mockResolvedValueOnce({
        success: true,
        data: { cursor: '0', keys: [{ key: 'app:user:100', type: 'string', ttl: -1 }] },
      });

    const searchInput = renderer!.root.findAllByType('input')
      .find((node) => typeof node.props.onSearch === 'function');
    await act(async () => {
      searchInput!.props.onSearch('app:user');
    });
    await flushEffects();

    expect(redisBackend.RedisScanKeys.mock.calls[0]?.slice(1)).toEqual(['app:user', '0', 100]);
    expect(countLeafNodes(antdState.treeProps.treeData)).toBe(100);
    const loadMoreButton = findButtonByText(renderer!, 'Load more');
    expect(loadMoreButton).toBeTruthy();
    await act(async () => {
      loadMoreButton!.props.onClick?.();
    });
    await flushEffects();

    expect(redisBackend.RedisScanKeys.mock.calls[1]?.slice(1)).toEqual(['app:user', '27', 100]);
    expect(countLeafNodes(antdState.treeProps.treeData)).toBe(101);

    renderer!.unmount();
  });
});
