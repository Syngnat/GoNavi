import { useCallback, useMemo, useState } from 'react';

import type { AIMCPClientInstallStatus } from '../../types';
import {
  buildRemoteMCPClientGuide,
  buildRemoteMCPClientQuickStart,
  EMPTY_MCP_CLIENT_STATUSES,
  formatMCPLaunchCommand,
  isMCPClientKey,
  isLocalMCPClientUnavailable,
  isMCPClientConnected,
  isRemoteMCPClientStatus,
  normalizeMCPClientStatuses,
  pickPreferredMCPClient,
  type MCPClientKey,
} from '../../utils/mcpClientInstallStatus';
import {
  translateMCPClientInstallCopy,
  resolveMCPClientCommandName,
  type MCPClientInstallTranslator,
} from './mcpClientInstallPanelState';

interface MCPClientInstallResult {
  success?: boolean;
  client?: string;
  configPath?: string;
  command?: string;
  args?: string[];
}

interface MCPClientMessageApi {
  error: (content: string) => unknown;
  success: (content: string) => unknown;
  warning: (content: string) => unknown;
}

interface AIMCPClientInstallerService {
  AIGetMCPClientInstallStatuses?: () => Promise<AIMCPClientInstallStatus[]>;
  AIInstallClaudeCodeMCP?: () => Promise<MCPClientInstallResult>;
  AIInstallCodexMCP?: () => Promise<MCPClientInstallResult>;
  AIInstallOpenCodeMCP?: () => Promise<MCPClientInstallResult>;
  AIInstallZCodeMCP?: () => Promise<MCPClientInstallResult>;
  AIInstallDeepSeekHarnessMCP?: () => Promise<MCPClientInstallResult>;
  AIInstallKimiMCP?: () => Promise<MCPClientInstallResult>;
  AIInstallGrokBuildMCP?: () => Promise<MCPClientInstallResult>;
}

const MCP_CLIENT_DISPLAY_NAMES: Record<MCPClientKey, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  zcode: 'ZCode',
  'deepseek-harness': 'DeepSeek Harness',
  kimi: 'Kimi Code',
  'grok-build': 'Grok Build',
  openclaw: 'OpenClaw',
  hermans: 'Hermans',
};

interface UseAIMCPClientInstallerOptions {
  copyTextToClipboard: (text: string, successMessage: string) => Promise<void>;
  messageApi: MCPClientMessageApi;
  onAfterInstall?: () => void;
  onBeforeInstall?: () => void | Promise<void>;
  onConfigChanged?: () => void;
  resolveAIService: () => Promise<AIMCPClientInstallerService | null>;
  translate?: MCPClientInstallTranslator;
}

export const useAIMCPClientInstaller = ({
  copyTextToClipboard,
  messageApi,
  onAfterInstall,
  onBeforeInstall,
  onConfigChanged,
  resolveAIService,
  translate,
}: UseAIMCPClientInstallerOptions) => {
  const [mcpClientStatuses, setMCPClientStatuses] = useState<AIMCPClientInstallStatus[]>(EMPTY_MCP_CLIENT_STATUSES);
  const [selectedMCPClient, setSelectedMCPClient] = useState<MCPClientKey>('claude-code');
  const [mcpClientSelectionTouched, setMCPClientSelectionTouched] = useState(false);
  const [mcpClientStatusLoading, setMCPClientStatusLoading] = useState(false);

  const selectedMCPClientStatus = useMemo(
    () => mcpClientStatuses.find((item) => item.client === selectedMCPClient) || mcpClientStatuses[0],
    [mcpClientStatuses, selectedMCPClient],
  );
  const selectedMCPClientCommandText = useMemo(
    () => isRemoteMCPClientStatus(selectedMCPClientStatus)
      ? buildRemoteMCPClientQuickStart(selectedMCPClientStatus).launchCommand
      : formatMCPLaunchCommand(selectedMCPClientStatus),
    [selectedMCPClientStatus],
  );
  const copy = useCallback((
    key: string,
    fallback: string,
    params?: Record<string, string | number | boolean | null | undefined>,
  ) => translateMCPClientInstallCopy(translate, key, fallback, params), [translate]);

  const syncMCPClientStatuses = useCallback((items?: AIMCPClientInstallStatus[]) => {
    const normalizedStatuses = normalizeMCPClientStatuses(items);
    setMCPClientStatuses(normalizedStatuses);
    setSelectedMCPClient((prev) => pickPreferredMCPClient(normalizedStatuses, mcpClientSelectionTouched ? prev : undefined));
  }, [mcpClientSelectionTouched]);

  const handleSelectMCPClient = useCallback((client: MCPClientKey) => {
    setMCPClientSelectionTouched(true);
    setSelectedMCPClient(client);
  }, []);

  const resetMCPClientSelectionTouched = useCallback(() => {
    setMCPClientSelectionTouched(false);
  }, []);

  const loadMCPClientStatuses = useCallback(async (options?: { silent?: boolean }) => {
    const silent = options?.silent === true;
    if (!silent) {
      setMCPClientStatusLoading(true);
    }
    try {
      const service = await resolveAIService();
      if (typeof service?.AIGetMCPClientInstallStatuses !== 'function') {
        return;
      }
      const result = await service.AIGetMCPClientInstallStatuses();
      if (Array.isArray(result)) {
        syncMCPClientStatuses(result);
      }
    } catch (error: any) {
      if (silent) {
        console.warn('[AI] refresh mcp client statuses failed', error);
      } else {
        void messageApi.error(error?.message || copy('ai_chat.mcp_client.install.message.refresh_failed', 'Failed to refresh client installation status'));
      }
    } finally {
      if (!silent) {
        setMCPClientStatusLoading(false);
      }
    }
  }, [copy, messageApi, resolveAIService, syncMCPClientStatuses]);

  const handleInstallSelectedMCPClient = useCallback(async () => {
    const remoteClient = isRemoteMCPClientStatus(selectedMCPClientStatus);
    const selectedClient = String(selectedMCPClientStatus?.client || '').trim();
    const targetClient: MCPClientKey = isMCPClientKey(selectedClient) ? selectedClient : 'claude-code';
    const targetLabel = selectedMCPClientStatus?.displayName || MCP_CLIENT_DISPLAY_NAMES[targetClient];
    if (remoteClient) {
      try {
        await onBeforeInstall?.();
        setMCPClientSelectionTouched(true);
        await copyTextToClipboard(
          buildRemoteMCPClientGuide(selectedMCPClientStatus),
          copy('ai_chat.mcp_client.install.message.remote_guide_copied', '{{label}} remote connection guide copied', { label: targetLabel }),
        );
      } catch (error: any) {
        void messageApi.error(error?.message || copy('ai_chat.mcp_client.install.message.remote_guide_copy_failed', 'Failed to copy {{label}} remote connection guide', { label: targetLabel }));
      } finally {
        onAfterInstall?.();
      }
      return;
    }
    if (isLocalMCPClientUnavailable(selectedMCPClientStatus)) {
      void messageApi.warning(copy(
        'ai_chat.mcp_client.install.message.client_not_detected',
        '{{label}} was not detected locally. Install or enable it, add {{command}} to PATH, then refresh detection before writing MCP configuration.',
        { label: targetLabel, command: resolveMCPClientCommandName(selectedMCPClientStatus) },
      ));
      return;
    }
    if (isMCPClientConnected(selectedMCPClientStatus)) {
      try {
        await onBeforeInstall?.();
        void messageApi.success(copy('ai_chat.mcp_client.install.message.already_connected', '{{label}} is already connected to current GoNavi MCP. No repeated write is needed.', { label: targetLabel }));
      } catch (error: any) {
        void messageApi.error(error?.message || copy('ai_chat.mcp_client.install.message.install_failed', 'Failed to install {{label}} MCP', { label: targetLabel }));
      } finally {
        onAfterInstall?.();
      }
      return;
    }
    try {
      await onBeforeInstall?.();
      setMCPClientSelectionTouched(true);
      const service = await resolveAIService();
      switch (targetClient) {
        case 'opencode':
          if (typeof service?.AIInstallOpenCodeMCP !== 'function') {
            throw new Error(copy('ai_chat.mcp_client.install.message.opencode_not_supported', 'This version does not support automatic OpenCode MCP installation yet'));
          }
          await service.AIInstallOpenCodeMCP();
          break;
        case 'codex':
          if (typeof service?.AIInstallCodexMCP !== 'function') {
            throw new Error(copy('ai_chat.mcp_client.install.message.codex_not_supported', 'This version does not support automatic Codex MCP installation yet'));
          }
          await service.AIInstallCodexMCP();
          break;
        case 'zcode':
          if (typeof service?.AIInstallZCodeMCP !== 'function') {
            throw new Error(copy('ai_chat.mcp_client.install.message.auto_install_not_supported', 'This version does not support automatic {{label}} MCP installation yet', { label: targetLabel }));
          }
          await service.AIInstallZCodeMCP();
          break;
        case 'deepseek-harness':
          if (typeof service?.AIInstallDeepSeekHarnessMCP !== 'function') {
            throw new Error(copy('ai_chat.mcp_client.install.message.auto_install_not_supported', 'This version does not support automatic {{label}} MCP installation yet', { label: targetLabel }));
          }
          await service.AIInstallDeepSeekHarnessMCP();
          break;
        case 'kimi':
          if (typeof service?.AIInstallKimiMCP !== 'function') {
            throw new Error(copy('ai_chat.mcp_client.install.message.auto_install_not_supported', 'This version does not support automatic {{label}} MCP installation yet', { label: targetLabel }));
          }
          await service.AIInstallKimiMCP();
          break;
        case 'grok-build':
          if (typeof service?.AIInstallGrokBuildMCP !== 'function') {
            throw new Error(copy('ai_chat.mcp_client.install.message.auto_install_not_supported', 'This version does not support automatic {{label}} MCP installation yet', { label: targetLabel }));
          }
          await service.AIInstallGrokBuildMCP();
          break;
        default:
          if (typeof service?.AIInstallClaudeCodeMCP !== 'function') {
            throw new Error(copy('ai_chat.mcp_client.install.message.claude_not_supported', 'This version does not support automatic Claude Code MCP installation yet'));
          }
          await service.AIInstallClaudeCodeMCP();
      }
      await loadMCPClientStatuses({ silent: true });
      onConfigChanged?.();
      void messageApi.success(copy('ai_chat.mcp_client.install.message.install_success', 'Wrote {{label}} user-level MCP config', { label: targetLabel }));
    } catch (error: any) {
      void messageApi.error(error?.message || copy('ai_chat.mcp_client.install.message.install_failed', 'Failed to install {{label}} MCP', { label: targetLabel }));
    } finally {
      onAfterInstall?.();
    }
  }, [copy, copyTextToClipboard, loadMCPClientStatuses, messageApi, onAfterInstall, onBeforeInstall, onConfigChanged, resolveAIService, selectedMCPClientStatus]);

  const handleCopySelectedMCPConfigPath = useCallback(async () => {
    const configPath = String(selectedMCPClientStatus?.configPath || '').trim();
    if (!configPath) {
      void messageApi.warning(copy('ai_chat.mcp_client.install.message.config_path_missing', 'No config file path is available to copy'));
      return;
    }
    try {
      await copyTextToClipboard(configPath, copy('ai_chat.mcp_client.install.message.config_path_copied', 'Config file path copied'));
    } catch (error: any) {
      void messageApi.error(error?.message || copy('ai_chat.mcp_client.install.message.config_path_copy_failed', 'Failed to copy config file path'));
    }
  }, [copy, copyTextToClipboard, messageApi, selectedMCPClientStatus]);

  const handleCopySelectedMCPLaunchCommand = useCallback(async () => {
    if (!selectedMCPClientCommandText) {
      void messageApi.warning(copy('ai_chat.mcp_client.install.message.launch_command_missing', 'No launch command is available to copy'));
      return;
    }
    try {
      await copyTextToClipboard(selectedMCPClientCommandText, copy('ai_chat.mcp_client.install.message.launch_command_copied', 'Launch command copied'));
    } catch (error: any) {
      void messageApi.error(error?.message || copy('ai_chat.mcp_client.install.message.launch_command_copy_failed', 'Failed to copy launch command'));
    }
  }, [copy, copyTextToClipboard, messageApi, selectedMCPClientCommandText]);

  return {
    handleCopySelectedMCPConfigPath,
    handleCopySelectedMCPLaunchCommand,
    handleInstallSelectedMCPClient,
    handleSelectMCPClient,
    loadMCPClientStatuses,
    mcpClientStatusLoading,
    mcpClientStatuses,
    resetMCPClientSelectionTouched,
    selectedMCPClient,
    selectedMCPClientCommandText,
    selectedMCPClientStatus,
    syncMCPClientStatuses,
  };
};
