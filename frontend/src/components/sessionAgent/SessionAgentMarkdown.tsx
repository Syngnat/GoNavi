import React from 'react';
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { normalizeAiMarkdown } from '../../utils/aiMarkdown';
import { SessionAgentFileLink } from './SessionAgentFileLink';
import { SessionAgentImage, type SessionAgentImageLoader } from './SessionAgentImage';
import { isLocalFileHref, isLocalImageHref, localFilePath, rewriteCodexFileCitations } from './sessionAgentFileLinks';

/**
 * 会话详情的 Markdown 渲染：轻量封装 react-markdown + GFM。
 * 独立于 AI 面板的渲染器（不依赖连接上下文与 SQL 注入偏好），
 * 供会话时间线的用户气泡与助手正文使用。
 *
 * 内容归一化复用 AI 面板的 normalizeAiMarkdown（同一套代码围栏修正规则）。
 *
 * 两类本机文件引用单独处理：Codex 的 :codex-file-citation{...} 内联标记
 * 与指向本机路径的 Markdown 链接，都渲染成文件卡片；指向本机图片的
 * ![alt](/E:/path/x.png) 渲染成图片（webview 加载不了本机路径，由后端
 * 读成 data URL）。
 */
const remarkPlugins = [remarkGfm];

const markdownComponents: Components = {
  a: ({ href, children, ...rest }) => {
    const target = String(href ?? '');
    if (isLocalFileHref(target)) {
      return <SessionAgentFileLink href={target} label={typeof children === 'string' ? children : ''} />;
    }
    return (
      <a {...rest} href={target} target="_blank" rel="noreferrer">
        {children}
      </a>
    );
  },
  img: ({ src, alt }) => {
    const target = String(src ?? '');
    if (isLocalImageHref(target)) {
      return <SessionAgentImage path={localFilePath(target)} alt={String(alt ?? '')} />;
    }
    // 外链图片：保持默认渲染。
    return <img src={target} alt={String(alt ?? '')} loading="lazy" />;
  },
};

/** 注入图片读取器后的 img 组件（测试用）。 */
const imageComponent = (loadImage: SessionAgentImageLoader): NonNullable<Components['img']> =>
  ({ src, alt }) => {
    const target = String(src ?? '');
    if (isLocalImageHref(target)) {
      return <SessionAgentImage path={localFilePath(target)} alt={String(alt ?? '')} loadImage={loadImage} />;
    }
    return <img src={target} alt={String(alt ?? '')} loading="lazy" />;
  };

/**
 * react-markdown v9 默认会把 file: 这类协议判为不安全直接抹掉，本机文件
 * 引用会被清成空 href。本机路径单独放行，其余仍走默认的安全策略。
 */
const urlTransform = (url: string): string => {
  if (isLocalFileHref(url)) return url;
  return defaultUrlTransform(url);
};

export const SessionAgentMarkdown: React.FC<{
  content: string;
  /** 本机图片读取器（默认走 Wails 绑定；测试可注入）。 */
  loadImage?: SessionAgentImageLoader;
}> = ({ content, loadImage }) => (
  // white-space 必须显式 normal：react-markdown 会在块级元素之间插入
  // "\n" 文本节点，一旦被祖先的 pre-wrap 继承，这些分隔符会变成真实
  // 空行，段距被撑到两倍。内联样式是硬保证（单测可断言）。
  <div
    className="gn-session-agent-markdown"
    data-session-agent-markdown="true"
    style={{ whiteSpace: 'normal' }}
  >
    <ReactMarkdown
      remarkPlugins={remarkPlugins}
      components={loadImage ? { ...markdownComponents, img: imageComponent(loadImage) } : markdownComponents}
      urlTransform={urlTransform}
    >
      {rewriteCodexFileCitations(normalizeAiMarkdown(content ?? ''))}
    </ReactMarkdown>
  </div>
);
