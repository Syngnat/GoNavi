import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import DriverManagerModal from './DriverManagerModal';
import { t } from '../i18n';

const storeState = vi.hoisted(() => ({
  theme: 'light',
  appearance: {
    enabled: true,
    opacity: 1,
    blur: 0,
    uiVersion: 'legacy',
  },
}));

const backendApp = vi.hoisted(() => ({
  CheckDriverNetworkStatus: vi.fn(),
  DownloadDriverPackage: vi.fn(),
  GetDriverVersionList: vi.fn(),
  GetDriverVersionPackageSize: vi.fn(),
  GetDriverStatusList: vi.fn(),
  InstallLocalDriverPackage: vi.fn(),
  OpenDriverDownloadDirectory: vi.fn(),
  RemoveDriverPackage: vi.fn(),
  SelectDriverPackageDirectory: vi.fn(),
  SelectDriverPackageFile: vi.fn(),
}));

const runtimeApi = vi.hoisted(() => ({
  EventsOn: vi.fn(() => vi.fn()),
}));

const messageApi = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
}));

vi.mock('../store', () => ({
  useStore: (selector: (state: typeof storeState) => any) => selector(storeState),
}));

vi.mock('../../wailsjs/go/app/App', () => backendApp);
vi.mock('../../wailsjs/runtime/runtime', () => runtimeApi);

vi.mock('@ant-design/icons', () => {
  const Icon = () => <span />;
  return {
    DeleteOutlined: Icon,
    DownloadOutlined: Icon,
    FileSearchOutlined: Icon,
    FolderOpenOutlined: Icon,
    InfoCircleFilled: Icon,
    ReloadOutlined: Icon,
  };
});

vi.mock('antd', () => {
  const Button: any = ({ children, disabled, loading, onClick, ...rest }: any) => (
    <button type="button" disabled={disabled || loading} onClick={onClick} {...rest}>
      {children}
    </button>
  );

  const Input: any = ({ value, onChange, placeholder }: any) => (
    <input value={value} onChange={onChange} placeholder={placeholder} />
  );
  Input.Search = ({ value, onChange, placeholder }: any) => (
    <input value={value} onChange={onChange} placeholder={placeholder} />
  );

  const Select = ({ value, options, disabled, loading, placeholder, onOpenChange, onChange }: any) => (
    <select
      value={value}
      disabled={disabled}
      data-select-loading={String(loading)}
      data-select-placeholder={placeholder}
      onFocus={() => onOpenChange?.(true)}
      onChange={(event) => onChange?.(event.target.value)}
    >
      <option value="">{placeholder || ''}</option>
      {(options || []).flatMap((item: any) => {
        if (Array.isArray(item?.options)) {
          return item.options.map((grouped: any) => (
            <option key={grouped.value} value={grouped.value}>
              {String(grouped.label || grouped.value)}
            </option>
          ));
        }
        return (
          <option key={item.value} value={item.value}>
            {String(item.label || item.value)}
          </option>
        );
      })}
    </select>
  );
  const Progress = (props: any) => <div data-progress="true" {...props} />;
  const Tag = ({ children }: any) => <span>{children}</span>;
  const Switch = ({ checked, onChange, disabled }: any) => (
    <button type="button" disabled={disabled} data-switch-checked={String(checked)} onClick={() => onChange?.(!checked)}>
      switch
    </button>
  );
  const Space = ({ children, ...rest }: any) => <div {...rest}>{children}</div>;
  const Text = ({ children }: any) => <span>{children}</span>;
  const Paragraph = ({ children }: any) => <div>{children}</div>;
  const Typography = { Paragraph, Text };
  const Alert = ({ children, message, description }: any) => <div>{children}{message}{description}</div>;
  const Empty: any = ({ description }: any) => <div>{description}</div>;
  Empty.PRESENTED_IMAGE_SIMPLE = null;
  const Collapse = ({ items }: any) => (
    <div>{items?.map((item: any) => <div key={item.key}>{item.label}{item.children}</div>)}</div>
  );
  const Modal: any = ({ children, open, footer, title }: any) => (open ? (
    <section data-modal-title={title}>
      {children}
      <div>{footer}</div>
    </section>
  ) : null);
  Modal.confirm = vi.fn();

  return {
    Alert,
    Button,
    Collapse,
    Empty,
    Input,
    Modal,
    Progress,
    Select,
    Space,
    Switch,
    Tag,
    Typography,
    message: messageApi,
  };
});

const flushPromises = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

const textContent = (node: any): string =>
  (node.children || [])
    .map((item: any) => (typeof item === 'string' ? item : textContent(item)))
    .join('');

const findButton = (renderer: ReactTestRenderer, text: string) =>
  renderer.root.findAll((node) => node.type === 'button' && textContent(node).includes(text))[0];

describe('DriverManagerModal toolbar actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    backendApp.GetDriverStatusList.mockResolvedValue({
      success: true,
      data: {
        downloadDir: 'D:/drivers',
        drivers: [
          {
            type: 'duckdb',
            name: 'DuckDB',
            builtIn: false,
            pinnedVersion: '2.5.6',
            runtimeAvailable: false,
            packageInstalled: false,
            connectable: false,
            defaultDownloadUrl: 'builtin://activate/duckdb',
            message: '未启用',
          },
        ],
      },
    });
    backendApp.CheckDriverNetworkStatus.mockResolvedValue({
      success: true,
      data: {
        reachable: true,
        summary: 'ok',
        recommendedProxy: false,
        proxyConfigured: false,
        checks: [],
      },
    });
    backendApp.GetDriverVersionList.mockResolvedValue({
      success: true,
      data: {
        versions: [{ version: '2.5.6', downloadUrl: 'builtin://activate/duckdb', recommended: true }],
      },
    });
    backendApp.DownloadDriverPackage.mockImplementation(() => new Promise(() => {}));
    backendApp.OpenDriverDownloadDirectory.mockResolvedValue({ success: true });
    backendApp.SelectDriverPackageDirectory.mockResolvedValue({ success: true, data: { path: 'D:/drivers/import' } });
  });

  it('keeps directory tools enabled while a single driver install is running', async () => {
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<DriverManagerModal open onClose={vi.fn()} />);
    });
    await flushPromises();

    const installButton = findButton(renderer!, t('driver.modal.card.action.install'));
    const openDirButtonBefore = findButton(renderer!, t('driver.modal.toolbar.openDirectory'));
    const importDirButtonBefore = findButton(renderer!, t('driver.modal.toolbar.importDirectory'));
    const installAllButtonBefore = findButton(renderer!, t('driver.modal.toolbar.installAll'));

    expect(openDirButtonBefore.props.disabled).toBeFalsy();
    expect(importDirButtonBefore.props.disabled).toBeFalsy();
    expect(installAllButtonBefore.props.disabled).toBeFalsy();

    await act(async () => {
      installButton.props.onClick();
      await Promise.resolve();
    });

    const openDirButtonAfter = findButton(renderer!, t('driver.modal.toolbar.openDirectory'));
    const importDirButtonAfter = findButton(renderer!, t('driver.modal.toolbar.importDirectory'));
    const installAllButtonAfter = findButton(renderer!, t('driver.modal.toolbar.installAll'));

    expect(openDirButtonAfter.props.disabled).toBeFalsy();
    expect(importDirButtonAfter.props.disabled).toBeFalsy();
    expect(installAllButtonAfter.props.disabled).toBe(true);
  });

  it('uses the compact flat driver list only inside the embedded settings view', async () => {
    let embeddedRenderer: ReactTestRenderer;
    await act(async () => {
      embeddedRenderer = create(<DriverManagerModal open embedded onClose={vi.fn()} />);
    });
    await flushPromises();

    const embeddedShell = embeddedRenderer!.root.findByProps({ className: 'driver-manager-shell is-embedded' });
    const embeddedLayout = embeddedRenderer!.root.findByProps({ className: 'driver-manager-embedded-layout' });
    const embeddedCard = embeddedShell.findByProps({ className: 'driver-manager-card' });
    expect(embeddedLayout.children[0]).toBe(embeddedShell);
    expect(embeddedLayout.findByProps({ className: 'driver-manager-footer-actions' })).toBeTruthy();
    expect(embeddedCard.props.style).toMatchObject({
      border: 'none',
      background: 'transparent',
    });
    expect(findButton(embeddedRenderer!, t('driver.modal.card.action.install')).props.size).toBe('small');
    expect(embeddedRenderer!.root.findByProps({ 'data-progress': 'true' }).props.className).toBe('driver-manager-progress');

    let modalRenderer: ReactTestRenderer;
    await act(async () => {
      modalRenderer = create(<DriverManagerModal open onClose={vi.fn()} />);
    });
    await flushPromises();

    const modalShell = modalRenderer!.root.findByProps({ className: 'driver-manager-shell' });
    const modalCard = modalShell.findByProps({ className: 'driver-manager-card' });
    expect(modalCard.props.style.background).not.toBe('transparent');
    expect(findButton(modalRenderer!, t('driver.modal.card.action.install')).props.size).toBeUndefined();
  });

  it('shows the driver display name without repeating its internal type', async () => {
    for (const embedded of [false, true]) {
      let renderer: ReactTestRenderer;
      await act(async () => {
        renderer = create(<DriverManagerModal open embedded={embedded} onClose={vi.fn()} />);
      });
      await flushPromises();

      const titleRow = renderer!.root.findByProps({ className: 'driver-manager-title-row' });
      const titleText = textContent(titleRow);
      expect(titleText).toContain('DuckDB');
      expect(titleText).not.toContain('duckdb');
    }
  });

  it('releases install action when the driver install watchdog expires', async () => {
    vi.useFakeTimers();
    try {
      let renderer: ReactTestRenderer;
      await act(async () => {
        renderer = create(<DriverManagerModal open onClose={vi.fn()} />);
      });
      await flushPromises();

      const installButton = findButton(renderer!, t('driver.modal.card.action.install'));
      await act(async () => {
        installButton.props.onClick();
        await Promise.resolve();
      });

      expect(findButton(renderer!, t('driver.modal.card.action.install')).props.disabled).toBe(true);

      await act(async () => {
        vi.advanceTimersByTime(12 * 60 * 1000);
        await Promise.resolve();
      });

      expect(findButton(renderer!, t('driver.modal.card.action.install')).props.disabled).toBeFalsy();
      expect(messageApi.error).toHaveBeenCalledWith(
        t('driver_manager.message.install_watchdog_timeout', { name: 'DuckDB', minutes: 12 }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('reinstalls stale MongoDB v2 drivers with the v1 compatibility default', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      vi.setSystemTime(new Date(Date.now() + 2 * 60 * 1000));
      backendApp.GetDriverStatusList.mockResolvedValue({
        success: true,
        data: {
          downloadDir: 'D:/drivers',
          drivers: [
            {
              type: 'mongodb',
              name: 'MongoDB',
              builtIn: false,
              pinnedVersion: '1.17.9',
              installedVersion: '2.5.0',
              runtimeAvailable: true,
              packageInstalled: true,
              connectable: true,
              needsUpdate: true,
              defaultDownloadUrl: 'builtin://activate/mongodb',
              message: '建议重装',
            },
          ],
        },
      });
      backendApp.GetDriverVersionList.mockResolvedValue({
        success: true,
        data: {
          versions: [
            { version: '2.5.0', downloadUrl: 'builtin://activate/mongodb?version=2.5.0' },
            { version: '1.17.9', downloadUrl: 'builtin://activate/mongodb', recommended: true },
          ],
        },
      });
      backendApp.DownloadDriverPackage.mockResolvedValue({ success: true });

      let renderer: ReactTestRenderer;
      await act(async () => {
        renderer = create(<DriverManagerModal open onClose={vi.fn()} />);
      });
      await flushPromises();

      const reinstallButton = findButton(renderer!, t('driver.modal.card.action.reinstall'));
      await act(async () => {
        await reinstallButton.props.onClick();
      });

      expect(backendApp.DownloadDriverPackage).toHaveBeenCalledWith(
        'mongodb',
        '1.17.9',
        'builtin://activate/mongodb',
        'D:/drivers',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('allows switching installed TDengine drivers to a historical compatible version', async () => {
    backendApp.GetDriverStatusList.mockResolvedValue({
      success: true,
      data: {
        downloadDir: 'D:/drivers',
        drivers: [
          {
            type: 'tdengine',
            name: 'TDengine',
            builtIn: false,
            pinnedVersion: '3.7.8',
            installedVersion: '3.7.8',
            runtimeAvailable: true,
            packageInstalled: true,
            connectable: true,
            defaultDownloadUrl: 'builtin://activate/tdengine',
            message: '已启用',
          },
        ],
      },
    });
    backendApp.GetDriverVersionList.mockResolvedValue({
      success: true,
      data: {
        versions: [
          { version: '3.7.8', downloadUrl: 'builtin://activate/tdengine', recommended: true },
          { version: '3.3.1', downloadUrl: 'builtin://activate/tdengine?channel=history&version=3.3.1' },
        ],
      },
    });
    backendApp.DownloadDriverPackage.mockResolvedValue({ success: true });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<DriverManagerModal open onClose={vi.fn()} />);
    });
    await flushPromises();

    const refreshButton = findButton(renderer!, t('driver.modal.footer.refresh'));
    await act(async () => {
      await refreshButton.props.onClick();
    });
    await flushPromises();

    const versionSelect = renderer!.root.findByType('select');
    await act(async () => {
      versionSelect.props.onFocus();
    });
    await flushPromises();
    expect(backendApp.GetDriverVersionList).toHaveBeenCalledWith('tdengine', '');

    const reloadedVersionSelect = renderer!.root.findByType('select');
    await act(async () => {
      reloadedVersionSelect.props.onChange({ target: { value: '3.3.1@@builtin://activate/tdengine?channel=history&version=3.3.1' } });
    });
    await flushPromises();

    const switchButtons = renderer!.root.findAll((node) => node.type === 'button' && textContent(node).includes(t('driver_manager.action.switch_version')));
    expect(switchButtons).toHaveLength(1);
    const switchButton = switchButtons[0];
    await act(async () => {
      await switchButton.props.onClick();
    });

    expect(backendApp.DownloadDriverPackage).toHaveBeenCalledWith(
      'tdengine',
      '3.3.1',
      'builtin://activate/tdengine?channel=history&version=3.3.1',
      'D:/drivers',
    );
  });
});
