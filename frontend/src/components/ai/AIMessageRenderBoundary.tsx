import React from 'react';

import { t as catalogTranslate } from '../../i18n/catalog';
import { useOptionalI18n } from '../../i18n/provider';
import type { AIChatMessage } from '../../types';
import type { OverlayWorkbenchTheme } from '../../utils/overlayWorkbenchTheme';

interface AIMessageRenderBoundaryProps {
  children: React.ReactNode;
  msg: AIChatMessage;
  darkMode: boolean;
  overlayTheme: OverlayWorkbenchTheme;
  onDeleteMessage?: (id: string) => void;
  onError?: (error: Error, errorInfo: React.ErrorInfo, msg: AIChatMessage) => void;
  copy?: (key: string) => string;
}

interface AIMessageRenderBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class AIMessageRenderBoundary extends React.Component<
  AIMessageRenderBoundaryProps,
  AIMessageRenderBoundaryState
> {
  constructor(props: AIMessageRenderBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): AIMessageRenderBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    this.props.onError?.(error, errorInfo, this.props.msg);
  }

  private handleRetryRender = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      const { msg, darkMode, overlayTheme, onDeleteMessage } = this.props;
      const copy = this.props.copy ?? ((key: string) => catalogTranslate('en-US', key));
      return (
        <div className="ai-ide-message" style={{ borderBottom: 'none', padding: '8px 16px' }}>
          <div style={{
            background: darkMode ? 'rgba(239,68,68,0.08)' : 'rgba(239,68,68,0.05)',
            border: `1px solid ${darkMode ? 'rgba(248,113,113,0.32)' : 'rgba(239,68,68,0.18)'}`,
            borderRadius: 12,
            padding: '14px 16px',
          }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: overlayTheme.titleText }}>
              {copy('ai_chat.message.render_error.title')}
            </div>
            <div style={{ marginTop: 6, fontSize: 12, lineHeight: 1.6, color: overlayTheme.mutedText }}>
              {copy('ai_chat.message.render_error.body')}
            </div>
            <div style={{
              marginTop: 10,
              padding: '8px 10px',
              borderRadius: 8,
              background: darkMode ? 'rgba(0,0,0,0.18)' : 'rgba(0,0,0,0.03)',
              fontSize: 12,
              color: overlayTheme.titleText,
              wordBreak: 'break-word',
              whiteSpace: 'pre-wrap',
            }}>
              {this.state.error?.message || copy('ai_chat.message.render_error.unknown')}
            </div>
            <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
              <button
                type="button"
                onClick={this.handleRetryRender}
                style={{
                  border: overlayTheme.sectionBorder,
                  background: 'transparent',
                  color: overlayTheme.titleText,
                  borderRadius: 8,
                  padding: '6px 12px',
                  cursor: 'pointer',
                }}
              >
                {copy('ai_chat.message.render_error.retry')}
              </button>
              {onDeleteMessage ? (
                <button
                  type="button"
                  onClick={() => onDeleteMessage(msg.id)}
                  style={{
                    border: '1px solid rgba(239,68,68,0.28)',
                    background: darkMode ? 'rgba(239,68,68,0.08)' : 'rgba(239,68,68,0.05)',
                    color: '#ef4444',
                    borderRadius: 8,
                    padding: '6px 12px',
                    cursor: 'pointer',
                  }}
                >
                  {copy('ai_chat.message.render_error.delete')}
                </button>
              ) : null}
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

const AIMessageRenderBoundaryWithI18n: React.FC<AIMessageRenderBoundaryProps> = (props) => {
  const i18n = useOptionalI18n();
  const copy = i18n?.t ?? ((key: string) => catalogTranslate('en-US', key));
  return <AIMessageRenderBoundary {...props} copy={copy} />;
};

export default AIMessageRenderBoundaryWithI18n;
