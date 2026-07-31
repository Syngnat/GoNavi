import { describe, expect, it } from 'vitest';

import { catalogs } from '../../i18n/catalog';
import type { AIMCPClientInstallStatus } from '../../types';
import {
  getMCPClientDetectionSummary,
  getMCPClientInstallStateLabel,
  getMCPClientOptionSummary,
  getMCPClientStatusSummary,
  getMCPClientStatusTone,
  getSelectedMCPClientStateLine,
  resolveMCPClientCommandName,
  resolveMCPClientInstallActionLabel,
} from './mcpClientInstallPanelState';

const REQUIRED_MCP_CLIENT_INSTALL_KEYS = [
  'ai_chat.mcp_client.install.status_tone.connected',
  'ai_chat.mcp_client.install.status_tone.update_required',
  'ai_chat.mcp_client.install.status_tone.remote_bridge',
  'ai_chat.mcp_client.install.status_tone.status_error',
  'ai_chat.mcp_client.install.status_tone.not_connected',
  'ai_chat.mcp_client.install.state.connected',
  'ai_chat.mcp_client.install.state.stale',
  'ai_chat.mcp_client.install.state.error',
  'ai_chat.mcp_client.install.state.remote',
  'ai_chat.mcp_client.install.state.missing',
  'ai_chat.mcp_client.install.summary.connected',
  'ai_chat.mcp_client.install.summary.stale',
  'ai_chat.mcp_client.install.summary.error',
  'ai_chat.mcp_client.install.summary.remote',
  'ai_chat.mcp_client.install.summary.missing',
  'ai_chat.mcp_client.install.option.connected',
  'ai_chat.mcp_client.install.option.stale',
  'ai_chat.mcp_client.install.option.error',
  'ai_chat.mcp_client.install.option.remote',
  'ai_chat.mcp_client.install.option.missing',
  'ai_chat.mcp_client.install.detection.remote',
  'ai_chat.mcp_client.install.detection.detected',
  'ai_chat.mcp_client.install.detection.not_detected',
  'ai_chat.mcp_client.install.selected.connected',
  'ai_chat.mcp_client.install.selected.stale',
  'ai_chat.mcp_client.install.selected.error',
  'ai_chat.mcp_client.install.selected.remote',
  'ai_chat.mcp_client.install.selected.missing',
  'ai_chat.mcp_client.install.action.connected',
  'ai_chat.mcp_client.install.action.update',
  'ai_chat.mcp_client.install.action.copy_remote',
  'ai_chat.mcp_client.install.action.install',
  'ai_chat.mcp_client.install.intro.title',
  'ai_chat.mcp_client.install.intro.description',
  'ai_chat.mcp_client.install.repeat_avoidance',
  'ai_chat.mcp_client.install.selector.title',
  'ai_chat.mcp_client.install.selector.description',
  'ai_chat.mcp_client.install.selector.aria_label',
  'ai_chat.mcp_client.install.selector.choice_title',
  'ai_chat.mcp_client.install.selector.step.target.title',
  'ai_chat.mcp_client.install.selector.step.target.detail',
  'ai_chat.mcp_client.install.selector.step.write.title',
  'ai_chat.mcp_client.install.selector.step.write.detail',
  'ai_chat.mcp_client.install.selector.step.restart.title',
  'ai_chat.mcp_client.install.selector.step.restart.detail',
  'ai_chat.mcp_client.install.selector.hint.active_remote',
  'ai_chat.mcp_client.install.selector.hint.active_local',
  'ai_chat.mcp_client.install.selector.hint.inactive_remote',
  'ai_chat.mcp_client.install.selector.hint.inactive_local',
  'ai_chat.mcp_client.install.status.title',
  'ai_chat.mcp_client.install.status.current_target',
  'ai_chat.mcp_client.install.status.no_client',
  'ai_chat.mcp_client.install.status.current_state',
  'ai_chat.mcp_client.install.status.remote_boundary',
  'ai_chat.mcp_client.install.status.cli_prefix',
  'ai_chat.mcp_client.install.status.cli.remote',
  'ai_chat.mcp_client.install.status.cli.detected',
  'ai_chat.mcp_client.install.status.cli.not_detected',
  'ai_chat.mcp_client.install.status.command_path',
  'ai_chat.mcp_client.install.status.detection_result',
  'ai_chat.mcp_client.install.status.detection_missing',
  'ai_chat.mcp_client.install.status.config_file',
  'ai_chat.mcp_client.install.status.launch_command',
  'ai_chat.mcp_client.install.status.refresh',
  'ai_chat.mcp_client.install.status.copy_config',
  'ai_chat.mcp_client.install.status.copy_command',
  'ai_chat.mcp_client.install.message.refresh_failed',
  'ai_chat.mcp_client.install.message.remote_guide_copied',
  'ai_chat.mcp_client.install.message.remote_guide_copy_failed',
  'ai_chat.mcp_client.install.message.already_connected',
  'ai_chat.mcp_client.install.message.codex_not_supported',
  'ai_chat.mcp_client.install.message.opencode_not_supported',
  'ai_chat.mcp_client.install.message.claude_not_supported',
  'ai_chat.mcp_client.install.message.install_success',
  'ai_chat.mcp_client.install.message.install_failed',
  'ai_chat.mcp_client.install.message.config_path_missing',
  'ai_chat.mcp_client.install.message.config_path_copied',
  'ai_chat.mcp_client.install.message.config_path_copy_failed',
  'ai_chat.mcp_client.install.message.launch_command_missing',
  'ai_chat.mcp_client.install.message.launch_command_copied',
  'ai_chat.mcp_client.install.message.launch_command_copy_failed',
];

const translatedCopy: Record<string, string> = {
  'ai_chat.mcp_client.install.status_tone.connected': 'T:connected',
  'ai_chat.mcp_client.install.state.connected': 'T:state-connected',
  'ai_chat.mcp_client.install.selected.connected': 'T:selected-connected',
  'ai_chat.mcp_client.install.action.connected': 'T:action-connected {{label}}',
  'ai_chat.mcp_client.install.summary.connected': 'T:summary-connected {{label}}',
};

const translate = (
  key: string,
  params?: Record<string, string | number | boolean | null | undefined>,
) => (translatedCopy[key] || key).replace(/\{\{(\w+)\}\}/g, (_match, name) => String(params?.[name] ?? ''));

const buildStatus = (patch: Partial<AIMCPClientInstallStatus>): AIMCPClientInstallStatus => ({
  client: 'claude-code',
  displayName: 'Claude Code',
  installed: false,
  matchesCurrent: false,
  clientDetected: false,
  clientCommand: 'claude',
  message: '未检测到 Claude Code 用户级 GoNavi MCP 配置',
  ...patch,
});

describe('mcpClientInstallPanelState', () => {
  it('keeps external MCP client install copy behind six-language catalog keys', () => {
    for (const [language, catalog] of Object.entries(catalogs)) {
      const missing = REQUIRED_MCP_CLIENT_INSTALL_KEYS.filter((key) => !(key in catalog));
      expect(missing, `${language} missing mcp client install keys`).toEqual([]);
    }
  });

  it('threads the panel translator through status helper copy', () => {
    const status = buildStatus({
      installed: true,
      matchesCurrent: true,
      clientDetected: true,
    });

    expect((getMCPClientStatusTone as any)(status, false, translate).label).toBe('T:connected');
    expect((getMCPClientInstallStateLabel as any)(status, translate)).toBe('T:state-connected');
    expect((getSelectedMCPClientStateLine as any)(status, translate)).toBe('T:selected-connected');
    expect((resolveMCPClientInstallActionLabel as any)(status, translate)).toBe('T:action-connected Claude Code');
    expect((getMCPClientStatusSummary as any)(status, translate)).toBe('T:summary-connected Claude Code');
  });

  it('marks a current client as already connected and prevents repeated install wording', () => {
    const status = buildStatus({
      installed: true,
      matchesCurrent: true,
      clientDetected: true,
      message: '已检测到 Claude Code 用户级 GoNavi MCP 配置，且与当前 GoNavi 安装路径一致',
    });

    expect(getMCPClientStatusTone(status, false).label).toBe('Connected');
    expect(getMCPClientInstallStateLabel(status)).toBe('External tool connection status: connected to this GoNavi');
    expect(getSelectedMCPClientStateLine(status)).toBe('Connected to current GoNavi; no repeated action needed');
    expect(resolveMCPClientInstallActionLabel(status)).toBe('Claude Code is connected; no reinstall needed');
    expect(getMCPClientStatusSummary(status)).toContain('can call it directly');
  });

  it('asks users to update stale external client records instead of reinstalling blindly', () => {
    const status = buildStatus({
      client: 'codex',
      displayName: 'Codex',
      installed: true,
      matchesCurrent: false,
      clientDetected: true,
      clientCommand: 'codex',
      message: '已检测到 Codex 中的 GoNavi MCP 记录，但与当前 GoNavi 安装路径不一致，建议更新',
    });

    expect(getMCPClientStatusTone(status, false).label).toBe('Update needed');
    expect(getMCPClientOptionSummary(status)).toContain('Update it to the current install path');
    expect(getSelectedMCPClientStateLine(status)).toBe('Old connection record exists; update it to the current GoNavi path');
    expect(resolveMCPClientInstallActionLabel(status)).toBe('Update Codex connection config');
  });

  it('explains that config can be written before the target CLI is detected in PATH', () => {
    const status = buildStatus({
      clientDetected: false,
      clientCommand: '',
    });

    expect(resolveMCPClientCommandName(status)).toBe('claude');
    expect(getMCPClientDetectionSummary(status)).toContain('CLI is not in PATH yet');
    expect(resolveMCPClientInstallActionLabel(status)).toBe('Install to Claude Code (external tool)');
  });

  it('uses the OpenCode command when its CLI path is not detected yet', () => {
    const status = buildStatus({
      client: 'opencode',
      displayName: 'OpenCode',
      clientCommand: '',
    });

    expect(resolveMCPClientCommandName(status)).toBe('opencode');
    expect(getMCPClientDetectionSummary(status)).toContain('Local opencode command was not detected');
    expect(resolveMCPClientInstallActionLabel(status)).toBe('Install to OpenCode (external tool)');
  });

  it('treats OpenClaw as a remote bridge target instead of a local install', () => {
    const status = buildStatus({
      client: 'openclaw',
      displayName: 'OpenClaw',
      installMode: 'remote',
      clientCommand: 'openclaw',
      message: 'OpenClaw 通常部署在云端 Linux；请通过远程 MCP 桥接接入 Windows GoNavi，不要复制数据库密码。',
    });

    expect(getMCPClientStatusTone(status, false).label).toBe('Remote bridge');
    expect(getMCPClientInstallStateLabel(status)).toBe('External tool connection status: remote MCP bridge required');
    expect(getMCPClientOptionSummary(status)).toContain('schema-only');
    expect(getMCPClientOptionSummary(status)).toContain('database passwords');
    expect(getMCPClientDetectionSummary(status)).toContain('No local openclaw command detection is needed');
    expect(getSelectedMCPClientStateLine(status)).toContain('database passwords stay on the GoNavi machine');
    expect(resolveMCPClientInstallActionLabel(status)).toBe('Copy OpenClaw remote connection guide');
  });
});
