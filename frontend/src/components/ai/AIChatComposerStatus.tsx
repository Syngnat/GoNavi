import React from 'react';
import { Button } from 'antd';
import {
  CloseOutlined,
  CheckCircleFilled,
  ExclamationCircleFilled,
  LoadingOutlined,
} from '@ant-design/icons';

import { t as catalogTranslate } from '../../i18n/catalog';
import { useOptionalI18n } from '../../i18n/provider';
import type { OverlayWorkbenchTheme } from '../../utils/overlayWorkbenchTheme';
import type { AIComposerNoticeAction } from '../../utils/aiComposerNotice';
import type { AIChatReadinessSnapshot } from './aiChatReadiness';
import { aiPx } from './aiScale';

interface AIChatComposerStatusProps {
  snapshot: AIChatReadinessSnapshot;
  darkMode: boolean;
  overlayTheme: OverlayWorkbenchTheme;
  onAction?: (actionKey: AIComposerNoticeAction) => void;
  onDismiss?: () => void;
}

const resolvePalette = (
  severity: AIChatReadinessSnapshot['severity'],
  darkMode: boolean,
) => {
  if (severity === 'success') {
    return darkMode
      ? {
        background: 'rgba(34,197,94,0.12)',
        borderColor: 'rgba(34,197,94,0.24)',
        iconColor: '#4ade80',
        labelColor: '#86efac',
      }
      : {
        background: 'rgba(34,197,94,0.08)',
        borderColor: 'rgba(34,197,94,0.16)',
        iconColor: '#16a34a',
        labelColor: '#166534',
      };
  }
  if (severity === 'error') {
    return darkMode
      ? {
        background: 'rgba(255,120,117,0.12)',
        borderColor: 'rgba(255,120,117,0.24)',
        iconColor: '#ff7875',
        labelColor: '#ffb4b2',
      }
      : {
        background: 'rgba(255,77,79,0.08)',
        borderColor: 'rgba(255,77,79,0.16)',
        iconColor: '#ff4d4f',
        labelColor: '#991b1b',
      };
  }
  if (severity === 'info') {
    return darkMode
      ? {
        background: 'rgba(59,130,246,0.12)',
        borderColor: 'rgba(59,130,246,0.24)',
        iconColor: '#60a5fa',
        labelColor: '#93c5fd',
      }
      : {
        background: 'rgba(59,130,246,0.08)',
        borderColor: 'rgba(59,130,246,0.14)',
        iconColor: '#2563eb',
        labelColor: '#1d4ed8',
      };
  }
  return darkMode
    ? {
      background: 'rgba(250,173,20,0.12)',
      borderColor: 'rgba(250,173,20,0.22)',
      iconColor: '#ffd666',
      labelColor: '#ffe58f',
    }
    : {
      background: 'rgba(250,173,20,0.08)',
      borderColor: 'rgba(250,173,20,0.18)',
      iconColor: '#d48806',
      labelColor: '#92400e',
    };
};

const resolveIcon = (snapshot: AIChatReadinessSnapshot) => {
  if (snapshot.status === 'loading_models') {
    return <LoadingOutlined style={{ fontSize: aiPx(14) }} />;
  }
  if (snapshot.ready) {
    return <CheckCircleFilled style={{ fontSize: aiPx(14) }} />;
  }
  return <ExclamationCircleFilled style={{ fontSize: aiPx(14) }} />;
};

const AIChatComposerStatus: React.FC<AIChatComposerStatusProps> = ({
  snapshot,
  darkMode,
  overlayTheme,
  onAction,
  onDismiss,
}) => {
  const i18n = useOptionalI18n();
  const t = i18n?.t ?? ((key: string, params?: Record<string, string | number | boolean | null | undefined>) =>
    catalogTranslate('en-US', key, params));
  const palette = resolvePalette(snapshot.severity, darkMode);
  const handleAction = () => {
    if (snapshot.action && typeof onAction === 'function') {
      onAction(snapshot.action.key);
    }
  };
  const canDismiss = typeof onDismiss === 'function';

  return (
    <div
      data-ai-chat-composer-status="true"
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: 10,
        padding: '8px 10px',
        borderRadius: 12,
        background: palette.background,
        border: `1px solid ${palette.borderColor}`,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, minWidth: 0 }}>
        <div style={{ color: palette.iconColor, marginTop: 1, flexShrink: 0 }}>
          {resolveIcon(snapshot)}
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span
              style={{
                fontSize: aiPx(11),
                fontWeight: 700,
                padding: '2px 8px',
                borderRadius: 999,
                color: palette.labelColor,
                background: darkMode ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.72)',
              }}
            >
              {snapshot.label}
            </span>
            <span style={{ fontSize: aiPx(12), fontWeight: 600, color: overlayTheme.titleText }}>
              {snapshot.title}
            </span>
          </div>
          <div
            style={{
              fontSize: aiPx(11),
              color: overlayTheme.mutedText,
              lineHeight: 1.5,
              marginTop: 4,
              wordBreak: 'break-word',
            }}
          >
            {snapshot.description}
          </div>
        </div>
      </div>
      {(snapshot.action && typeof onAction === 'function') || canDismiss ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
          {snapshot.action && typeof onAction === 'function' && (
            <Button
              size="small"
              type="default"
              onClick={handleAction}
              style={{ borderRadius: 8 }}
            >
              {snapshot.action.label}
            </Button>
          )}
          {canDismiss && (
            <Button
              aria-label={t('ai_chat.input.status.dismiss_aria_label')}
              title={t('common.close')}
              size="small"
              type="text"
              icon={<CloseOutlined />}
              onClick={onDismiss}
              style={{ borderRadius: 8 }}
            />
          )}
        </div>
      ) : null}
    </div>
  );
};

export default AIChatComposerStatus;
