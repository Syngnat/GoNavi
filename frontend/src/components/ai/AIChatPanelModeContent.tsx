import React from 'react';
import {
  DatabaseOutlined,
  DeleteOutlined,
  HistoryOutlined,
  TableOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { useI18n } from '../../i18n/provider';

export type AIChatPanelMode = 'chat' | 'insights' | 'history';

export interface AIChatInsightItem {
  tone: 'info' | 'accent' | 'warn';
  title: string;
  body: string;
}

export interface AIChatInlineHistorySession {
  id: string;
  title: string;
  updatedAt: number;
  revision?: number;
}

interface AIChatPanelModeContentProps {
  mode: AIChatPanelMode;
  insights: AIChatInsightItem[];
  sessions: AIChatInlineHistorySession[];
  activeSessionId: string;
  sessionActionsDisabled?: boolean;
  onSelectSession: (sessionId: string) => void;
  onArchiveSession?: (session: AIChatInlineHistorySession) => Promise<void> | void;
}

const renderInsightIcon = (tone: AIChatInsightItem['tone']) => {
  if (tone === 'warn') {
    return <WarningOutlined />;
  }
  if (tone === 'accent') {
    return <DatabaseOutlined />;
  }
  return <TableOutlined />;
};

const AIChatPanelModeContent: React.FC<AIChatPanelModeContentProps> = ({
  mode,
  insights,
  sessions,
  activeSessionId,
  sessionActionsDisabled = false,
  onSelectSession,
  onArchiveSession,
}) => {
  const { t } = useI18n();

  if (mode === 'insights') {
    return (
      <div className="gn-v2-ai-insights-list">
        {insights.map((item) => (
          <div className={`gn-v2-ai-insight-card tone-${item.tone}`} key={item.title}>
            <span className="gn-v2-ai-insight-icon">{renderInsightIcon(item.tone)}</span>
            <div>
              <strong>{item.title}</strong>
              <p>{item.body}</p>
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (mode === 'history') {
    if (sessions.length === 0) {
      return (
        <div className="gn-v2-ai-history-list">
          <div className="gn-v2-ai-empty-note">{t('ai_chat.panel.history.empty')}</div>
        </div>
      );
    }

    return (
      <div className="gn-v2-ai-history-list">
        {sessions.map((session) => (
          <div className="gn-v2-ai-history-row" key={session.id}>
            <button
              type="button"
              className={`gn-v2-ai-history-card${session.id === activeSessionId ? ' is-active' : ''}`}
              disabled={sessionActionsDisabled}
              onClick={() => onSelectSession(session.id)}
            >
              <span>
                <HistoryOutlined />
                <strong>{session.title || t('ai_chat.panel.session.default_title')}</strong>
              </span>
              <small>
                {new Date(session.updatedAt).toLocaleString(undefined, {
                  month: 'numeric',
                  day: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </small>
            </button>
            {onArchiveSession && (
              <button
                type="button"
                className="gn-v2-ai-history-delete"
                aria-label={t('ai_chat.history.tooltip.delete')}
                title={t('ai_chat.history.tooltip.delete')}
                disabled={sessionActionsDisabled}
                onClick={() => {
                  void Promise.resolve(onArchiveSession(session)).catch((error) => {
                    console.warn('Failed to archive AI agent session', error);
                  });
                }}
              >
                <DeleteOutlined />
              </button>
            )}
          </div>
        ))}
      </div>
    );
  }

  return null;
};

export default AIChatPanelModeContent;
