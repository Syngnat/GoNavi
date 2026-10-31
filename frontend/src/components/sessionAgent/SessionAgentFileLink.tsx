import React from 'react';
import { Tooltip } from 'antd';
import { GnLinkIcon } from '../icons/gnIcons';
import { fileDisplayName, localFilePath } from './sessionAgentFileLinks';

/**
 * 正文里的本机文件引用卡片：显示文件名，悬停给完整路径。
 * 正文中的路径不是网页链接，渲染成裸路径容易被误读成普通文字。
 *
 * 卡片统一显示**文件名**（找文件靠名字）；正文里作者写的友好标签与文件名
 * 不同时放进悬停提示，避免卡片行被长文本撑开。
 */
export const SessionAgentFileLink: React.FC<{ href: string; label?: string }> = ({ href, label }) => {
  const path = localFilePath(href);
  const name = fileDisplayName(path);
  const friendly = (label || '').trim();
  const hint = friendly && friendly !== name ? `${friendly}\n${path}` : path;
  return (
    <Tooltip title={hint}>
      <span className="gn-session-agent-file-link" data-session-agent-file-link="true">
        <GnLinkIcon className="gn-session-agent-file-link-icon" />
        <span className="gn-session-agent-file-link-name">{name}</span>
      </span>
    </Tooltip>
  );
};
