import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { AIMessageMarkdown } from './AIMessageMarkdown';
import { AIThinkingBlock, AIToolCallingBlock } from './AIMessageStatusBlocks';
import { I18nProvider } from '../../../i18n/provider';
import { buildOverlayWorkbenchTheme } from '../../../utils/overlayWorkbenchTheme';

vi.mock('antd', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
  Modal: Object.assign(
    ({ children, open }: { children?: React.ReactNode; open?: boolean }) => (open ? <div>{children}</div> : null),
    {
      info: vi.fn(),
      success: vi.fn(),
      error: vi.fn(),
      warning: vi.fn(),
      confirm: vi.fn(),
    },
  ),
  message: { error: vi.fn() },
}));

vi.mock('@ant-design/icons', () => ({
  ApiOutlined: () => null,
  CaretDownOutlined: () => null,
  CaretRightOutlined: () => null,
  CheckOutlined: () => null,
  CopyOutlined: () => null,
  PlayCircleOutlined: () => null,
}));

describe('AIMessageMarkdown', () => {
  it('renders SQL code block actions through English fallback copy without an i18n provider', () => {
    const markup = renderToStaticMarkup(
      <AIMessageMarkdown
        content={'```sql\nSELECT * FROM users;\n```'}
        darkMode={false}
        overlayTheme={buildOverlayWorkbenchTheme(false)}
        activeConnectionConfig={{ type: 'mysql', driver: 'mysql' }}
        activeConnectionId="conn-1"
        activeDbName="demo"
      />,
    );

    expect(markup).toContain('Copy code');
    expect(markup).toContain('Insert');
    expect(markup).toContain('Execute');
    expect(markup).toContain('Preview');
    expect(markup).toMatch(/<span class="token"[^>]*>SELECT<\/span>/);
  });

  it('renders SQL code block actions in Chinese when an i18n provider is available', () => {
    const markup = renderToStaticMarkup(
      <I18nProvider preference="zh-CN" systemLanguages={['zh-CN']} onPreferenceChange={() => {}}>
        <AIMessageMarkdown
          content={'```sql\nSELECT * FROM users;\n```'}
          darkMode={false}
          overlayTheme={buildOverlayWorkbenchTheme(false)}
          activeConnectionConfig={{ type: 'mysql', driver: 'mysql' }}
          activeConnectionId="conn-1"
          activeDbName="demo"
        />
      </I18nProvider>,
    );

    expect(markup).toContain('复制代码');
    expect(markup).toContain('插入');
    expect(markup).toContain('执行');
    expect(markup).toContain('预览');
  });

  it('can switch between fenced code renderers without changing hook order', () => {
    const overlayTheme = buildOverlayWorkbenchTheme(false);
    let renderer: ReactTestRenderer | undefined;

    try {
      expect(() => {
        act(() => {
          renderer = create(
            <AIMessageMarkdown
              content={'```python\nprint("hello")\n```'}
              darkMode={false}
              overlayTheme={overlayTheme}
            />,
          );
        });
        act(() => {
          renderer?.update(
            <AIMessageMarkdown
              content={'```mermaid\ngraph TD;\nA-->B;\n```'}
              darkMode={false}
              overlayTheme={overlayTheme}
            />,
          );
        });
        act(() => {
          renderer?.update(
            <AIMessageMarkdown
              content={'普通 `inline` 代码'}
              darkMode={false}
              overlayTheme={overlayTheme}
            />,
          );
        });
      }).not.toThrow();
    } finally {
      act(() => {
        renderer?.unmount();
      });
    }
  });
});

describe('AIMessageStatusBlocks', () => {
  it('renders thinking and tool status copy through English fallback without an i18n provider', () => {
    const overlayTheme = buildOverlayWorkbenchTheme(false);
    const thinkingMarkup = renderToStaticMarkup(
      <AIThinkingBlock
        displayThinking="checking"
        isTyping={false}
        isGlobalLoading={false}
        darkMode={false}
        overlayTheme={overlayTheme}
        hasContent
      />,
    );
    const toolMarkup = renderToStaticMarkup(
      <AIToolCallingBlock
        toolCalls={[{
          id: 'call-1',
          type: 'function',
          function: { name: 'inspect_ai_runtime', arguments: '{}' },
        }]}
        loading={false}
        toolResultsById={new Map([['call-1', {
          id: 'tool-1',
          role: 'tool',
          content: 'result payload',
          timestamp: 1,
          tool_call_id: 'call-1',
          tool_name: 'inspect_ai_runtime',
        }]])}
        darkMode={false}
        overlayTheme={overlayTheme}
        hasContent={false}
      />,
    );

    expect(thinkingMarkup).toContain('Thinking process');
    expect(thinkingMarkup).toContain('(8 chars)');
    expect(toolMarkup).toContain('Data probes completed (1 items)');
    expect(toolMarkup).toContain('Read current AI runtime status');
    expect(toolMarkup).toContain('Probe result');
    expect(toolMarkup).toContain('14 chars');
  });

  it('renders thinking and tool status copy in Chinese when an i18n provider is available', () => {
    const overlayTheme = buildOverlayWorkbenchTheme(false);
    const markup = renderToStaticMarkup(
      <I18nProvider preference="zh-CN" systemLanguages={['zh-CN']} onPreferenceChange={() => {}}>
        <AIThinkingBlock
          displayThinking="checking"
          isTyping={false}
          isGlobalLoading={false}
          darkMode={false}
          overlayTheme={overlayTheme}
          hasContent
        />
        <AIToolCallingBlock
          toolCalls={[{
            id: 'call-1',
            type: 'function',
            function: { name: 'inspect_ai_runtime', arguments: '{}' },
          }]}
          loading={false}
          toolResultsById={new Map([['call-1', {
            id: 'tool-1',
            role: 'tool',
            content: 'result payload',
            timestamp: 1,
            tool_call_id: 'call-1',
            tool_name: 'inspect_ai_runtime',
          }]])}
          darkMode={false}
          overlayTheme={overlayTheme}
          hasContent={false}
        />
      </I18nProvider>,
    );

    expect(markup).toContain('思考过程');
    expect(markup).toContain('(8 字)');
    expect(markup).toContain('数据探针执行完毕 (1 项)');
    expect(markup).toContain('读取当前 AI 运行状态');
    expect(markup).toContain('探针执行结果');
    expect(markup).toContain('14 个字符');
  });
});
