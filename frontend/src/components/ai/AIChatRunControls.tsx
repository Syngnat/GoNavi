import React from 'react';
import { Button, Tag, Tooltip } from 'antd';
import {
  CheckCircleOutlined,
  CheckOutlined,
  CloseCircleOutlined,
  CloudSyncOutlined,
  ExclamationCircleOutlined,
  ReloadOutlined,
  StopOutlined,
} from '@ant-design/icons';

import { t as catalogTranslate } from '../../i18n/catalog';
import { useOptionalI18n } from '../../i18n/provider';
import type { I18nParams } from '../../i18n/types';
import type { OverlayWorkbenchTheme } from '../../utils/overlayWorkbenchTheme';
import type {
  AIRunApprovalState,
  AIRunRecoveryState,
  AIRunWorkspaceState,
} from './aiRunEventProjection';

export type AIRunRecoveryAction = 'recover' | 'mark_completed' | 'abort_recovery';
export type AIRunWorkspaceAction = 'use_stale_workspace';

export interface AIChatRunControlsProps {
  approvals: AIRunApprovalState[];
  recoveries: AIRunRecoveryState[];
  waitingWorkspaces: AIRunWorkspaceState[];
  darkMode: boolean;
  textColor: string;
  mutedColor: string;
  overlayTheme: OverlayWorkbenchTheme;
  busyKey?: string | null;
  onApprovalDecision: (
    approval: AIRunApprovalState,
    decision: 'approved' | 'denied',
  ) => void;
  onRecoveryAction: (recovery: AIRunRecoveryState, action: AIRunRecoveryAction) => void;
  onWorkspaceAction: (workspace: AIRunWorkspaceState, action: AIRunWorkspaceAction) => void;
}

const copyWithFallback = (
  copy: (key: string, params?: I18nParams) => string,
  key: string,
  fallback: string,
  params?: I18nParams,
): string => {
  const translated = copy(key, params);
  return translated && translated !== key ? translated : fallback;
};

const ControlMeta: React.FC<{
  toolName?: string;
  effect?: string;
  callId?: string;
  mutedColor: string;
  copy: (key: string, params?: I18nParams) => string;
}> = ({ toolName, effect, callId, mutedColor, copy }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', minWidth: 0 }}>
    {toolName ? <code style={{ color: mutedColor, fontSize: 12 }}>{toolName}</code> : null}
    {effect ? <Tag color="orange" style={{ margin: 0 }}>{effect}</Tag> : null}
    {callId ? (
      <Tooltip title={copy('ai_chat.run.control.call_id_tooltip', { callId })}>
        <code style={{ color: mutedColor, fontSize: 11, maxWidth: 170, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {copy('ai_chat.run.control.call_id', { callId })}
        </code>
      </Tooltip>
    ) : null}
  </div>
);

const AIChatRunControls: React.FC<AIChatRunControlsProps> = ({
  approvals,
  recoveries,
  waitingWorkspaces,
  darkMode,
  textColor,
  mutedColor,
  overlayTheme,
  busyKey = null,
  onApprovalDecision,
  onRecoveryAction,
  onWorkspaceAction,
}) => {
  const i18n = useOptionalI18n();
  const copy = i18n?.t ?? ((key: string, params?: I18nParams) => catalogTranslate('en-US', key, params));
  if (approvals.length === 0 && recoveries.length === 0 && waitingWorkspaces.length === 0) return null;

  const panelBackground = darkMode ? 'rgba(255, 255, 255, 0.045)' : 'rgba(0, 0, 0, 0.025)';
  const borderColor = darkMode ? 'rgba(255, 255, 255, 0.12)' : 'rgba(0, 0, 0, 0.1)';

  return (
    <div className="ai-run-controls" aria-live="polite">
      {approvals.map((approval) => {
        const approveKey = `${approval.runId}:approve:${approval.approvalId}`;
        const denyKey = `${approval.runId}:deny:${approval.approvalId}`;
        return (
          <section
            className="ai-run-control-card ai-run-approval-card"
            key={`${approval.runId}:${approval.approvalId}`}
            data-testid={`ai-run-approval-${approval.approvalId}`}
            style={{
              background: panelBackground,
              border: `1px solid ${borderColor}`,
              borderLeft: `3px solid ${overlayTheme.iconColor}`,
              color: textColor,
            }}
          >
            <div className="ai-run-control-heading">
              <span className="ai-run-control-title">
                <ExclamationCircleOutlined style={{ color: overlayTheme.iconColor }} />
                {copyWithFallback(copy, 'ai_chat.run.approval.title', 'Approval required')}
              </span>
              <span className="ai-run-control-state" style={{ color: mutedColor }}>
                {copyWithFallback(copy, 'ai_chat.run.approval.pending', 'Waiting')}
              </span>
            </div>
            <ControlMeta
              toolName={approval.toolName}
              effect={approval.effect}
              callId={approval.callId}
              mutedColor={mutedColor}
              copy={copy}
            />
            {approval.summary ? <div className="ai-run-control-detail" style={{ color: mutedColor }}>{approval.summary}</div> : null}
            <div className="ai-run-control-actions">
              <Button
                size="small"
                type="primary"
                icon={<CheckOutlined />}
                loading={busyKey === approveKey}
                disabled={Boolean(busyKey) && busyKey !== approveKey}
                onClick={() => onApprovalDecision(approval, 'approved')}
              >
                {copyWithFallback(copy, 'ai_chat.run.approval.approve', 'Approve')}
              </Button>
              <Button
                size="small"
                danger
                icon={<CloseCircleOutlined />}
                loading={busyKey === denyKey}
                disabled={Boolean(busyKey) && busyKey !== denyKey}
                onClick={() => onApprovalDecision(approval, 'denied')}
              >
                {copyWithFallback(copy, 'ai_chat.run.approval.deny', 'Deny')}
              </Button>
            </div>
          </section>
        );
      })}

      {recoveries.map((recovery) => {
        const retryKey = `${recovery.runId}:recover`;
        const completeKey = `${recovery.runId}:mark_completed`;
        const abortKey = `${recovery.runId}:abort_recovery`;
        const detail = recovery.reason || recovery.errorCode || recovery.status;
        return (
          <section
            className="ai-run-control-card ai-run-recovery-card"
            key={`${recovery.runId}:${recovery.callId || 'recovery'}`}
            data-testid={`ai-run-recovery-${recovery.runId}`}
            style={{
              background: panelBackground,
              border: `1px solid ${borderColor}`,
              borderLeft: '3px solid #faad14',
              color: textColor,
            }}
          >
            <div className="ai-run-control-heading">
              <span className="ai-run-control-title">
                <ExclamationCircleOutlined style={{ color: '#faad14' }} />
                {copyWithFallback(copy, 'ai_chat.run.recovery.title', 'Recovery required')}
              </span>
              <span className="ai-run-control-state" style={{ color: mutedColor }}>
                {copyWithFallback(copy, 'ai_chat.run.recovery.unknown_outcome', 'Outcome unknown')}
              </span>
            </div>
            <ControlMeta
              toolName={recovery.toolName}
              effect={recovery.effect}
              callId={recovery.callId}
              mutedColor={mutedColor}
              copy={copy}
            />
            {detail ? <div className="ai-run-control-detail" style={{ color: mutedColor }}>{detail}</div> : null}
            <div className="ai-run-control-actions">
              <Button
                size="small"
                type="primary"
                icon={<ReloadOutlined />}
                loading={busyKey === retryKey}
                disabled={Boolean(busyKey) && busyKey !== retryKey}
                onClick={() => onRecoveryAction(recovery, 'recover')}
              >
                {copyWithFallback(copy, 'ai_chat.run.recovery.retry', 'Retry')}
              </Button>
              <Button
                size="small"
                icon={<CheckCircleOutlined />}
                loading={busyKey === completeKey}
                disabled={Boolean(busyKey) && busyKey !== completeKey}
                onClick={() => onRecoveryAction(recovery, 'mark_completed')}
              >
                {copyWithFallback(copy, 'ai_chat.run.recovery.mark_completed', 'Mark completed')}
              </Button>
              <Button
                size="small"
                danger
                icon={<StopOutlined />}
                loading={busyKey === abortKey}
                disabled={Boolean(busyKey) && busyKey !== abortKey}
                onClick={() => onRecoveryAction(recovery, 'abort_recovery')}
              >
                {copyWithFallback(copy, 'ai_chat.run.recovery.abort', 'Abort')}
              </Button>
            </div>
          </section>
        );
      })}

      {waitingWorkspaces.map((workspace) => {
        const useStaleKey = `${workspace.runId}:use_stale_workspace`;
        return (
          <section
            className="ai-run-control-card ai-run-workspace-card"
            key={`${workspace.runId}:workspace`}
            data-testid={`ai-run-workspace-${workspace.runId}`}
            style={{
              background: panelBackground,
              border: `1px solid ${borderColor}`,
              borderLeft: '3px solid #1677ff',
              color: textColor,
            }}
          >
            <div className="ai-run-control-heading">
              <span className="ai-run-control-title">
                <CloudSyncOutlined style={{ color: '#1677ff' }} />
                {copyWithFallback(copy, 'ai_chat.run.workspace.title', 'Workspace unavailable')}
              </span>
              <span className="ai-run-control-state" style={{ color: mutedColor }}>
                {copyWithFallback(copy, 'ai_chat.run.workspace.waiting', 'Waiting')}
              </span>
            </div>
            <div className="ai-run-control-detail" style={{ color: mutedColor }}>
              {copyWithFallback(
                copy,
                'ai_chat.run.workspace.detail',
                'Reconnect the workspace, or explicitly use its last saved snapshot.',
              )}
            </div>
            <div className="ai-run-control-actions">
              <Button
                size="small"
                icon={<ReloadOutlined />}
                loading={busyKey === useStaleKey}
                disabled={Boolean(busyKey) && busyKey !== useStaleKey}
                onClick={() => onWorkspaceAction(workspace, 'use_stale_workspace')}
              >
                {copyWithFallback(copy, 'ai_chat.run.workspace.use_stale', 'Use saved snapshot')}
              </Button>
            </div>
          </section>
        );
      })}
    </div>
  );
};

export default AIChatRunControls;
