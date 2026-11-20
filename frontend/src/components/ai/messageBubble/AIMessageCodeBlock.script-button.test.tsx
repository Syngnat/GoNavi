/** @vitest-environment jsdom */
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildOverlayWorkbenchTheme } from '../../../utils/overlayWorkbenchTheme';
import { SCRIPT_WORKBENCH_OPEN_EVENT } from '../../../utils/scriptWorkbenchTab';
import { AIMessageCodeBlock } from './AIMessageCodeBlock';

vi.mock('antd', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
  message: { success: vi.fn(), info: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

vi.mock('../../common/ResizableDraggableModal', () => ({
  default: Object.assign(() => null, { confirm: vi.fn() }),
}));

vi.mock('@ant-design/icons', () => ({
  CheckOutlined: () => null,
  CodeOutlined: () => null,
  CopyOutlined: () => null,
  PlayCircleOutlined: () => null,
  SwapOutlined: () => null,
}));

vi.mock('react-syntax-highlighter', () => ({ default: () => null }));

vi.mock('react-syntax-highlighter/dist/esm/prism-light', () => ({
  default: Object.assign(() => null, { registerLanguage: vi.fn() }),
}));

vi.mock('mermaid', () => ({
  default: { initialize: vi.fn(), render: vi.fn(async () => ({ svg: '<svg/>' })) },
}));

describe('AIMessageCodeBlock script workbench action', () => {
  let captured: Array<Record<string, unknown>>;
  let listener: ((event: Event) => void) | null = null;

  beforeEach(() => {
    captured = [];
    listener = (event: Event) => {
      captured.push((event as CustomEvent).detail);
    };
    window.addEventListener(SCRIPT_WORKBENCH_OPEN_EVENT, listener as EventListener);
  });

  afterEach(() => {
    if (listener) {
      window.removeEventListener(SCRIPT_WORKBENCH_OPEN_EVENT, listener as EventListener);
    }
  });

  it('opens JavaScript from an AI reply without executing it', () => {
    let renderer: ReactTestRenderer | undefined;
    act(() => {
      renderer = create(React.createElement(AIMessageCodeBlock, {
        className: 'language-javascript',
        darkMode: false,
        overlayTheme: buildOverlayWorkbenchTheme(false),
        activeConnectionId: 'conn-1',
        activeDbName: 'app',
        children: 'const ids = [1, 2, 3];',
      }));
    });
    const button = renderer!.root.findByProps({ className: 'ai-code-run-btn ai-code-script-btn' });
    act(() => button.props.onClick());
    act(() => renderer!.unmount());

    expect(captured).toEqual([{
      source: 'const ids = [1, 2, 3];',
      connectionId: 'conn-1',
      dbName: 'app',
      displayName: 'AI script',
    }]);
  });
});
