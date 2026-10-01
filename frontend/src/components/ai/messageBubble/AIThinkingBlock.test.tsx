import React from 'react';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { buildOverlayWorkbenchTheme } from '../../../utils/overlayWorkbenchTheme';
import { AIThinkingBlock } from './AIThinkingBlock';

// Ant Design icons inject styles through the DOM, which this node test runner lacks.
vi.mock('@ant-design/icons', () => ({
  CaretRightOutlined: () => null,
}));

const overlayTheme = buildOverlayWorkbenchTheme(false);

const render = (thinking: string, options: { typing?: boolean; loading?: boolean } = {}) => create(
  <AIThinkingBlock
    displayThinking={thinking}
    isTyping={options.typing ?? false}
    isGlobalLoading={options.loading ?? false}
    darkMode={false}
    overlayTheme={overlayTheme}
    hasContent
  />,
);

const byClass = (root: ReactTestInstance, className: string) => root.findAll((node) => (
  typeof node.type === 'string'
  && String(node.props.className || '').split(' ').includes(className)
));

const text = (node: ReactTestInstance): string => node.children
  .map((child) => (typeof child === 'string' ? child : text(child)))
  .join('');

describe('AIThinkingBlock nodes', () => {
  it('lists title-only summaries as plain nodes without a toggle', () => {
    const renderer = render('**Checking Oracle version**\n\n**Preparing insert**');

    expect(byClass(renderer.root, 'ai-think-step')).toHaveLength(2);
    expect(byClass(renderer.root, 'ai-think-node')).toHaveLength(0);
    expect(byClass(renderer.root, 'ai-think-title').map(text)).toEqual(['Checking Oracle version', 'Preparing insert']);
  });

  it('folds a node with details until it is opened', () => {
    const renderer = render('**Plan**\nCheck the version first.\n\n**Run**');
    const node = byClass(renderer.root, 'ai-think-node')[0];

    expect(node.props['aria-expanded']).toBe(false);
    expect(byClass(renderer.root, 'ai-think-body')).toHaveLength(0);

    act(() => {
      node.props.onClick();
    });

    expect(byClass(renderer.root, 'ai-think-node')[0].props['aria-expanded']).toBe(true);
    expect(byClass(renderer.root, 'ai-think-body').map(text)).toEqual(['Check the version first.']);

    act(() => {
      byClass(renderer.root, 'ai-think-node')[0].props.onClick();
    });
    expect(byClass(renderer.root, 'ai-think-body')).toHaveLength(0);
  });

  it('keeps the node that is still streaming open', () => {
    const renderer = render('**Plan**\nChecking the ver', { typing: true, loading: true });

    expect(byClass(renderer.root, 'ai-think-node')[0].props['aria-expanded']).toBe(true);
    expect(byClass(renderer.root, 'ai-think-body').map(text)).toEqual(['Checking the ver']);
    expect(byClass(renderer.root, 'ai-think-cursor')).toHaveLength(1);
  });

  it('shows plain reasoning text directly and never leaks markdown markers', () => {
    const renderer = render('先看连接，再看 **表结构**。');

    expect(byClass(renderer.root, 'ai-think-node')).toHaveLength(0);
    expect(byClass(renderer.root, 'ai-think-body').map(text)).toEqual(['先看连接，再看 表结构。']);
  });
});
