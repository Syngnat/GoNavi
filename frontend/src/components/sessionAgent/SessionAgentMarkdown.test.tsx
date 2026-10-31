// @vitest-environment jsdom
import React from 'react';

vi.mock('antd', () => ({
  Tooltip: ({ children }: { children?: React.ReactNode }) =>
    React.createElement('span', null, children),
}));

import { describe, expect, it, vi } from 'vitest';
import { act, create } from 'react-test-renderer';
import { SessionAgentMarkdown } from './SessionAgentMarkdown';

// 会话正文里的本机文件引用必须渲染成文件卡片，而不是裸标记或网页链接。

const findFileLinks = (tree: ReturnType<typeof create>) =>
  tree.root.findAll((node) => node.props?.['data-session-agent-file-link'] === 'true');

/** 把渲染树拍平成纯文本（React 元素不能直接 JSON.stringify）。 */
const flatten = (node: any): string => {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(flatten).join('');
  if (node.props && node.props.children !== undefined) return flatten(node.props.children);
  return flatten(node.children);
};

describe('SessionAgentMarkdown', () => {
  it('renders a codex file citation as a file card', () => {
    const content = '能否同时给多个人计算分润。:codex-file-citation{path="E:/Agent/Codex/WorkSpace/sources/mt/01-01_投资分润协议_徐州叁众叁_待填写版.docx" purpose="source"}';
    const tree = create(<SessionAgentMarkdown content={content} />);
    expect(findFileLinks(tree)).toHaveLength(1);
    const text = flatten(tree.toJSON());
    expect(text).toContain('01-01_投资分润协议_徐州叁众叁_待填写版.docx');
    // 原始标记不能漏到界面上。
    expect(text).not.toContain('codex-file-citation');
  });

  it('renders a local markdown link as a file card', () => {
    const content = '[RAG 面试突击知识手册](/E:/Agent/Codex/Project/2026-08-31/agent-agent-agent/outputs/RAG面试突击知识手册_Java转AI应用开发.md)';
    const tree = create(<SessionAgentMarkdown content={content} />);
    expect(findFileLinks(tree)).toHaveLength(1);
    expect(flatten(tree.toJSON())).toContain('RAG面试突击知识手册_Java转AI应用开发.md');
  });

  it('keeps web links as links', () => {
    const content = '[CoBot](https://github.com/kunghim/CoBot)';
    const tree = create(<SessionAgentMarkdown content={content} />);
    expect(findFileLinks(tree)).toHaveLength(0);
    const anchor = tree.root.find((node) => node.props?.href === 'https://github.com/kunghim/CoBot');
    expect(anchor).toBeTruthy();
  });

  it('never inherits pre-wrap: block separators must not turn into blank lines', () => {
    // react-markdown 在块级元素之间插入 "\n" 文本节点；一旦被祖先的
    // pre-wrap 继承，这些分隔符会渲染成真实空行，段距被撑到两倍。
    const tree = create(<SessionAgentMarkdown content={'第一段\n\n第二段'} />);
    const md = tree.root.find((node) => node.props?.className === 'gn-session-agent-markdown');
    expect(md).toBeTruthy();
    expect(md.props?.style).toMatchObject({ whiteSpace: 'normal' });
  });

  it('renders a local markdown image through the backend data-url loader', async () => {
    // webview 不能直接加载本机路径（/E:/... 与 file:// 都被拦掉），
    // 图片必须由后端读成 data URL。
    const requested: string[] = [];
    const tree = create(
      <SessionAgentMarkdown
        content={'![数字步进：右侧多出长条空白](/E:/Project/x/03-stepper-hover.jpg)'}
        loadImage={async (path: string) => {
          requested.push(path);
          return 'data:image/jpeg;base64,AAAA';
        }}
      />,
    );
    await act(async () => {});
    expect(requested).toEqual(['E:/Project/x/03-stepper-hover.jpg']);
    const img = tree.root.find((node) => node.props?.['data-session-agent-image'] === 'true');
    expect(img).toBeTruthy();
    expect(img.props?.src).toBe('data:image/jpeg;base64,AAAA');
    expect(img.props?.alt).toContain('数字步进');
  });

  it('keeps a web image as a plain image', () => {
    const tree = create(<SessionAgentMarkdown content={'![shot](https://example.com/a.png)'} />);
    const img = tree.root.find((node) => node.type === 'img');
    expect(img.props?.src).toBe('https://example.com/a.png');
  });
});
