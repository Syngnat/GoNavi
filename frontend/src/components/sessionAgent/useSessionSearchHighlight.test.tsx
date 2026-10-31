// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionSearchHighlight } from './useSessionSearchHighlight';

/**
 * 会话内搜索高亮引擎的回归：包 <mark>、命中计数、上一个/下一个循环
 * 跳转、清除后还原原文，以及内容被 React 改写后重扫不残留旧标记。
 * 引擎操作真实 DOM，必须用 react-dom 挂载（react-test-renderer 没有 DOM）。
 */

const HIT_SELECTOR = 'mark.gn-session-agent-hit';

interface Probe {
  total: number;
  active: number;
  step: (delta: number) => void;
}

let probe: Probe | null = null;

const Harness: React.FC<{ text: string; needle: string }> = ({ text, needle }) => {
  const ref = React.useRef<HTMLDivElement | null>(null);
  const hits = useSessionSearchHighlight(ref, needle, 'static');
  React.useEffect(() => {
    probe = { total: hits.total, active: hits.active, step: hits.step };
  });
  return (
    <div ref={ref}>
      <p>第一段 {text} 后续</p>
      <p>{text}</p>
    </div>
  );
};

let container: HTMLDivElement;
let root: Root;

const render = (text: string, needle: string) => {
  act(() => {
    root.render(<Harness text={text} needle={needle} />);
  });
};

const marksIn = (): HTMLElement[] => Array.from(container.querySelectorAll<HTMLElement>(HIT_SELECTOR));

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Element.prototype.scrollIntoView = vi.fn();
  probe = null;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('useSessionSearchHighlight', () => {
  it('wraps every occurrence and reports the hit count', () => {
    render('工作区A 工作区B', '工作区');
    // 两段各两次命中。
    expect(probe?.total).toBe(4);
    const marks = marksIn();
    expect(marks.length).toBe(4);
    expect(marks.every((mark) => mark.textContent === '工作区')).toBe(true);
    // 展示不变：原文内容在包裹后保持完整。
    expect(container.textContent).toContain('第一段 工作区A 工作区B 后续');
  });

  it('steps through hits with wrap-around and marks the active one', () => {
    render('工作区A 工作区B', '工作区');
    act(() => probe?.step(1));
    expect(probe?.active).toBe(1);
    expect(marksIn()[1].classList.contains('is-active')).toBe(true);
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
    // 越过末尾后回到第一个命中。
    act(() => {
      probe?.step(1);
      probe?.step(1);
      probe?.step(1);
    });
    expect(probe?.active).toBe(0);
    expect(marksIn()[0].classList.contains('is-active')).toBe(true);
    act(() => probe?.step(-1));
    expect(probe?.active).toBe(3);
  });

  it('restores the original text when the needle is cleared', () => {
    render('工作区A 工作区B', '工作区');
    render('工作区A 工作区B', '');
    expect(probe?.total).toBe(0);
    expect(marksIn().length).toBe(0);
    expect(container.textContent).toContain('第一段 工作区A 工作区B 后续');
  });

  it('re-scans cleanly after React rewrites the wrapped text', async () => {
    render('旧内容命中', '命中');
    expect(probe?.total).toBe(2);
    // 内容被替换：React 会改写被包裹过的文本节点，重扫后不得残留旧
    // 标记或重复文本。重扫由 MutationObserver 经 rAF 兜底。
    render('新内容也含命中', '命中');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(marksIn().length).toBe(2);
    expect(container.textContent).toContain('第一段 新内容也含命中 后续');
    expect(container.textContent).not.toContain('旧内容');
  });
});
