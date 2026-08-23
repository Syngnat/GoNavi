import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAIMCPClientInstaller } from './useAIMCPClientInstaller';

const messageApi = {
  error: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
};
const copyTextToClipboard = vi.fn(async () => undefined);
const onAfterInstall = vi.fn();
const onBeforeInstall = vi.fn(async () => undefined);
const onConfigChanged = vi.fn();

const openCodeStatus = {
  client: 'opencode',
  displayName: 'OpenCode',
  installMode: 'auto' as const,
  installed: false,
  matchesCurrent: false,
  clientDetected: true,
  clientCommand: 'opencode',
  clientPath: '/usr/local/bin/opencode',
  message: 'No OpenCode user-level GoNavi MCP configuration was detected',
  configPath: '/Users/mock/.config/opencode/opencode.json',
  command: '/Applications/GoNavi.app/Contents/MacOS/GoNavi',
  args: ['mcp-server'],
};

const additionalAutoMCPClients = [
  ['zcode', 'ZCode', 'AIInstallZCodeMCP'],
  ['deepseek-harness', 'DeepSeek Harness', 'AIInstallDeepSeekHarnessMCP'],
  ['kimi', 'Kimi Code', 'AIInstallKimiMCP'],
  ['grok-build', 'Grok Build', 'AIInstallGrokBuildMCP'],
] as const;

const additionalAutoMCPClientStatuses = [
  {
    client: 'zcode',
    displayName: 'ZCode',
    installMode: 'auto' as const,
    installed: false,
    matchesCurrent: false,
    clientDetected: true,
    clientCommand: 'zcode',
    message: 'No ZCode user-level GoNavi MCP configuration was detected',
  },
  {
    client: 'deepseek-harness',
    displayName: 'DeepSeek Harness',
    installMode: 'auto' as const,
    installed: false,
    matchesCurrent: false,
    clientDetected: true,
    clientCommand: 'dsh',
    message: 'No DeepSeek Harness user-level GoNavi MCP configuration was detected',
  },
  {
    client: 'kimi',
    displayName: 'Kimi Code',
    installMode: 'auto' as const,
    installed: false,
    matchesCurrent: false,
    clientDetected: true,
    clientCommand: 'kimi',
    message: 'No Kimi Code user-level GoNavi MCP configuration was detected',
  },
  {
    client: 'grok-build',
    displayName: 'Grok Build',
    installMode: 'auto' as const,
    installed: false,
    matchesCurrent: false,
    clientDetected: true,
    clientCommand: 'grok',
    message: 'No Grok Build user-level GoNavi MCP configuration was detected',
  },
];

const translate = (
  key: string,
  params?: Record<string, string | number | boolean | null | undefined>,
) => {
  if (key === 'ai_chat.mcp_client.install.message.opencode_not_supported') {
    return 'T: OpenCode auto install is unavailable';
  }
  if (key === 'ai_chat.mcp_client.install.message.install_success') {
    return `T: installed ${params?.label}`;
  }
  return key;
};

let latestHook: ReturnType<typeof useAIMCPClientInstaller> | undefined;
let renderer: ReactTestRenderer | undefined;

const renderInstaller = (service: Record<string, unknown>) => {
  const Harness = () => {
    latestHook = useAIMCPClientInstaller({
      copyTextToClipboard,
      messageApi,
      onAfterInstall,
      onBeforeInstall,
      onConfigChanged,
      resolveAIService: async () => service,
      translate,
    });
    return null;
  };

  act(() => {
    renderer = create(<Harness />);
  });
};

describe('useAIMCPClientInstaller', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    latestHook = undefined;
    renderer = undefined;
  });

  afterEach(() => {
    act(() => {
      renderer?.unmount();
    });
  });

  it('routes an OpenCode selection only to the OpenCode installer', async () => {
    const service = {
      AIGetMCPClientInstallStatuses: vi.fn(async () => [openCodeStatus]),
      AIInstallClaudeCodeMCP: vi.fn(async () => ({})),
      AIInstallCodexMCP: vi.fn(async () => ({})),
      AIInstallOpenCodeMCP: vi.fn(async () => ({ client: 'opencode', success: true })),
    };
    renderInstaller(service);

    await act(async () => {
      await latestHook!.loadMCPClientStatuses();
    });

    act(() => {
      latestHook!.handleSelectMCPClient('opencode');
    });
    await act(async () => {
      await latestHook!.handleInstallSelectedMCPClient();
    });

    expect(service.AIInstallOpenCodeMCP).toHaveBeenCalledTimes(1);
    expect(service.AIInstallClaudeCodeMCP).not.toHaveBeenCalled();
    expect(service.AIInstallCodexMCP).not.toHaveBeenCalled();
    expect(service.AIGetMCPClientInstallStatuses).toHaveBeenCalledTimes(2);
    expect(onBeforeInstall).toHaveBeenCalledTimes(1);
    expect(onAfterInstall).toHaveBeenCalledTimes(1);
    expect(onConfigChanged).toHaveBeenCalledTimes(1);
    expect(messageApi.success).toHaveBeenCalledWith('T: installed OpenCode');
  });

  it('shows the OpenCode-specific unsupported message when an older backend lacks the binding', async () => {
    const service = {
      AIGetMCPClientInstallStatuses: vi.fn(async () => [openCodeStatus]),
      AIInstallClaudeCodeMCP: vi.fn(async () => ({})),
      AIInstallCodexMCP: vi.fn(async () => ({})),
    };
    renderInstaller(service);

    await act(async () => {
      await latestHook!.loadMCPClientStatuses();
    });

    act(() => {
      latestHook!.handleSelectMCPClient('opencode');
    });
    await act(async () => {
      await latestHook!.handleInstallSelectedMCPClient();
    });

    expect(service.AIInstallClaudeCodeMCP).not.toHaveBeenCalled();
    expect(service.AIInstallCodexMCP).not.toHaveBeenCalled();
    expect(messageApi.error).toHaveBeenCalledWith('T: OpenCode auto install is unavailable');
    expect(onAfterInstall).toHaveBeenCalledTimes(1);
    expect(onConfigChanged).not.toHaveBeenCalled();
  });

  it('routes each added local client to its dedicated one-click installer', async () => {
    const service = {
      AIGetMCPClientInstallStatuses: vi.fn(async () => additionalAutoMCPClientStatuses),
      AIInstallClaudeCodeMCP: vi.fn(async () => ({})),
      AIInstallCodexMCP: vi.fn(async () => ({})),
      AIInstallOpenCodeMCP: vi.fn(async () => ({})),
      AIInstallZCodeMCP: vi.fn(async () => ({ success: true })),
      AIInstallDeepSeekHarnessMCP: vi.fn(async () => ({ success: true })),
      AIInstallKimiMCP: vi.fn(async () => ({ success: true })),
      AIInstallGrokBuildMCP: vi.fn(async () => ({ success: true })),
    };
    renderInstaller(service);

    await act(async () => {
      await latestHook!.loadMCPClientStatuses();
    });

    for (const [client, label, method] of additionalAutoMCPClients) {
      act(() => {
        latestHook!.handleSelectMCPClient(client);
      });
      await act(async () => {
        await latestHook!.handleInstallSelectedMCPClient();
      });
      expect((service as any)[method]).toHaveBeenCalledTimes(1);
      expect(messageApi.success).toHaveBeenCalledWith(`T: installed ${label}`);
    }

    expect(service.AIInstallClaudeCodeMCP).not.toHaveBeenCalled();
    expect(service.AIInstallCodexMCP).not.toHaveBeenCalled();
    expect(service.AIInstallOpenCodeMCP).not.toHaveBeenCalled();
    expect(onConfigChanged).toHaveBeenCalledTimes(4);
  });

  it('does not write a local MCP config until the selected client is detected', async () => {
    const service = {
      AIGetMCPClientInstallStatuses: vi.fn(async () => []),
      AIInstallDeepSeekHarnessMCP: vi.fn(async () => ({ success: true })),
    };
    renderInstaller(service);

    act(() => {
      latestHook!.handleSelectMCPClient('deepseek-harness');
    });
    await act(async () => {
      await latestHook!.handleInstallSelectedMCPClient();
    });

    expect(service.AIInstallDeepSeekHarnessMCP).not.toHaveBeenCalled();
    expect(messageApi.warning).toHaveBeenCalledTimes(1);
    expect(onBeforeInstall).not.toHaveBeenCalled();
    expect(onAfterInstall).not.toHaveBeenCalled();
    expect(onConfigChanged).not.toHaveBeenCalled();
  });
});
