import React from 'react';
import { Button } from 'antd';

import type { AIMCPClientInstallStatus } from '../../types';
import {
  isLocalMCPClientUnavailable,
  isMCPClientConnected,
  isRemoteMCPClientStatus,
  type MCPClientKey,
} from '../../utils/mcpClientInstallStatus';
import { useOptionalI18n } from '../../i18n/provider';
import type { OverlayWorkbenchTheme } from '../../utils/overlayWorkbenchTheme';
import AIMCPClientSelectorPanel from './AIMCPClientSelectorPanel';
import AIMCPClientStatusPanel from './AIMCPClientStatusPanel';
import {
  getMCPClientDetectionSummary,
  resolveMCPClientInstallActionLabel,
  translateMCPClientInstallCopy,
} from './mcpClientInstallPanelState';

interface AIMCPClientInstallPanelProps {
  statuses: AIMCPClientInstallStatus[];
  selectedClient: MCPClientKey;
  selectedStatus?: AIMCPClientInstallStatus;
  selectedCommandText: string;
  darkMode: boolean;
  overlayTheme: OverlayWorkbenchTheme;
  cardBg: string;
  cardBorder: string;
  loading: boolean;
  statusLoading: boolean;
  onSelectClient: (client: MCPClientKey) => void;
  onRefreshStatus: () => void;
  onCopyConfigPath: () => void;
  onCopyLaunchCommand: () => void;
  onInstall: () => void;
}

const AIMCPClientInstallPanel: React.FC<AIMCPClientInstallPanelProps> = ({
  statuses,
  selectedClient,
  selectedStatus,
  selectedCommandText,
  darkMode,
  overlayTheme,
  cardBorder,
  loading,
  statusLoading,
  onSelectClient,
  onRefreshStatus,
  onCopyConfigPath,
  onCopyLaunchCommand,
  onInstall,
}) => {
  const i18n = useOptionalI18n();
  const t = i18n?.t;
  const copy = (
    key: string,
    fallback: string,
    params?: Record<string, string | number | boolean | null | undefined>,
  ) => translateMCPClientInstallCopy(t, key, fallback, params);
  const selectedIsRemoteClient = isRemoteMCPClientStatus(selectedStatus);
  const selectedLocalClientUnavailable = isLocalMCPClientUnavailable(selectedStatus);
  const selectedClientConnected = isMCPClientConnected(selectedStatus);

  return (
    <div className="gonavi-ai-mcp-client-panel" style={{ padding: '14px 0 8px', display: 'flex', flexDirection: 'column' }}>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
        }}
      >
        <AIMCPClientSelectorPanel
          statuses={statuses}
          selectedClient={selectedClient}
          darkMode={darkMode}
          overlayTheme={overlayTheme}
          cardBorder={cardBorder}
          statusLoading={statusLoading}
          onSelectClient={onSelectClient}
        />

        <AIMCPClientStatusPanel
          selectedStatus={selectedStatus}
          selectedCommandText={selectedCommandText}
          darkMode={darkMode}
          overlayTheme={overlayTheme}
          cardBorder={cardBorder}
          statusLoading={statusLoading}
          onRefreshStatus={onRefreshStatus}
          onCopyConfigPath={onCopyConfigPath}
          onCopyLaunchCommand={onCopyLaunchCommand}
        />

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
          <div
            className="gonavi-ai-mcp-line-clamp"
            title={`${getMCPClientDetectionSummary(selectedStatus, t)}${!selectedIsRemoteClient && !selectedLocalClientUnavailable ? ` ${copy(
              'ai_chat.mcp_client.install.repeat_avoidance',
              'When already connected to this GoNavi, the main button is disabled to avoid repeated writes.',
            )}` : ''}`}
            style={{ minWidth: 0, fontSize: 'var(--gn-font-size-sm, 12px)', color: overlayTheme.mutedText, lineHeight: 1.5 }}
          >
            {getMCPClientDetectionSummary(selectedStatus, t)}
            {!selectedIsRemoteClient && !selectedLocalClientUnavailable && (
              <>
                {' '}
                {copy(
                  'ai_chat.mcp_client.install.repeat_avoidance',
                  'When already connected to this GoNavi, the main button is disabled to avoid repeated writes.',
                )}
              </>
            )}
          </div>
          {selectedClientConnected ? (
            <span
              role="status"
              style={{
                padding: '3px 9px',
                borderRadius: 999,
                color: overlayTheme.selectedText,
                background: overlayTheme.selectedBg,
                fontSize: 'var(--gn-font-size-sm, 12px)',
                fontWeight: 700,
                lineHeight: 1.5,
                whiteSpace: 'nowrap',
                flexShrink: 0,
              }}
            >
              {resolveMCPClientInstallActionLabel(selectedStatus, t)}
            </span>
          ) : (
            <Button
              type="primary"
              onClick={onInstall}
              disabled={selectedLocalClientUnavailable}
              loading={loading}
              title={selectedLocalClientUnavailable ? getMCPClientDetectionSummary(selectedStatus, t) : undefined}
              style={{ fontWeight: 600, maxWidth: '44%', flexShrink: 0 }}
            >
              {resolveMCPClientInstallActionLabel(selectedStatus, t)}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
};

export default AIMCPClientInstallPanel;
