import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  service: {
    apply: vi.fn(), clear: vi.fn(), get: vi.fn(), open: vi.fn(), optimize: vi.fn(), select: vi.fn(),
  },
  confirm: vi.fn(),
  messages: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
  setState: vi.fn(),
  translate: (key: string, params?: Record<string, unknown>) => (
    params ? `${key}:${JSON.stringify(params)}` : key
  ),
}));

vi.mock('@ant-design/icons', () => ({
  CheckOutlined: () => null,
  ClearOutlined: () => null,
  DeleteOutlined: () => null,
  FolderOpenOutlined: () => null,
  InfoCircleOutlined: () => null,
  RobotOutlined: () => null,
  SafetyCertificateOutlined: () => null,
}));
vi.mock('antd', () => ({
  Alert: (props: any) => <div data-alert={props.type}>{props.message}</div>,
  Button: ({ children, loading: _loading, ...props }: any) => <button {...props}>{children}</button>,
  Input: (props: any) => <input {...props} />,
  Modal: { confirm: mocks.confirm, useModal: () => [{ confirm: mocks.confirm }, null] },
  Spin: () => <span data-spin="true" />,
  message: mocks.messages,
}));
vi.mock('../../../wailsjs/go/aiservice/Service', () => ({
  AIApplyAgentDataDirectory: mocks.service.apply,
  AIClearAgentData: mocks.service.clear,
  AIGetAgentDataDirectoryInfo: mocks.service.get,
  AIOpenAgentDataDirectory: mocks.service.open,
  AIOptimizeAgentData: mocks.service.optimize,
  AISelectAgentDataDirectory: mocks.service.select,
}));
vi.mock('../../i18n/provider', () => ({
  useI18n: () => ({ language: 'en-US', t: mocks.translate }),
}));
vi.mock('../../store', () => ({ useStore: { setState: mocks.setState } }));

import AgentDataSettingsPanel, { formatAgentDataBytes } from './AgentDataSettingsPanel';

const stats = {
  fileBytes: 2048,
  walBytes: 1024,
  allocatedBytes: 2048,
  freeBytes: 512,
  sessionCount: 3,
  runCount: 4,
  snapshotCount: 5,
  activeRunCount: 0,
};
const info = {
  directory: '/data/current',
  defaultDirectory: '/data/default',
  source: 'custom',
  restartRequired: false,
  stats,
};

const flush = async () => {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
};

describe('AgentDataSettingsPanel', () => {
  let renderer: ReactTestRenderer | undefined;

  beforeEach(() => {
    vi.resetAllMocks();
    mocks.service.get.mockResolvedValue(info);
    mocks.service.select.mockResolvedValue('/data/selected');
    mocks.service.apply.mockResolvedValue({ ...info, directory: '/data/selected', restartRequired: true });
    mocks.service.optimize.mockResolvedValue({
      info,
      maintenance: { before: stats, after: { ...stats, fileBytes: 1024 }, removedSnapshots: 4, removedSessions: 0 },
    });
    mocks.service.clear.mockResolvedValue({
      info: { ...info, stats: { ...stats, sessionCount: 0, runCount: 0, snapshotCount: 0 } },
      maintenance: { before: stats, after: { ...stats, sessionCount: 0 }, removedSnapshots: 5, removedSessions: 3 },
    });
    vi.stubGlobal('window', { dispatchEvent: vi.fn() });
    vi.stubGlobal('CustomEvent', class { constructor(public type: string) {} });
  });

  afterEach(async () => {
    await act(async () => { renderer?.unmount(); });
    renderer = undefined;
    vi.unstubAllGlobals();
  });

  it('shows ledger usage and migrates the selected directory', async () => {
    await act(async () => { renderer = create(<AgentDataSettingsPanel />); });
    await flush();
    expect(mocks.service.get).toHaveBeenCalledTimes(1);
    expect(renderer!.root.findAll((node) => node.children.includes('/data/current'))).not.toHaveLength(0);
    expect(renderer!.root.findAll((node) => node.children.includes('3 KB'))).not.toHaveLength(0);
    expect(renderer!.root.findAllByProps({ 'data-agent-data-usage-summary': 'true' })).toHaveLength(1);
    expect(renderer!.root.findAllByProps({ 'data-agent-data-usage-chart': 'true' })).toHaveLength(1);
    expect(renderer!.root.findAllByProps({ 'data-agent-data-section': 'location' })).toHaveLength(1);
    expect(renderer!.root.findAllByProps({ 'data-agent-data-section': 'maintenance' })).toHaveLength(1);

    const select = renderer!.root.findByProps({ 'data-agent-data-action': 'select' });
    await act(async () => { select.props.onClick(); await Promise.resolve(); });
    const migrate = renderer!.root.findByProps({ 'data-agent-data-action': 'migrate' });
    await act(async () => { migrate.props.onClick(); await Promise.resolve(); await Promise.resolve(); });
    expect(mocks.service.apply).toHaveBeenCalledWith('/data/selected', true);
  });

  it('requires confirmation, clears the durable data, and resets the UI projection', async () => {
    await act(async () => { renderer = create(<AgentDataSettingsPanel />); });
    await flush();
    const clear = renderer!.root.findByProps({ 'data-agent-data-action': 'clear' });
    act(() => clear.props.onClick());
    expect(mocks.confirm).toHaveBeenCalledTimes(1);
    const options = mocks.confirm.mock.calls[0][0];
    await act(async () => { await options.onOk(); });
    expect(mocks.service.clear).toHaveBeenCalledTimes(1);
    expect(mocks.setState).toHaveBeenCalledWith({
      aiChatSessions: [], aiChatHistory: {}, aiActiveSessionId: null,
    });
    expect(window.dispatchEvent).toHaveBeenCalledTimes(1);
  });

  it('formats byte counts for the settings summary', () => {
    expect(formatAgentDataBytes(0)).toBe('0 B');
    expect(formatAgentDataBytes(1024)).toBe('1 KB');
    expect(formatAgentDataBytes(62 * 1024 ** 3)).toBe('62 GB');
  });
});
