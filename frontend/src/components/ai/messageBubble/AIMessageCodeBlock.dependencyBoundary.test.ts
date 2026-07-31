import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import viteConfig from '../../../../vite.config';
import { buildOverlayWorkbenchTheme } from '../../../utils/overlayWorkbenchTheme';
import { AIMessageCodeBlock } from './AIMessageCodeBlock';

const dependencyMocks = vi.hoisted(() => ({
  completeRegistryLoad: vi.fn(),
  mermaidInitialize: vi.fn(),
  mermaidLoad: vi.fn(),
  mermaidRender: vi.fn(async () => ({ svg: '<svg>diagram</svg>' })),
  prismLightLoad: vi.fn(),
  registerLanguage: vi.fn(),
}));

vi.mock('react-syntax-highlighter', () => {
  dependencyMocks.completeRegistryLoad();
  return { default: () => null };
});

vi.mock('react-syntax-highlighter/dist/esm/prism-light', () => {
  dependencyMocks.prismLightLoad();
  return {
    default: Object.assign(() => null, {
      registerLanguage: dependencyMocks.registerLanguage,
    }),
  };
});

vi.mock('mermaid', () => {
  dependencyMocks.mermaidLoad();
  return {
    default: {
      initialize: dependencyMocks.mermaidInitialize,
      render: dependencyMocks.mermaidRender,
    },
  };
});

vi.mock('antd', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
  message: { error: vi.fn() },
}));

vi.mock('@ant-design/icons', () => ({
  CheckOutlined: () => null,
  CopyOutlined: () => null,
  PlayCircleOutlined: () => null,
}));

vi.mock('../../common/ResizableDraggableModal', () => ({
  default: Object.assign(() => null, { confirm: vi.fn() }),
}));

const codeHighlightDependencies = [
  'react-syntax-highlighter/dist/esm/prism-light',
  'react-syntax-highlighter/dist/esm/languages/prism/bash',
  'react-syntax-highlighter/dist/esm/languages/prism/css',
  'react-syntax-highlighter/dist/esm/languages/prism/diff',
  'react-syntax-highlighter/dist/esm/languages/prism/go',
  'react-syntax-highlighter/dist/esm/languages/prism/ini',
  'react-syntax-highlighter/dist/esm/languages/prism/java',
  'react-syntax-highlighter/dist/esm/languages/prism/javascript',
  'react-syntax-highlighter/dist/esm/languages/prism/json',
  'react-syntax-highlighter/dist/esm/languages/prism/jsx',
  'react-syntax-highlighter/dist/esm/languages/prism/markdown',
  'react-syntax-highlighter/dist/esm/languages/prism/markup',
  'react-syntax-highlighter/dist/esm/languages/prism/php',
  'react-syntax-highlighter/dist/esm/languages/prism/python',
  'react-syntax-highlighter/dist/esm/languages/prism/ruby',
  'react-syntax-highlighter/dist/esm/languages/prism/rust',
  'react-syntax-highlighter/dist/esm/languages/prism/sql',
  'react-syntax-highlighter/dist/esm/languages/prism/toml',
  'react-syntax-highlighter/dist/esm/languages/prism/tsx',
  'react-syntax-highlighter/dist/esm/languages/prism/typescript',
  'react-syntax-highlighter/dist/esm/languages/prism/yaml',
  'react-syntax-highlighter/dist/esm/styles/prism/vsc-dark-plus',
  'react-syntax-highlighter/dist/esm/styles/prism/vs',
];

const renderCodeBlock = (className: string, children: string) => React.createElement(AIMessageCodeBlock, {
  className,
  children,
  darkMode: false,
  overlayTheme: buildOverlayWorkbenchTheme(false),
});

describe('AIMessageCodeBlock dependency boundary', () => {
  it('loads the lightweight syntax highlighter without the complete language registry', () => {
    expect(dependencyMocks.completeRegistryLoad).not.toHaveBeenCalled();
    expect(dependencyMocks.prismLightLoad).toHaveBeenCalledOnce();
    expect(dependencyMocks.registerLanguage).toHaveBeenCalledTimes(20);
  });

  it('loads Mermaid only when a Mermaid fenced block is rendered', async () => {
    let renderer: ReactTestRenderer | undefined;
    let mermaidContainer: { innerHTML: string } | undefined;

    try {
      act(() => {
        renderer = create(renderCodeBlock('language-sql', 'SELECT 1;'), {
          createNodeMock: (element) => {
            if (element.type === 'div' && element.props.className === 'ai-mermaid-container') {
              mermaidContainer = { innerHTML: '' };
              return mermaidContainer;
            }
            return {};
          },
        });
      });
      expect(dependencyMocks.mermaidLoad).not.toHaveBeenCalled();

      await act(async () => {
        renderer?.update(renderCodeBlock('language-mermaid', 'graph TD; A-->B;'));
      });
      await vi.waitFor(() => {
        expect(dependencyMocks.mermaidLoad).toHaveBeenCalledOnce();
        expect(dependencyMocks.mermaidInitialize).toHaveBeenCalledWith({ startOnLoad: false, theme: 'default' });
        expect(dependencyMocks.mermaidRender).toHaveBeenCalledWith(expect.stringMatching(/^mermaid-/), 'graph TD; A-->B;');
        expect(mermaidContainer?.innerHTML).toBe('<svg>diagram</svg>');
      });
    } finally {
      act(() => renderer?.unmount());
    }
  });

  it('pre-bundles every static syntax-highlighter dependency', () => {
    const includedDependencies = viteConfig.optimizeDeps?.include || [];
    expect(includedDependencies).toEqual(expect.arrayContaining(codeHighlightDependencies));
  });
});
