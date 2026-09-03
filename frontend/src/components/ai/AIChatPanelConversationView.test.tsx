import React, { createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { I18nProvider } from '../../i18n/provider';
import AIChatPanelConversationView from './AIChatPanelConversationView';
import { buildOverlayWorkbenchTheme } from '../../utils/overlayWorkbenchTheme';

const renderWithI18n = (node: React.ReactElement) =>
  renderToStaticMarkup(
    <I18nProvider preference="zh-CN" systemLanguages={['zh-CN']} onPreferenceChange={() => {}}>
      {node}
    </I18nProvider>,
  );

describe('AIChatPanelConversationView', () => {
  it('renders the welcome state when the chat mode has no messages', () => {
    const markup = renderWithI18n(
      <AIChatPanelConversationView
        mode="chat"
        messages={[]}
        darkMode={false}
        overlayTheme={buildOverlayWorkbenchTheme(false)}
        textColor="#0f172a"
        mutedColor="#64748b"
        quickActionBg="rgba(255,255,255,0.8)"
        quickActionBorder="1px solid rgba(0,0,0,0.06)"
        showScrollBottom={false}
        contextTableNames={['sales.orders']}
        isV2Ui
        insights={[]}
        sessions={[]}
        activeSessionId="session-1"
        activeConnectionId={undefined}
        activeConnectionConfig={undefined}
        activeDbName={undefined}
        messagesEndRef={createRef<HTMLDivElement>()}
        onScrollMessages={() => {}}
        onQuickAction={() => {}}
        onSelectSession={() => {}}
        onEditMessage={() => {}}
        onRetryMessage={() => {}}
        onDeleteMessage={() => {}}
        onMessageRenderError={() => {}}
        onScrollBottom={() => {}}
      />,
    );

    expect(markup).toContain('你好，我是 GoNavi AI');
    expect(markup).toContain('已自动关联');
    expect(markup).toContain('生成 SQL');
  });

  it('renders inline history mode content and the scroll-bottom affordance', () => {
    const markup = renderWithI18n(
      <AIChatPanelConversationView
        mode="history"
        messages={[]}
        darkMode={false}
        overlayTheme={buildOverlayWorkbenchTheme(false)}
        textColor="#0f172a"
        mutedColor="#64748b"
        quickActionBg="rgba(255,255,255,0.8)"
        quickActionBorder="1px solid rgba(0,0,0,0.06)"
        showScrollBottom
        contextTableNames={[]}
        isV2Ui
        insights={[]}
        sessions={[
          { id: 'session-1', title: '当前会话', updatedAt: 1710000000000 },
          { id: 'session-2', title: '旧会话', updatedAt: 1700000000000 },
        ]}
        activeSessionId="session-1"
        activeConnectionId={undefined}
        activeConnectionConfig={undefined}
        activeDbName={undefined}
        messagesEndRef={createRef<HTMLDivElement>()}
        onScrollMessages={() => {}}
        onQuickAction={() => {}}
        onSelectSession={() => {}}
        onArchiveSession={() => {}}
        onEditMessage={() => {}}
        onRetryMessage={() => {}}
        onDeleteMessage={() => {}}
        onMessageRenderError={() => {}}
        onScrollBottom={() => {}}
      />,
    );

    expect(markup).toContain('gn-v2-ai-history-card is-active');
    expect(markup).toContain('当前会话');
    expect(markup).toContain('旧会话');
    expect(markup).toContain('gn-v2-ai-history-delete');
    expect(markup).toContain('aria-label="删除"');
    expect(markup).toContain('down');
  });

  it('keeps Retry after a completed tool round because retry branches the transcript', () => {
    const markup = renderWithI18n(
      <AIChatPanelConversationView
        mode="chat"
        messages={[
          { id: 'user-1', role: 'user', content: '插入一行', timestamp: 1 },
          {
            id: 'assistant-call',
            role: 'assistant',
            content: '正在执行',
            timestamp: 2,
            tool_calls: [{
              id: 'call-insert',
              type: 'function',
              function: { name: 'execute_sql', arguments: '{"sql":"INSERT INTO t VALUES (1)"}' },
            }],
          },
          {
            id: 'tool-result',
            role: 'tool',
            content: '{"affectedRows":1}',
            timestamp: 3,
            tool_call_id: 'call-insert',
          },
          { id: 'assistant-final', role: 'assistant', content: '已插入', timestamp: 4 },
        ]}
        darkMode={false}
        overlayTheme={buildOverlayWorkbenchTheme(false)}
        textColor="#0f172a"
        mutedColor="#64748b"
        quickActionBg="rgba(255,255,255,0.8)"
        quickActionBorder="1px solid rgba(0,0,0,0.06)"
        showScrollBottom={false}
        contextTableNames={[]}
        isV2Ui
        insights={[]}
        sessions={[]}
        activeSessionId="session-1"
        messagesEndRef={createRef<HTMLDivElement>()}
        onScrollMessages={() => {}}
        onQuickAction={() => {}}
        onSelectSession={() => {}}
        onEditMessage={() => {}}
        onRetryMessage={() => {}}
        onDeleteMessage={() => {}}
        onMessageRenderError={() => {}}
        onScrollBottom={() => {}}
      />,
    );

    expect(markup).toContain('anticon-reload');
  });

  it('keeps Retry for a settled plain-text assistant turn without later tools', () => {
    const markup = renderWithI18n(
      <AIChatPanelConversationView
        mode="chat"
        messages={[
          { id: 'user-1', role: 'user', content: '解释查询', timestamp: 1 },
          { id: 'assistant-1', role: 'assistant', content: '查询说明', timestamp: 2 },
        ]}
        darkMode={false}
        overlayTheme={buildOverlayWorkbenchTheme(false)}
        textColor="#0f172a"
        mutedColor="#64748b"
        quickActionBg="rgba(255,255,255,0.8)"
        quickActionBorder="1px solid rgba(0,0,0,0.06)"
        showScrollBottom={false}
        contextTableNames={[]}
        isV2Ui
        insights={[]}
        sessions={[]}
        activeSessionId="session-1"
        messagesEndRef={createRef<HTMLDivElement>()}
        onScrollMessages={() => {}}
        onQuickAction={() => {}}
        onSelectSession={() => {}}
        onEditMessage={() => {}}
        onRetryMessage={() => {}}
        onDeleteMessage={() => {}}
        onMessageRenderError={() => {}}
        onScrollBottom={() => {}}
      />,
    );

    expect(markup).toContain('anticon-reload');
  });
});
