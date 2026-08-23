import React from 'react';
import { CheckCircleFilled } from '@ant-design/icons';
import type { AIMCPClientInstallStatus } from '../../types';
import {
  isLocalMCPClientUnavailable,
  isMCPClientKey,
  isRemoteMCPClientStatus,
  type MCPClientKey,
} from '../../utils/mcpClientInstallStatus';
import { useOptionalI18n } from '../../i18n/provider';
import type { OverlayWorkbenchTheme } from '../../utils/overlayWorkbenchTheme';
import {
  getMCPClientInstallStateLabel,
  getMCPClientOptionSummary,
  getMCPClientStatusTone,
  translateMCPClientInstallCopy,
} from './mcpClientInstallPanelState';

interface AIMCPClientSelectorPanelProps {
  statuses: AIMCPClientInstallStatus[];
  selectedClient: MCPClientKey;
  darkMode: boolean;
  overlayTheme: OverlayWorkbenchTheme;
  cardBorder: string;
  statusLoading: boolean;
  onSelectClient: (client: MCPClientKey) => void;
}

const MCP_CLIENT_INSTALL_STEPS = [
  {
    step: '1',
    titleKey: 'ai_chat.mcp_client.install.selector.step.target.title',
    titleFallback: 'Choose target client',
    detailKey: 'ai_chat.mcp_client.install.selector.step.target.detail',
    detailFallback: 'Detected local Claude Code, Codex, OpenCode, ZCode, DeepSeek Harness, Kimi Code, and Grok Build clients can be configured automatically. OpenClaw/Hermans use remote connection guidance.',
  },
  {
    step: '2',
    titleKey: 'ai_chat.mcp_client.install.selector.step.write.title',
    titleFallback: 'Write or copy config',
    detailKey: 'ai_chat.mcp_client.install.selector.step.write.detail',
    detailFallback: 'After local CLI detection, automatic install only changes user-level MCP config. Remote Agents copy bridge guidance.',
  },
  {
    step: '3',
    titleKey: 'ai_chat.mcp_client.install.selector.step.restart.title',
    titleFallback: 'Restart or configure target',
    detailKey: 'ai_chat.mcp_client.install.selector.step.restart.detail',
    detailFallback: 'Restart the local CLI to verify. Cloud Agents verify after configuring the remote MCP URL.',
  },
];

const AIMCPClientSelectorPanel: React.FC<AIMCPClientSelectorPanelProps> = ({
  statuses,
  selectedClient,
  darkMode,
  overlayTheme,
  statusLoading,
  onSelectClient,
}) => {
  const i18n = useOptionalI18n();
  const t = i18n?.t;
  const copy = (
    key: string,
    fallback: string,
    params?: Record<string, string | number | boolean | null | undefined>,
  ) => translateMCPClientInstallCopy(t, key, fallback, params);
  const selectedStatusIndex = Math.max(
    0,
    statuses.findIndex((status) => isMCPClientKey(status.client) && status.client === selectedClient),
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        <div style={{ fontWeight: 700, fontSize: 14, color: overlayTheme.titleText }}>
          {copy('ai_chat.mcp_client.install.selector.title', 'Connect external client')}
        </div>
        <div className="gonavi-ai-mcp-line-clamp" style={{ fontSize: 12, color: overlayTheme.mutedText, lineHeight: 1.6 }}>
          {copy(
            'ai_chat.mcp_client.install.selector.description',
            'Choose one target client first. GoNavi writes or updates a local MCP config only after it detects that client\'s CLI; remote Agents must access current GoNavi through an MCP bridge or tunnel and should not store database passwords.',
          )}
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
        <div style={{ fontWeight: 700, fontSize: 12, color: overlayTheme.titleText }}>
          {copy('ai_chat.mcp_client.install.selector.choice_title', 'Select external client')}
        </div>
        <div
          className="gonavi-ai-mcp-client-options"
          role="radiogroup"
          aria-label={copy('ai_chat.mcp_client.install.selector.aria_label', 'Select the external client for GoNavi MCP')}
        >
          {statuses.map((status, statusIndex) => {
            const client = isMCPClientKey(status.client) ? status.client : 'claude-code';
            const remoteClient = isRemoteMCPClientStatus(status);
            const localClientUnavailable = isLocalMCPClientUnavailable(status);
            const active = selectedClient === client;
            const tone = getMCPClientStatusTone(status, darkMode, t);
            const optionSummary = getMCPClientOptionSummary(status, t);
            const optionState = getMCPClientInstallStateLabel(status, t);
            const optionHint = active
              ? (remoteClient
                ? copy('ai_chat.mcp_client.install.selector.hint.active_remote', 'Selected. The remote connection guide will be copied.')
                : localClientUnavailable
                  ? copy('ai_chat.mcp_client.install.selector.hint.active_local_unavailable', 'Selected. Install or enable this client and refresh detection before GoNavi can write its MCP config.')
                  : copy('ai_chat.mcp_client.install.selector.hint.active_local', 'Selected. Only this client will be written or updated.'))
              : (remoteClient
                ? copy('ai_chat.mcp_client.install.selector.hint.inactive_remote', 'Click to view the remote connection method.')
                : copy('ai_chat.mcp_client.install.selector.hint.inactive_local', 'Click to switch to this client.'));
            return (
              <button
                className={`gonavi-ai-mcp-client-option${active ? ' is-active' : ''}`}
                key={status.client}
                type="button"
                role="radio"
                aria-label={`${status.displayName}, ${tone.label}`}
                aria-checked={active}
                tabIndex={statusIndex === selectedStatusIndex ? 0 : -1}
                title={`${optionSummary}\n${optionState}\n${optionHint}`}
                onClick={() => onSelectClient(client)}
                onKeyDown={(event) => {
                  if (!['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
                    return;
                  }
                  event.preventDefault();
                  const nextIndex = event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                      ? statuses.length - 1
                      : event.key === 'ArrowRight' || event.key === 'ArrowDown'
                        ? (statusIndex + 1) % statuses.length
                        : (statusIndex - 1 + statuses.length) % statuses.length;
                  const nextStatus = statuses[nextIndex];
                  onSelectClient(isMCPClientKey(nextStatus.client) ? nextStatus.client : 'claude-code');
                  const radios = event.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="radio"]');
                  radios?.[nextIndex]?.focus();
                }}
                style={{
                  opacity: statusLoading ? 0.72 : 1,
                }}
              >
                <span className="gonavi-ai-mcp-client-name" style={{ fontWeight: 700, fontSize: 12, color: overlayTheme.titleText }}>
                  {status.displayName}
                </span>
                <span className="gonavi-ai-mcp-client-option-state">
                  {active && (
                    <CheckCircleFilled
                      className="gonavi-ai-mcp-client-check"
                      style={{ color: overlayTheme.selectedText }}
                      aria-hidden
                    />
                  )}
                  <span
                    className="gonavi-ai-mcp-client-state"
                    title={tone.label}
                    style={{
                      color: tone.color,
                      fontSize: 'var(--gn-font-size-sm, 12px)',
                      fontWeight: 700,
                      lineHeight: 1,
                      whiteSpace: 'nowrap',
                      flexShrink: 0,
                    }}
                  >
                    {tone.label}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <details className="gonavi-ai-mcp-disclosure gonavi-ai-mcp-client-guide-disclosure">
        <summary>
          <span style={{ fontWeight: 700, color: overlayTheme.titleText }}>
            {copy('ai_chat.mcp_client.install.guide_summary', 'Connection flow and safety notes')}
          </span>
          <span className="gonavi-ai-mcp-summary-note" style={{ color: overlayTheme.mutedText }}>
            {copy(
              'ai_chat.mcp_client.install.intro.description',
              'After their local command is detected, Claude Code, Codex, OpenCode, ZCode, DeepSeek Harness, Kimi Code, and Grok Build can receive a user-level MCP config. Cloud Agents such as OpenClaw and Hermans use remote connection guidance so database passwords are not copied to the cloud.',
            )}
          </span>
        </summary>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '4px 0 10px' }}>
          <div style={{ fontWeight: 700, fontSize: 12, color: overlayTheme.titleText, lineHeight: 1.6 }}>
            {copy(
              'ai_chat.mcp_client.install.intro.title',
              'This connects GoNavi MCP to supported local clients or remote Agents for external tool calls. It is not installing a plugin into GoNavi itself.',
            )}
          </div>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
              gap: 10,
            }}
          >
            {MCP_CLIENT_INSTALL_STEPS.map((item) => (
              <div key={item.step} style={{ display: 'flex', gap: 8, minWidth: 0 }}>
                <div
                  style={{
                    width: 20,
                    height: 20,
                    borderRadius: 999,
                    background: overlayTheme.selectedText,
                    color: '#fff',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 'var(--gn-font-size-sm, 12px)',
                    fontWeight: 700,
                    flexShrink: 0,
                  }}
                >
                  {item.step}
                </div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 12, color: overlayTheme.titleText }}>
                    {copy(item.titleKey, item.titleFallback)}
                  </div>
                  <div style={{ marginTop: 3, fontSize: 'var(--gn-font-size-sm, 12px)', color: overlayTheme.mutedText, lineHeight: 1.55 }}>
                    {copy(item.detailKey, item.detailFallback)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </details>
    </div>
  );
};

export default AIMCPClientSelectorPanel;
