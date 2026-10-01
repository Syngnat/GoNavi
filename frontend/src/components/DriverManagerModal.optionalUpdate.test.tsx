import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { t } from '../i18n';

const storeState = {
  theme: 'light',
  languagePreference: 'zh-CN',
  setLanguagePreference: vi.fn(async () => {}),
  appearance: { opacity: 1 },
};

const backendApp = {
  CancelDriverPackageDownload: vi.fn(),
  CheckDriverNetworkStatus: vi.fn(),
  GetDriverVersionList: vi.fn(),
  GetDriverVersionPackageSize: vi.fn(),
  GetDriverStatusList: vi.fn(),
  InstallLocalDriverPackage: vi.fn(),
  ListDriverDownloadTasks: vi.fn(),
  OpenDriverDownloadDirectory: vi.fn(),
  RemoveDriverPackage: vi.fn(),
  SelectDriverPackageDirectory: vi.fn(),
  SelectDriverPackageFile: vi.fn(),
  StartDriverPackageDownload: vi.fn(),
};

const textContent = (node: any): string => {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map((item) => textContent(item)).join('');
  return textContent(node.children || []);
};

const OPTIONAL_UPDATE_DISMISS_KEY = 'gonavi.driver.optionalUpdate.dismissedRevision';
const localStorageSpies = { getItem: vi.fn(), setItem: vi.fn() };
const localStorageMap = new Map<string, string>();
const buildWindowStub = () => ({
  localStorage: {
    getItem: (key: string) => {
      localStorageSpies.getItem(key);
      return localStorageMap.has(key) ? localStorageMap.get(key)! : null;
    },
    setItem: (key: string, value: string) => {
      localStorageMap.set(key, value);
      localStorageSpies.setItem(key, value);
    },
  },
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
});

const findButton = (renderer: ReactTestRenderer, text: string) =>
  renderer.root.findAll((node) => node.type === 'button' && textContent(node).includes(text))[0];

const findNeedsUpdateChipCount = (renderer: ReactTestRenderer): string => {
  const chip = renderer.root.findAll(
    (node) => node.type === 'button'
      && String(node.props.className || '').includes('driver-manager-filter-chip')
      && textContent(node).includes('需重装'),
  )[0];
  const countSpan = chip?.findAll(
    (node) => node.props.className === 'driver-manager-filter-chip-count',
  )[0];
  return countSpan ? textContent(countSpan) : '';
};

const findListDotToneCount = (renderer: ReactTestRenderer, tone: string): number =>
  renderer.root.findAll(
    (node) => node.type === 'span' && String(node.props.className || '').includes(`driver-manager-net-dot-${tone}`),
  ).length;

vi.mock('../store', () => ({
  useStore: (selector: (state: typeof storeState) => unknown) =>
    selector(storeState),
}));

vi.mock('../../wailsjs/go/app/App', () => backendApp);

vi.mock('../../wailsjs/runtime/runtime', () => ({
  EventsOn: vi.fn(() => vi.fn()),
}));

vi.mock('@ant-design/icons', async () => {
  const React = await import('react');
  const makeIcon = (name: string) => () => React.createElement('i', { 'data-icon': name });
  return {
    DeleteOutlined: makeIcon('delete'),
    DownOutlined: makeIcon('down'),
    DownloadOutlined: makeIcon('download'),
    ExportOutlined: makeIcon('export'),
    FileSearchOutlined: makeIcon('file-search'),
    FolderOpenOutlined: makeIcon('folder-open'),
    ImportOutlined: makeIcon('import'),
    InfoCircleFilled: makeIcon('info-circle'),
    ReloadOutlined: makeIcon('reload'),
  };
});

vi.mock('antd', () => {
  const Button = ({ children, disabled, loading, onClick, ...rest }: any) => (
    <button type="button" disabled={disabled || loading} onClick={onClick} {...rest}>
      {children}
    </button>
  );
  const Dropdown: any = ({ children }: any) => <>{children}</>;
  Dropdown.Button = ({ children }: any) => <>{children}</>;
  const Modal: any = ({ title, children, footer, open }: any) =>
    open ? (
      <section>
        <div>{title}</div>
        <div>{children}</div>
        <div>{footer}</div>
      </section>
    ) : null;
  Modal.confirm = vi.fn();
  const Collapse = ({ items }: any) => (
    <div>{items?.map((item: any) => <div key={item.key}>{item.children}</div>)}</div>
  );
  const Input: any = ({ value, onChange, placeholder, ...rest }: any) => (
    <input value={value} onChange={onChange} placeholder={placeholder} {...rest} />
  );
  Input.Search = ({ value, onChange, placeholder, ...rest }: any) => (
    <input value={value} onChange={onChange} placeholder={placeholder} {...rest} />
  );
  const Space = ({ children }: any) => <div>{children}</div>;
  const Tag = ({ children }: any) => <span>{children}</span>;
  const Switch = ({ checked, onChange, ...rest }: any) => (
    <button type="button" data-checked={checked} onClick={() => onChange?.(!checked)} {...rest}>
      switch
    </button>
  );
  const Progress = ({ percent }: any) => <div>{percent}</div>;
  const Select = ({ placeholder }: any) => <div>{placeholder}</div>;
  const Empty: any = ({ description }: any) => <div>{description}</div>;
  Empty.PRESENTED_IMAGE_SIMPLE = 'empty';
  const Alert = ({ message, description }: any) => (
    <div>
      <div>{message}</div>
      <div>{description}</div>
    </div>
  );
  const Typography = {
    Text: ({ children }: any) => <span>{children}</span>,
    Paragraph: ({ children }: any) => <div>{children}</div>,
  };
  const Tooltip = ({ children }: any) => <>{children}</>;
  const Popover = ({ children }: any) => <>{children}</>;
  const Icon = () => <i />;
  const Checkbox = ({ children, checked, onChange }: any) => (
    <label>
      <input type="checkbox" checked={checked} onChange={onChange} />
      {children}
    </label>
  );
  const Table = ({ dataSource, columns, rowKey }: any) => (
    <table>
      <tbody>
        {(dataSource || []).map((row: any, index: number) => (
          <tr key={typeof rowKey === 'function' ? rowKey(row) : index}>
            {(columns || []).map((column: any) => (
              <td key={column.key}>{column.render ? column.render(row[column.dataIndex], row) : row[column.dataIndex]}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
  return {
    Alert,
    Button,
    Checkbox,
    Collapse,
    Dropdown,
    Input,
    Modal,
    Popover,
    Progress,
    Select,
    Space,
    Switch,
    Table,
    Tag,
    Tooltip,
    Typography,
    message: { error: vi.fn(), warning: vi.fn(), success: vi.fn(), info: vi.fn() },
    theme: { useToken: () => ({ token: { colorPrimary: '#1677ff' } }) },
    icons: {
      DeleteOutlined: Icon,
      DownOutlined: Icon,
      DownloadOutlined: Icon,
      FileSearchOutlined: Icon,
      FolderOpenOutlined: Icon,
      InfoCircleFilled: Icon,
      ReloadOutlined: Icon,
      StopOutlined: Icon,
      WarningOutlined: Icon,
    },
  };
});

vi.mock('../../utils/webRpc', async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    isWebRPCAbortError: () => false,
  };
});

const buildStatusResult = (drivers: Record<string, unknown>[]) => ({
  success: true,
  data: {
    downloadDir: 'D:/drivers',
    drivers,
  },
});

const buildClickHouseDriver = (overrides: Record<string, unknown> = {}) => ({
  type: 'clickhouse',
  name: 'ClickHouse',
  builtIn: false,
  pinnedVersion: '2.43.1',
  installedVersion: '2.43.1',
  runtimeAvailable: true,
  packageInstalled: true,
  connectable: true,
  agentRevision: 'src-installed',
  expectedRevision: 'src-expected',
  optionalUpdate: true,
  message: ' Cause: the driver agent component was updated.',
  ...overrides,
});

const mountModal = async () => {
  const { default: DriverManagerModal } = await import('./DriverManagerModal');
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<DriverManagerModal open onClose={vi.fn()} />);
  });
  return renderer;
};

const waitUntilContains = async (renderer: ReactTestRenderer, text: string, timeoutMs = 4000) => {
  const startedAt = Date.now();
  for (;;) {
    if (textContent(renderer.toJSON()).includes(text)) {
      return;
    }
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`content not found within ${timeoutMs}ms: ${text}
=== ACTUAL ===
${textContent(renderer.toJSON()).slice(0, 1500)}`);
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
  }
};

describe('DriverManagerModal optional update tier (issue #1326)', () => {
  beforeEach(() => {
    vi.resetModules();
    storeState.languagePreference = 'zh-CN';
    backendApp.GetDriverVersionList.mockResolvedValue({ success: true, data: { versions: [] } });
    backendApp.GetDriverVersionPackageSize.mockResolvedValue({ success: true, data: { packageSizeText: '' } });
    backendApp.CancelDriverPackageDownload.mockResolvedValue({ success: true, data: { task: null } });
    backendApp.InstallLocalDriverPackage.mockResolvedValue({ success: true });
    backendApp.ListDriverDownloadTasks.mockResolvedValue({ success: true, data: [] });
    backendApp.OpenDriverDownloadDirectory.mockResolvedValue({ success: true });
    backendApp.RemoveDriverPackage.mockResolvedValue({ success: true });
    backendApp.SelectDriverPackageDirectory.mockResolvedValue({ success: false, message: '已取消' });
    backendApp.SelectDriverPackageFile.mockResolvedValue({ success: false, message: '已取消' });
    backendApp.StartDriverPackageDownload.mockResolvedValue({ success: true, data: { task: null } });
    backendApp.CheckDriverNetworkStatus.mockResolvedValue({
      success: true,
      data: { reachable: true, summary: 'ok', downloadChainReachable: true, downloadRequiredHosts: [], recommendedProxy: false, proxyConfigured: false, proxyEnv: {}, checks: [], logPath: '' },
    });
    Object.values(backendApp).forEach((fn) => fn.mockClear());
    localStorageMap.clear();
    localStorageSpies.getItem.mockReset().mockReturnValue(null);
    localStorageSpies.setItem.mockReset();
    vi.stubGlobal('window', buildWindowStub());
  });

  it('renders optional update as weak hint with dismiss entry instead of needs update', { timeout: 30000 }, async () => {
    const { setCurrentLanguage } = await import('../i18n');
    setCurrentLanguage('zh-CN');
    backendApp.GetDriverStatusList.mockResolvedValue({
      success: true,
      data: { downloadDir: 'D:/drivers', drivers: [buildClickHouseDriver()] },
    });

    const renderer = await mountModal();
    await waitUntilContains(renderer, '驱动组件有更新（可选，不影响使用）');
    const content = textContent(renderer.toJSON());

    // 黄底提示 + 黄色「需重装」徽章 + 单驱「重装驱动」入口，替代原蓝色「可更新」
    expect(content).toContain('驱动组件有更新（可选，不影响使用）');
    expect(content).not.toContain('可更新');
    expect(content).toContain('不再提示此版本');
    expect(content).not.toContain('驱动组件有更新，建议重装以获得最新修复与兼容性改进');
    expect(findButton(renderer, '重装驱动')).toBeDefined();
    expect(findListDotToneCount(renderer, 'warning')).toBeGreaterThan(0);
  });

  it('needs update rows keep the reinstall prompt and never render the dismiss entry', { timeout: 30000 }, async () => {
    const { setCurrentLanguage } = await import('../i18n');
    setCurrentLanguage('zh-CN');
    backendApp.GetDriverStatusList.mockResolvedValue({
      success: true,
      data: {
        downloadDir: 'D:/drivers',
        drivers: [
          buildClickHouseDriver({
            needsUpdate: true,
            optionalUpdate: false,
            updateReason: '驱动组件有更新，建议重装以获得最新修复与兼容性改进；当前版本仍可正常使用。',
          }),
        ],
      },
    });

    const renderer = await mountModal();
    await waitUntilContains(renderer, '驱动组件有更新，建议重装以获得最新修复与兼容性改进');
    const content = textContent(renderer.toJSON());

    expect(content).toContain('驱动组件有更新，建议重装以获得最新修复与兼容性改进');
    expect(content).not.toContain('驱动组件有更新（可选，不影响使用）');
    expect(findButton(renderer, '不再提示此版本')).toBeUndefined();
  });

  it('dismiss click persists the expected revision and hides the weak hint', { timeout: 30000 }, async () => {
    const { setCurrentLanguage } = await import('../i18n');
    setCurrentLanguage('zh-CN');
    backendApp.GetDriverStatusList.mockResolvedValue({
      success: true,
      data: { downloadDir: 'D:/drivers', drivers: [buildClickHouseDriver()] },
    });

    const renderer = await mountModal();
    await waitUntilContains(renderer, '不再提示此版本');
    expect(textContent(renderer.toJSON())).toContain('不再提示此版本');

    const dismiss = findButton(renderer, '不再提示此版本');
    await act(async () => {
      dismiss.props.onClick();
    });

    expect(localStorageSpies.setItem).toHaveBeenCalledWith(
      OPTIONAL_UPDATE_DISMISS_KEY,
      JSON.stringify(['src-expected']),
    );
    expect(textContent(renderer.toJSON())).not.toContain('驱动组件有更新（可选，不影响使用）');
    expect(textContent(renderer.toJSON())).not.toContain('不再提示此版本');
    expect(textContent(renderer.toJSON())).toContain('纯 Go 驱动已启用，可直接连接');

    // dismiss 后退出需重装分组与批量范围，圆点回退绿色
    expect(findNeedsUpdateChipCount(renderer)).toBe('0');
    expect(findListDotToneCount(renderer, 'warning')).toBe(0);
    expect(findListDotToneCount(renderer, 'ok')).toBeGreaterThan(0);
    expect(findButton(renderer, '重装需更新驱动').props.disabled).toBe(true);
  });

  it('hides the weak hint when the dismissed revision matches on remount', { timeout: 30000 }, async () => {
    const { setCurrentLanguage } = await import('../i18n');
    setCurrentLanguage('zh-CN');
    localStorageMap.set(OPTIONAL_UPDATE_DISMISS_KEY, JSON.stringify(['src-expected']));


    backendApp.GetDriverStatusList.mockResolvedValue({
      success: true,
      data: { downloadDir: 'D:/drivers', drivers: [buildClickHouseDriver()] },
    });

    const renderer = await mountModal();
    expect(localStorageSpies.getItem).toHaveBeenCalledWith(OPTIONAL_UPDATE_DISMISS_KEY);
    expect(textContent(renderer.toJSON())).not.toContain('驱动组件有更新（可选，不影响使用）');
    expect(findButton(renderer, '不再提示此版本')).toBeUndefined();
  });

  it('counts optional update drivers in the needs-reinstall group and lists them under the filter', { timeout: 30000 }, async () => {
    const { setCurrentLanguage } = await import('../i18n');
    setCurrentLanguage('zh-CN');
    backendApp.GetDriverStatusList.mockResolvedValue({
      success: true,
      data: { downloadDir: 'D:/drivers', drivers: [buildClickHouseDriver()] },
    });

    const renderer = await mountModal();
    await waitUntilContains(renderer, '驱动组件有更新（可选，不影响使用）');

    expect(findNeedsUpdateChipCount(renderer)).toBe('1');

    const chip = renderer.root.findAll(
      (node) => node.type === 'button'
        && String(node.props.className || '').includes('driver-manager-filter-chip')
        && textContent(node).includes('需重装'),
    )[0];
    await act(async () => {
      chip.props.onClick();
    });

    // 筛选「需重装」后，可选更新驱动仍在列表中
    const names = renderer.root.findAll(
      (node) => node.type === 'span' && node.props.className === 'driver-manager-list-item-name',
    ).map((node) => textContent(node));
    expect(names).toEqual(['ClickHouse']);
  });

  it('enables the batch reinstall button and includes the optional update driver', { timeout: 30000 }, async () => {
    const { setCurrentLanguage } = await import('../i18n');
    setCurrentLanguage('zh-CN');
    backendApp.GetDriverStatusList.mockResolvedValue({
      success: true,
      data: { downloadDir: 'D:/drivers', drivers: [buildClickHouseDriver()] },
    });

    const renderer = await mountModal();
    await waitUntilContains(renderer, '驱动组件有更新（可选，不影响使用）');

    const batchButton = findButton(renderer, '重装需更新驱动');
    expect(batchButton).toBeDefined();
    expect(batchButton.props.disabled).toBeFalsy();

    await act(async () => {
      batchButton.props.onClick();
    });

    // activeConnections 为 0 时不弹确认框，直接对该驱动发起下载：批量范围已包含可选更新驱动
    const startedAt = Date.now();
    for (;;) {
      if (backendApp.StartDriverPackageDownload.mock.calls.length > 0) {
        break;
      }
      if (Date.now() - startedAt > 4000) {
        throw new Error('StartDriverPackageDownload was not called for the optional update driver');
      }
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      });
    }
    expect(JSON.stringify(backendApp.StartDriverPackageDownload.mock.calls)).toContain('clickhouse');
  });
});
