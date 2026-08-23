import type { AIMCPClientInstallStatus } from '../../types';
import {
  isLocalMCPClientUnavailable,
  isMCPClientConnected,
  isRemoteMCPClientStatus,
} from '../../utils/mcpClientInstallStatus';

export type MCPClientInstallCopyParams = Record<string, string | number | boolean | null | undefined>;
export type MCPClientInstallTranslator = (key: string, params?: MCPClientInstallCopyParams) => string;

export interface MCPClientInstallStatusTone {
  label: string;
  color: string;
  bg: string;
}

const interpolateFallback = (text: string, params?: MCPClientInstallCopyParams): string =>
  text.replace(/\{\{(\w+)\}\}/g, (_match, name) => String(params?.[name] ?? ''));

export const translateMCPClientInstallCopy = (
  translate: MCPClientInstallTranslator | undefined,
  key: string,
  fallback: string,
  params?: MCPClientInstallCopyParams,
): string => {
  const translated = translate?.(key, params);
  if (translated && translated !== key) {
    return translated;
  }
  return interpolateFallback(fallback, params);
};

export const hasMCPClientStatusIssue = (status: AIMCPClientInstallStatus | undefined): boolean => {
  const message = String(status?.message || '').toLowerCase();
  return /fail|failed|error|exception/u.test(message) ||
    message.includes('\u5931\u8d25') ||
    message.includes('\u5f02\u5e38') ||
    message.includes('\u9519\u8bef');
};

export const getMCPClientStatusTone = (
  status: AIMCPClientInstallStatus | undefined,
  darkMode: boolean,
  translate?: MCPClientInstallTranslator,
): MCPClientInstallStatusTone => {
  const copy = (key: string, fallback: string) => translateMCPClientInstallCopy(translate, key, fallback);
  if (isLocalMCPClientUnavailable(status)) {
    return {
      label: copy('ai_chat.mcp_client.install.status_tone.client_not_detected', 'Client not detected'),
      color: '#d97706',
      bg: darkMode ? 'rgba(245,158,11,0.18)' : 'rgba(245,158,11,0.12)',
    };
  }
  if (isMCPClientConnected(status)) {
    return {
      label: copy('ai_chat.mcp_client.install.status_tone.connected', 'Connected'),
      color: '#16a34a',
      bg: darkMode ? 'rgba(34,197,94,0.18)' : 'rgba(34,197,94,0.12)',
    };
  }
  if (status?.installed) {
    return {
      label: copy('ai_chat.mcp_client.install.status_tone.update_required', 'Update needed'),
      color: '#d97706',
      bg: darkMode ? 'rgba(245,158,11,0.18)' : 'rgba(245,158,11,0.12)',
    };
  }
  if (isRemoteMCPClientStatus(status)) {
    return {
      label: copy('ai_chat.mcp_client.install.status_tone.remote_bridge', 'Remote bridge'),
      color: '#0284c7',
      bg: darkMode ? 'rgba(56,189,248,0.16)' : 'rgba(14,165,233,0.10)',
    };
  }
  if (hasMCPClientStatusIssue(status)) {
    return {
      label: copy('ai_chat.mcp_client.install.status_tone.status_error', 'Status error'),
      color: '#dc2626',
      bg: darkMode ? 'rgba(239,68,68,0.18)' : 'rgba(239,68,68,0.1)',
    };
  }
  return {
    label: copy('ai_chat.mcp_client.install.status_tone.not_connected', 'Not connected'),
    color: darkMode ? 'rgba(255,255,255,0.72)' : '#64748b',
    bg: darkMode ? 'rgba(255,255,255,0.08)' : 'rgba(100,116,139,0.08)',
  };
};

export const getMCPClientInstallStateLabel = (
  status: AIMCPClientInstallStatus | undefined,
  translate?: MCPClientInstallTranslator,
): string => {
  if (isLocalMCPClientUnavailable(status)) {
    return translateMCPClientInstallCopy(translate, 'ai_chat.mcp_client.install.state.client_not_detected', 'External tool connection status: client not detected');
  }
  if (isMCPClientConnected(status)) {
    return translateMCPClientInstallCopy(translate, 'ai_chat.mcp_client.install.state.connected', 'External tool connection status: connected to this GoNavi');
  }
  if (status?.installed) {
    return translateMCPClientInstallCopy(translate, 'ai_chat.mcp_client.install.state.stale', 'External tool connection status: old config found, update needed');
  }
  if (hasMCPClientStatusIssue(status)) {
    return translateMCPClientInstallCopy(translate, 'ai_chat.mcp_client.install.state.error', 'External tool connection status: failed to read');
  }
  if (isRemoteMCPClientStatus(status)) {
    return translateMCPClientInstallCopy(translate, 'ai_chat.mcp_client.install.state.remote', 'External tool connection status: remote MCP bridge required');
  }
  return translateMCPClientInstallCopy(translate, 'ai_chat.mcp_client.install.state.missing', 'External tool connection status: not connected');
};

export const resolveMCPClientCommandName = (status: AIMCPClientInstallStatus | undefined): string => {
  const command = String(status?.clientCommand || '').trim();
  if (command) {
    return command;
  }
  if (status?.client === 'codex') {
    return 'codex';
  }
  if (status?.client === 'opencode') {
    return 'opencode';
  }
  if (status?.client === 'zcode') {
    return 'zcode';
  }
  if (status?.client === 'deepseek-harness') {
    return 'dsh';
  }
  if (status?.client === 'kimi') {
    return 'kimi';
  }
  if (status?.client === 'grok-build') {
    return 'grok';
  }
  return 'claude';
};

export const getMCPClientStatusSummary = (
  status: AIMCPClientInstallStatus | undefined,
  translate?: MCPClientInstallTranslator,
): string => {
  const label = status?.displayName || 'this client';
  if (isLocalMCPClientUnavailable(status)) {
    return translateMCPClientInstallCopy(translate, 'ai_chat.mcp_client.install.summary.client_not_detected', '{{label}} was not detected locally. Install or enable it and refresh detection before writing or using its MCP config.', { label });
  }
  if (isMCPClientConnected(status)) {
    return translateMCPClientInstallCopy(translate, 'ai_chat.mcp_client.install.summary.connected', '{{label}} is connected to this GoNavi MCP and can call it directly.', { label });
  }
  if (status?.installed) {
    return translateMCPClientInstallCopy(translate, 'ai_chat.mcp_client.install.summary.stale', '{{label}} already has an old GoNavi entry. Updating will point it to this GoNavi.', { label });
  }
  if (hasMCPClientStatusIssue(status)) {
    return translateMCPClientInstallCopy(translate, 'ai_chat.mcp_client.install.summary.error', 'Failed to read the connection status for {{label}}. Refresh detection first.', { label });
  }
  if (isRemoteMCPClientStatus(status)) {
    return translateMCPClientInstallCopy(translate, 'ai_chat.mcp_client.install.summary.remote', '{{label}} usually runs in the cloud or on another machine and needs a remote MCP bridge to call this GoNavi.', { label });
  }
  return translateMCPClientInstallCopy(translate, 'ai_chat.mcp_client.install.summary.missing', 'This GoNavi MCP is not connected to {{label}} yet.', { label });
};

export const getMCPClientOptionSummary = (
  status: AIMCPClientInstallStatus | undefined,
  translate?: MCPClientInstallTranslator,
): string => {
  if (isLocalMCPClientUnavailable(status)) {
    return translateMCPClientInstallCopy(translate, 'ai_chat.mcp_client.install.option.client_not_detected', 'The local client was not detected. Install or enable it before GoNavi writes MCP configuration.');
  }
  if (isMCPClientConnected(status)) {
    return translateMCPClientInstallCopy(translate, 'ai_chat.mcp_client.install.option.connected', 'This GoNavi MCP is already connected to this client.');
  }
  if (status?.installed) {
    return translateMCPClientInstallCopy(translate, 'ai_chat.mcp_client.install.option.stale', 'An old GoNavi entry was detected. Update it to the current install path.');
  }
  if (hasMCPClientStatusIssue(status)) {
    return translateMCPClientInstallCopy(translate, 'ai_chat.mcp_client.install.option.error', 'Connection status looks abnormal. Refresh before changing it.');
  }
  if (isRemoteMCPClientStatus(status)) {
    return translateMCPClientInstallCopy(translate, 'ai_chat.mcp_client.install.option.remote', 'For cloud Agents: schema-only reads GoNavi structure by default, without copying database passwords or exposing execute_sql.');
  }
  return translateMCPClientInstallCopy(translate, 'ai_chat.mcp_client.install.option.missing', 'Current GoNavi MCP is not connected here yet.');
};

export const getMCPClientDetectionSummary = (
  status: AIMCPClientInstallStatus | undefined,
  translate?: MCPClientInstallTranslator,
): string => {
  const label = status?.displayName || 'this client';
  const command = resolveMCPClientCommandName(status);
  if (isRemoteMCPClientStatus(status)) {
    return translateMCPClientInstallCopy(translate, 'ai_chat.mcp_client.install.detection.remote', '{{label}} usually does not run on this Windows machine. No local {{command}} command detection is needed; configure a remote MCP bridge URL in the cloud.', { label, command });
  }
  if (isLocalMCPClientUnavailable(status)) {
    return translateMCPClientInstallCopy(translate, 'ai_chat.mcp_client.install.detection.not_detected', 'Local {{command}} command was not detected. Install or enable {{label}}, add the command to PATH, then refresh detection; configuration writing is disabled until then.', { label, command });
  }
  if (status?.clientDetected) {
    return translateMCPClientInstallCopy(translate, 'ai_chat.mcp_client.install.detection.detected', 'Detected local {{command}} command. After connecting or updating, restart {{label}} to verify.', { label, command });
  }
  return translateMCPClientInstallCopy(translate, 'ai_chat.mcp_client.install.detection.not_detected', 'Local {{command}} command was not detected. Install or enable {{label}}, add the command to PATH, then refresh detection; configuration writing is disabled until then.', { label, command });
};

export const getSelectedMCPClientStateLine = (
  status: AIMCPClientInstallStatus | undefined,
  translate?: MCPClientInstallTranslator,
): string => {
  if (isLocalMCPClientUnavailable(status)) {
    return translateMCPClientInstallCopy(translate, 'ai_chat.mcp_client.install.selected.client_not_detected', 'Client was not detected locally; install or enable it before writing MCP configuration');
  }
  if (isMCPClientConnected(status)) {
    return translateMCPClientInstallCopy(translate, 'ai_chat.mcp_client.install.selected.connected', 'Connected to current GoNavi; no repeated action needed');
  }
  if (status?.installed) {
    return translateMCPClientInstallCopy(translate, 'ai_chat.mcp_client.install.selected.stale', 'Old connection record exists; update it to the current GoNavi path');
  }
  if (hasMCPClientStatusIssue(status)) {
    return translateMCPClientInstallCopy(translate, 'ai_chat.mcp_client.install.selected.error', 'Status read is abnormal; refresh detection first');
  }
  if (isRemoteMCPClientStatus(status)) {
    return translateMCPClientInstallCopy(translate, 'ai_chat.mcp_client.install.selected.remote', 'Configure a remote MCP bridge; database passwords stay on the GoNavi machine');
  }
  return translateMCPClientInstallCopy(translate, 'ai_chat.mcp_client.install.selected.missing', 'GoNavi MCP is not connected yet');
};

export const resolveMCPClientInstallActionLabel = (
  status: AIMCPClientInstallStatus | undefined,
  translate?: MCPClientInstallTranslator,
): string => {
  const label = status?.displayName || 'target client';
  if (isLocalMCPClientUnavailable(status)) {
    return translateMCPClientInstallCopy(translate, 'ai_chat.mcp_client.install.action.install_client_first', 'Install or enable {{label}} first', { label });
  }
  if (isMCPClientConnected(status)) {
    return translateMCPClientInstallCopy(translate, 'ai_chat.mcp_client.install.action.connected', '{{label}} is connected; no reinstall needed', { label });
  }
  if (status?.installed) {
    return translateMCPClientInstallCopy(translate, 'ai_chat.mcp_client.install.action.update', 'Update {{label}} connection config', { label });
  }
  if (isRemoteMCPClientStatus(status)) {
    return translateMCPClientInstallCopy(translate, 'ai_chat.mcp_client.install.action.copy_remote', 'Copy {{label}} remote connection guide', { label });
  }
  return translateMCPClientInstallCopy(translate, 'ai_chat.mcp_client.install.action.install', 'Install to {{label}} (external tool)', { label });
};
