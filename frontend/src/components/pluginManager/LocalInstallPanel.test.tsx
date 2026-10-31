import React from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
const api = vi.hoisted(() => ({ inspect: vi.fn(), install: vi.fn(), replace: vi.fn(), remoteInspect: vi.fn(), remoteInstall: vi.fn(), remoteCancelInspection: vi.fn() }));
const picker = vi.hoisted(() => ({ pickPluginPackageFile: vi.fn(), pickPluginPackageDirectory: vi.fn() }));
const runtime = vi.hoisted(() => ({ isWebRuntime: vi.fn(() => false) }));
const wailsRuntime = vi.hoisted(() => ({ EventsOn: vi.fn(() => () => {}) }));
vi.mock('../../plugins/api', () => ({ pluginAPI: api }));
vi.mock('./pluginPackagePicker', () => picker);
vi.mock('../../utils/browserFileTransfer', () => runtime);
vi.mock('../../../wailsjs/runtime', () => wailsRuntime);
vi.mock('../../i18n/provider', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('antd', () => {
  const element = (name: string) => (props: React.HTMLAttributes<HTMLElement>) => React.createElement('div', { ...props, 'data-component': name });
  return { Alert: element('alert'), Button: element('button'), Input: element('input'), Typography: { Text: element('text') } };
});
vi.mock('./PluginInstallPreview', () => ({
  PluginInstallPreview: (props: Record<string, unknown>) => React.createElement('div', { 'data-component': 'preview', ...props }),
}));
import { LocalInstallPanel } from './LocalInstallPanel';
import { consumePendingPluginInstall, dispatchPluginInstallForTest } from './pluginInstallDeeplink';
const inspection = {
  manifest: { schemaVersion: 1, apiVersion: 1, id: 'test.hello', name: 'Hello', version: '1.0.0', permissions: [] },
  digest: 'c'.repeat(64), sourcePath: '/tmp/plugin.zip', sizeBytes: 10,
};
async function inspectPath(view: ReturnType<typeof create>) {
  await act(async () => { view.root.findByProps({ 'data-component': 'input' }).props.onChange({ target: { value: '/tmp/plugin.zip' } }); });
  const inspectButton = view.root.findAllByProps({ 'data-component': 'button' }).find((node) => node.children.includes('plugin.install.inspect'));
  await act(async () => { await inspectButton!.props.onClick(); });
  return view.root.findByProps({ 'data-component': 'preview' });
}
describe('local install chooses replace for an installed plugin', () => {
  afterEach(() => { vi.clearAllMocks(); runtime.isWebRuntime.mockReturnValue(false); });
  it('installs a new plugin and replaces an installed one', async () => {
    api.inspect.mockResolvedValue(inspection);
    api.install.mockResolvedValue({});
    api.replace.mockResolvedValue({});
    const fresh = create(<LocalInstallPanel allowed onInstalled={vi.fn()} installedIds={new Set<string>()} />);
    let preview = await inspectPath(fresh);
    expect(preview.props.replace).toBe(false);
    await act(async () => { await preview.props.onInstall(); });
    expect(api.install).toHaveBeenCalledWith('/tmp/plugin.zip', inspection.digest, true);
    expect(api.replace).not.toHaveBeenCalled();
    fresh.unmount();
    api.install.mockClear();
    const installed = create(<LocalInstallPanel allowed onInstalled={vi.fn()} installedIds={new Set(['test.hello'])} />);
    preview = await inspectPath(installed);
    expect(preview.props.replace).toBe(true);
    await act(async () => { await preview.props.onInstall(); });
    expect(api.replace).toHaveBeenCalledWith('/tmp/plugin.zip', inspection.digest, true);
    expect(api.install).not.toHaveBeenCalled();
    installed.unmount();
  });
});

const buttonByText = (view: ReturnType<typeof create>, text: string) => (
  view.root.findAllByProps({ 'data-component': 'button' }).find((node) => node.children.includes(text))
);

describe('local install package picker', () => {  afterEach(() => { vi.clearAllMocks(); runtime.isWebRuntime.mockReturnValue(false); });

  it('fills the selected path and inspects it immediately', async () => {
    api.inspect.mockResolvedValue(inspection);
    picker.pickPluginPackageFile.mockResolvedValue({ status: 'selected', path: '/tmp/picked.zip' });
    const view = create(<LocalInstallPanel allowed onInstalled={vi.fn()} />);
    const chooseFile = buttonByText(view, 'plugin.install.select_file');
    expect(chooseFile).toBeTruthy();
    await act(async () => { await chooseFile!.props.onClick(); });
    expect(picker.pickPluginPackageFile).toHaveBeenCalledWith('');
    expect(view.root.findByProps({ 'data-component': 'input' }).props.value).toBe('/tmp/picked.zip');
    expect(api.inspect).toHaveBeenCalledWith('/tmp/picked.zip');
    expect(view.root.findByProps({ 'data-component': 'preview' }).props.inspection).toBe(inspection);
    view.unmount();
  });

  it('treats a canceled picker as a no-op', async () => {
    picker.pickPluginPackageDirectory.mockResolvedValue({ status: 'canceled' });
    const view = create(<LocalInstallPanel allowed onInstalled={vi.fn()} />);
    await act(async () => { await buttonByText(view, 'plugin.install.select_directory')!.props.onClick(); });
    expect(api.inspect).not.toHaveBeenCalled();
    expect(view.root.findAllByProps({ 'data-component': 'alert' })).toHaveLength(0);
    view.unmount();
  });

  it('shows a localized hint when the picker cannot open', async () => {
    picker.pickPluginPackageFile.mockResolvedValue({ status: 'failed' });
    const view = create(<LocalInstallPanel allowed onInstalled={vi.fn()} />);
    await act(async () => { await buttonByText(view, 'plugin.install.select_file')!.props.onClick(); });
    const alert = view.root.findAllByProps({ 'data-component': 'alert' }).find((node) => node.props.message === 'plugin.install.select_failed');
    expect(alert).toBeTruthy();
    view.unmount();
  });

  it('hides native pickers in the web runtime', () => {
    runtime.isWebRuntime.mockReturnValue(true);
    const view = create(<LocalInstallPanel allowed onInstalled={vi.fn()} />);
    expect(buttonByText(view, 'plugin.install.select_file')).toBeUndefined();
    expect(buttonByText(view, 'plugin.install.select_directory')).toBeUndefined();
    expect(buttonByText(view, 'plugin.install.inspect')).toBeTruthy();
    view.unmount();
  });
});

const remoteInspection = {
  inspection: { ...inspection, sourcePath: 'remote:github:owner/repo' },
  source: { kind: 'github', spec: 'github:owner/repo', url: 'https://github.com/owner/repo/releases/download/v1/gonavi-demo.zip', name: 'gonavi-demo.zip', version: 'v1.0.0' },
  artifactDigest: 'a'.repeat(64),
  approvalToken: 'token-1',
  expiresAt: '2026-01-01T00:00:00Z',
};

describe('remote install via github:/npm spec', () => {
  afterEach(() => { vi.clearAllMocks(); runtime.isWebRuntime.mockReturnValue(false); });

  async function inspectSpec(spec: string) {
    const view = create(<LocalInstallPanel allowed onInstalled={vi.fn()} installedIds={new Set<string>(['test.hello'])} />);
    await act(async () => { view.root.findByProps({ 'data-component': 'input' }).props.onChange({ target: { value: spec } }); });
    const inspectButton = view.root.findAllByProps({ 'data-component': 'button' }).find((node) => node.children.includes('plugin.install.inspect'));
    await act(async () => { await inspectButton!.props.onClick(); });
    return view;
  }

  it('routes github:/npm specs to the remote inspector and installs with the approval token', async () => {
    api.remoteInspect.mockResolvedValue(remoteInspection);
    api.remoteInstall.mockResolvedValue({});
    const view = await inspectSpec('github:owner/repo');
    expect(api.remoteInspect).toHaveBeenCalledWith('github:owner/repo');
    expect(api.inspect).not.toHaveBeenCalled();
    const preview = view.root.findByProps({ 'data-component': 'preview' });
    expect(preview.props.inspection.sourcePath).toBe('remote:github:owner/repo');
    await act(async () => { await preview.props.onInstall(); });
    expect(api.remoteInstall).toHaveBeenCalledWith(remoteInspection.inspection.digest, true, 'token-1');
    expect(api.install).not.toHaveBeenCalled();
    expect(api.replace).not.toHaveBeenCalled();
    view.unmount();
  });

  it('cancels the outstanding inspection on re-inspect and unmount', async () => {
    api.remoteInspect.mockResolvedValue(remoteInspection);
    api.inspect.mockResolvedValue(inspection);
    api.remoteCancelInspection.mockResolvedValue({});
    const view = await inspectSpec('@scope/pkg');
    expect(api.remoteInspect).toHaveBeenCalledWith('@scope/pkg');
    // 本地重查：旧令牌被释放。
    await inspectPathOnView(view, 'C:\\x.zip');
    expect(api.remoteCancelInspection).toHaveBeenCalledTimes(1);
    // 再次远程检查后卸载：卸载释放当前令牌（passive effect 清理是异步的，先冲刷再断言）。
    await inspectPathOnView(view, 'github:owner/repo');
    view.unmount();
    await act(async () => {});
    expect(api.remoteCancelInspection).toHaveBeenCalledTimes(2);
  });
});

async function inspectPathOnView(view: ReturnType<typeof create>, value: string) {
  await act(async () => { view.root.findByProps({ 'data-component': 'input' }).props.onChange({ target: { value } }); });
  const inspectButton = view.root.findAllByProps({ 'data-component': 'button' }).find((node) => node.children.includes('plugin.install.inspect'));
  await act(async () => { await inspectButton!.props.onClick(); });
}

describe('plugin install deep links from the market website', () => {
  afterEach(() => {
    vi.clearAllMocks();
    runtime.isWebRuntime.mockReturnValue(false);
    wailsRuntime.EventsOn.mockClear();
    consumePendingPluginInstall();
  });

  it('prefills and auto-inspects a spec link, treating repeats as one request', async () => {
    api.remoteInspect.mockResolvedValue(remoteInspection);
    const view = create(<LocalInstallPanel allowed onInstalled={vi.fn()} />);
    expect(dispatchPluginInstallForTest({ spec: 'github:market/repo', id: 'com.gonavi.x' })).toBe(true);
    await act(async () => {});
    expect(view.root.findByProps({ 'data-component': 'input' }).props.value).toBe('github:market/repo');
    expect(api.remoteInspect).toHaveBeenCalledTimes(1);
    expect(api.remoteInspect).toHaveBeenCalledWith('github:market/repo');
    // 桌面端对同一链接会短促重发，第二次必须被忽略。
    dispatchPluginInstallForTest({ spec: 'github:market/repo', id: 'com.gonavi.x' });
    await act(async () => {});
    expect(api.remoteInspect).toHaveBeenCalledTimes(1);
    view.unmount();
    await act(async () => {});
  });

  it('prefills only (no auto-inspect) when the link carries just a plugin id', async () => {
    const view = create(<LocalInstallPanel allowed onInstalled={vi.fn()} />);
    expect(dispatchPluginInstallForTest({ spec: '', id: 'com.gonavi.sql-insights' })).toBe(true);
    await act(async () => {});
    expect(view.root.findByProps({ 'data-component': 'input' }).props.value).toBe('com.gonavi.sql-insights');
    expect(api.remoteInspect).not.toHaveBeenCalled();
    expect(api.inspect).not.toHaveBeenCalled();
    view.unmount();
    await act(async () => {});
  });

  it('consumes a link that arrived before the panel mounted', async () => {
    api.remoteInspect.mockResolvedValue(remoteInspection);
    expect(dispatchPluginInstallForTest({ spec: 'github:market/repo' })).toBe(true);
    const view = create(<LocalInstallPanel allowed onInstalled={vi.fn()} />);
    await act(async () => {});
    expect(view.root.findByProps({ 'data-component': 'input' }).props.value).toBe('github:market/repo');
    expect(api.remoteInspect).toHaveBeenCalledTimes(1);
    view.unmount();
    await act(async () => {});
  });

  it('ignores deep links while management is not allowed', () => {
    const view = create(<LocalInstallPanel allowed={false} onInstalled={vi.fn()} />);
    expect(dispatchPluginInstallForTest({ spec: 'github:market/repo' })).toBe(true);
    expect(view.root.findByProps({ 'data-component': 'input' }).props.value).toBe('');
    expect(api.remoteInspect).not.toHaveBeenCalled();
    view.unmount();
  });

  it('drops malformed payloads without touching the panel', () => {
    const view = create(<LocalInstallPanel allowed onInstalled={vi.fn()} />);
    expect(dispatchPluginInstallForTest(null)).toBe(false);
    expect(dispatchPluginInstallForTest({})).toBe(false);
    expect(dispatchPluginInstallForTest({ spec: '   ' })).toBe(false);
    expect(view.root.findByProps({ 'data-component': 'input' }).props.value).toBe('');
    expect(api.remoteInspect).not.toHaveBeenCalled();
    view.unmount();
  });
});
