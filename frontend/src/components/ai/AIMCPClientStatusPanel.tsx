import React from 'react';
import { Button } from 'antd';
import { CopyOutlined, ReloadOutlined } from '@ant-design/icons';

import type { AIMCPClientInstallStatus } from '../../types';
import {
  buildRemoteMCPClientQuickStart,
  isRemoteMCPClientStatus,
} from '../../utils/mcpClientInstallStatus';
import { useOptionalI18n } from '../../i18n/provider';
import type { OverlayWorkbenchTheme } from '../../utils/overlayWorkbenchTheme';
import AIMCPRemoteQuickStartPanel from './AIMCPRemoteQuickStartPanel';
import {
  getMCPClientStatusSummary,
  getMCPClientStatusTone,
  getSelectedMCPClientStateLine,
  resolveMCPClientCommandName,
  translateMCPClientInstallCopy,
} from './mcpClientInstallPanelState';

interface AIMCPClientStatusPanelProps {
  selectedStatus?: AIMCPClientInstallStatus;
  selectedCommandText: string;
  darkMode: boolean;
  overlayTheme: OverlayWorkbenchTheme;
  cardBorder: string;
  statusLoading: boolean;
  onRefreshStatus: () => void;
  onCopyConfigPath: () => void;
  onCopyLaunchCommand: () => void;
}

const AIMCPClientStatusPanel: React.FC<AIMCPClientStatusPanelProps> = ({
  selectedStatus,
  selectedCommandText,
  darkMode,
  overlayTheme,
  cardBorder,
  statusLoading,
  onRefreshStatus,
  onCopyConfigPath,
  onCopyLaunchCommand,
}) => {
  const i18n = useOptionalI18n();
  const t = i18n?.t;
  const copy = (
    key: string,
    fallback: string,
    params?: Record<string, string | number | boolean | null | undefined>,
  ) => translateMCPClientInstallCopy(t, key, fallback, params);
  const selectedIsRemoteClient = isRemoteMCPClientStatus(selectedStatus);
  const remoteQuickStart = selectedIsRemoteClient
    ? buildRemoteMCPClientQuickStart(selectedStatus, t)
    : null;
  const selectedTone = selectedStatus ? getMCPClientStatusTone(selectedStatus, darkMode, t) : null;

  return (
    <div
      className="gonavi-ai-mcp-client-status-panel"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
        <div style={{ minWidth: 0 }}>
          <div className="gonavi-ai-mcp-line-clamp" style={{ fontWeight: 700, fontSize: 13, color: overlayTheme.titleText }}>
            {getMCPClientStatusSummary(selectedStatus, t)}
          </div>
          <div className="gonavi-ai-mcp-line-clamp" style={{ marginTop: 2, fontSize: 'var(--gn-font-size-sm, 12px)', color: overlayTheme.mutedText, lineHeight: 1.5 }}>
            {copy('ai_chat.mcp_client.install.status.current_state', 'Current status: {{status}}', {
              status: getSelectedMCPClientStateLine(selectedStatus, t),
            })}
          </div>
        </div>
        {selectedTone && (
          <div
            style={{
              padding: '3px 9px',
              borderRadius: 999,
              fontSize: 'var(--gn-font-size-sm, 12px)',
              fontWeight: 700,
              color: selectedTone.color,
              background: selectedTone.bg,
              whiteSpace: 'nowrap',
              flexShrink: 0,
            }}
          >
            {selectedTone.label}
          </div>
        )}
      </div>
      <details className="gonavi-ai-mcp-disclosure gonavi-ai-mcp-client-status-disclosure">
        <summary>
          <span style={{ fontWeight: 700, color: overlayTheme.titleText }}>
            {copy('ai_chat.mcp_client.install.status.details_summary', 'Detection details')}
          </span>
          <span className="gonavi-ai-mcp-summary-note" style={{ color: overlayTheme.mutedText }}>
            {copy(
              selectedStatus?.displayName
                ? 'ai_chat.mcp_client.install.status.current_target'
                : 'ai_chat.mcp_client.install.status.no_client',
              selectedStatus?.displayName ? 'Current target client: {{label}}' : 'No client selected',
              { label: selectedStatus?.displayName || '' },
            )}
          </span>
        </summary>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '4px 0 4px' }}>
          <div style={{ fontWeight: 700, fontSize: 12, color: overlayTheme.titleText }}>
            {copy('ai_chat.mcp_client.install.status.title', 'Selected client status')}
          </div>
          {selectedIsRemoteClient && (
            <div
              style={{
                padding: '2px 0 2px 12px',
                borderLeft: `3px solid ${darkMode ? '#38bdf8' : '#0ea5e9'}`,
                background: 'transparent',
                fontSize: 12,
                color: overlayTheme.mutedText,
                lineHeight: 1.7,
              }}
            >
              {copy(
                'ai_chat.mcp_client.install.status.remote_boundary',
                'Remote connection boundary: database connection info and passwords stay in Windows GoNavi. Cloud Agents read connection summaries, object lists, tables, views, and DDL through schema-only MCP tools by default, and execute_sql is not registered. For cross-machine access, use GoNavi Streamable HTTP mode with a token, tunnel, or reverse proxy.',
              )}
            </div>
          )}
          {remoteQuickStart && (
            <AIMCPRemoteQuickStartPanel
              quickStart={remoteQuickStart}
              darkMode={darkMode}
              overlayTheme={overlayTheme}
              cardBorder={cardBorder}
            />
          )}
          <div style={{ fontSize: 12, color: overlayTheme.mutedText, lineHeight: 1.7 }}>
            {copy('ai_chat.mcp_client.install.status.cli_prefix', 'CLI detection: {{status}}', {
              status: selectedIsRemoteClient
                ? copy('ai_chat.mcp_client.install.status.cli.remote', 'Remote Agent does not need local {{command}} command detection', { command: resolveMCPClientCommandName(selectedStatus) })
                : selectedStatus?.clientDetected
                  ? copy('ai_chat.mcp_client.install.status.cli.detected', 'Detected {{command}}', { command: resolveMCPClientCommandName(selectedStatus) })
                  : copy('ai_chat.mcp_client.install.status.cli.not_detected', '{{command}} was not detected. Install or enable the client, add the command to PATH, and refresh before writing MCP configuration.', { command: resolveMCPClientCommandName(selectedStatus) }),
            })}
          </div>
          {selectedStatus?.clientPath && (
            <div style={{ fontSize: 12, color: overlayTheme.mutedText, lineHeight: 1.6, overflowWrap: 'anywhere' }}>
              {copy('ai_chat.mcp_client.install.status.command_path', 'Command path: {{path}}', { path: '' })}
              <code>{selectedStatus.clientPath}</code>
            </div>
          )}
          <div style={{ fontSize: 12, color: overlayTheme.mutedText, lineHeight: 1.7 }}>
            {copy('ai_chat.mcp_client.install.status.detection_result', 'Detection result: {{message}}', {
              message: selectedStatus?.message || copy('ai_chat.mcp_client.install.status.detection_missing', 'No connection status detected'),
            })}
          </div>
          {selectedStatus?.configPath && (
            <div style={{ fontSize: 12, color: overlayTheme.mutedText, lineHeight: 1.6, overflowWrap: 'anywhere' }}>
              {copy('ai_chat.mcp_client.install.status.config_file', 'Config file: {{path}}', { path: '' })}
              <code>{selectedStatus.configPath}</code>
            </div>
          )}
          {selectedCommandText && (
            <div style={{ fontSize: 12, color: overlayTheme.mutedText, lineHeight: 1.6, overflowWrap: 'anywhere' }}>
              {copy('ai_chat.mcp_client.install.status.launch_command', 'Launch command: {{command}}', { command: '' })}
              <code>{selectedCommandText}</code>
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Button size="small" icon={<ReloadOutlined />} loading={statusLoading} onClick={onRefreshStatus} style={{ borderRadius: 8 }}>
              {copy('ai_chat.mcp_client.install.status.refresh', 'Refresh status')}
            </Button>
            <Button size="small" icon={<CopyOutlined />} disabled={!selectedStatus?.configPath} onClick={onCopyConfigPath} style={{ borderRadius: 8 }}>
              {copy('ai_chat.mcp_client.install.status.copy_config', 'Copy config path')}
            </Button>
            <Button size="small" icon={<CopyOutlined />} disabled={!selectedCommandText} onClick={onCopyLaunchCommand} style={{ borderRadius: 8 }}>
              {copy('ai_chat.mcp_client.install.status.copy_command', 'Copy launch command')}
            </Button>
          </div>
        </div>
      </details>
    </div>
  );
};

export default AIMCPClientStatusPanel;
