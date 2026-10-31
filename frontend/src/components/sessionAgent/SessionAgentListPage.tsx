import React from 'react';
import { Empty, Pagination, Spin, Tag, Tooltip } from 'antd';
import { ClockCircleOutlined, FolderOutlined, RightOutlined } from '@ant-design/icons';
import { t } from '../../i18n';
import { GnClaudeIcon, GnOpenAIAgentIcon } from '../icons/gnIcons';
import type { SessionAgentItem } from './sessionAgentApi';
import { projectDisplayName, shortenSessionPreview, shortenSessionTitle } from './sessionAgentRow';
import './SessionAgentListPage.css';

export interface SessionGroup {
  key: string;
  label: string;
  items: SessionAgentItem[];
}

const GROUPS_PER_PAGE = 12;

export const SessionAgentListPage: React.FC<{
  items: SessionAgentItem[];
  loading: boolean;
  groupMode: string;
  selectedPath: string;
  onSelect: (item: SessionAgentItem) => void;
}> = ({ items, loading, groupMode, selectedPath, onSelect }) => {
  const groups = React.useMemo(() => buildSessionGroups(items, groupMode), [items, groupMode]);
  const [page, setPage] = React.useState(1);
  const pageCount = Math.max(1, Math.ceil(groups.length / GROUPS_PER_PAGE));
  const current = Math.min(page, pageCount);
  const visible = React.useMemo(
    () => groups.slice((current - 1) * GROUPS_PER_PAGE, current * GROUPS_PER_PAGE),
    [groups, current],
  );

  React.useEffect(() => setPage(1), [groups.length, groupMode]);

  if (loading && items.length === 0) {
    return <div className="gn-session-agent-listpage" data-session-agent-list="true"><div className="gn-session-agent-loading"><Spin /></div></div>;
  }
  if (items.length === 0) {
    return <div className="gn-session-agent-listpage" data-session-agent-list="true"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('session_agent.list.empty')} /></div>;
  }
  return (
    <div className="gn-session-agent-listpage" data-session-agent-list="true">
      <div className="gn-session-agent-listpage-body">
        {visible.map((group) => (
          <SessionGroupSection key={group.key} group={group} groupMode={groupMode} selectedPath={selectedPath} onSelect={onSelect} />
        ))}
      </div>
      {pageCount > 1 ? (
        <div className="gn-session-agent-listpage-pager">
          <Pagination size="small" current={current} pageSize={GROUPS_PER_PAGE} total={groups.length} showSizeChanger={false} onChange={setPage} />
        </div>
      ) : null}
    </div>
  );
};

const SessionGroupSection: React.FC<{
  group: SessionGroup;
  groupMode: string;
  selectedPath: string;
  onSelect: (item: SessionAgentItem) => void;
}> = ({ group, groupMode, selectedPath, onSelect }) => {
  const projectPath = groupMode === 'project' ? group.items[0]?.projectDir : '';
  const groupStamp = groupMode === 'project' ? projectGroupStamp(group.items) : '';
  return (
    <section className="gn-session-agent-group" data-session-agent-group={group.key}>
      <header className="gn-session-agent-group-head">
        {groupMode === 'project' ? <FolderOutlined className="gn-session-agent-group-icon" /> : <ClockCircleOutlined className="gn-session-agent-group-icon" />}
        <span className="gn-session-agent-group-name">{group.label}</span>
        {groupStamp ? <span className="gn-session-agent-group-date">{groupStamp}</span> : null}
        {projectPath ? <span className="gn-session-agent-group-path" title={projectPath}>{projectPath}</span> : null}
        <span className="gn-session-agent-group-count">{t('session_agent.list.total', { count: group.items.length })}</span>
      </header>
      <div className="gn-session-agent-group-body">
        {group.items.map((item) => (
          <SessionRow key={item.sourcePath} item={item} selected={item.sourcePath === selectedPath} onSelect={onSelect} />
        ))}
      </div>
    </section>
  );
};

const SessionRow: React.FC<{
  item: SessionAgentItem;
  selected: boolean;
  onSelect: (item: SessionAgentItem) => void;
}> = ({ item, selected, onSelect }) => {
  const preview = item.summary || item.firstMessage;
  return (
    <button
      type="button"
      className={selected ? 'gn-session-agent-row is-selected' : 'gn-session-agent-row'}
      data-session-agent-row="true"
      onClick={() => onSelect(item)}
    >
      <span className="gn-session-agent-row-main">
        <span className="gn-session-agent-row-top">
          <span className="gn-session-agent-session-title" title={item.title || item.sessionId}>
            {shortenSessionTitle(item.title || item.sessionId, 64)}
          </span>
          {item.forkedFrom ? (
            <Tooltip title={t('session_agent.list.fork_hint', { id: item.forkedFrom })}>
              <Tag className="gn-session-agent-fork-tag" data-session-agent-fork="true">{t('session_agent.list.fork')}</Tag>
            </Tooltip>
          ) : null}
        </span>
        {preview ? (
          <span className="gn-session-agent-session-preview" title={preview}>{shortenSessionPreview(preview, 120)}</span>
        ) : null}
        <span className="gn-session-agent-row-meta">
          <span>{projectDisplayName(item.projectDir) || '—'}</span>
        </span>
      </span>
      <span className="gn-session-agent-row-side">
        <span className="gn-session-agent-time-cell">{relativeTime(item.lastActiveAt || item.createdAt)}</span>
        <RightOutlined className="gn-session-agent-row-arrow" />
      </span>
    </button>
  );
};

export const ProviderIcon: React.FC<{ providerId: string; className?: string }> = ({ providerId, className }) => {
  const Icon = providerId === 'claude' ? GnClaudeIcon : GnOpenAIAgentIcon;
  return <Icon className={className} />;
};

export const ProviderAvatar: React.FC<{ providerId: string }> = ({ providerId }) => (
  <span className={`gn-session-agent-avatar ${providerId === 'claude' ? 'is-claude' : 'is-codex'}`}><ProviderIcon providerId={providerId} /></span>
);

export const relativeTime = (ts: number): string => {
  if (!ts) return '';
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (ts >= todayStart) return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (ts >= todayStart - 86400000) return t('session_agent.time.yesterday');
  return dayLabel(ts);
};

// 具体日期：当年只给月日，跨年补上年份——「N 天前」这种相对值对不上日历。
export const dayLabel = (ts: number): string => {
  const date = new Date(ts);
  const now = new Date();
  const options: Intl.DateTimeFormatOptions = date.getFullYear() === now.getFullYear()
    ? { month: 'long', day: 'numeric' }
    : { year: 'numeric', month: 'long', day: 'numeric' };
  return date.toLocaleDateString([], options);
};

export const sortSessionItems = (items: SessionAgentItem[], groupMode: string): SessionAgentItem[] => {
  const list = [...items];
  const byTime = (a: SessionAgentItem, b: SessionAgentItem) => (b.lastActiveAt || b.createdAt) - (a.lastActiveAt || a.createdAt);
  if (groupMode === 'project') {
    list.sort((a, b) => {
      const projectDiff = projectDisplayName(a.projectDir).localeCompare(projectDisplayName(b.projectDir));
      return projectDiff !== 0 ? projectDiff : byTime(a, b);
    });
    return list;
  }
  return list.sort(byTime);
};

export const sessionGroupKey = (item: SessionAgentItem, groupMode: string): string => {
  if (groupMode === 'project') return projectDisplayName(item.projectDir) || '—';
  const ts = item.lastActiveAt || item.createdAt;
  if (!ts) return 'unknown';
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (ts >= today) return 'today';
  if (ts >= today - 86400000) return 'yesterday';
  // 时间分组一天一组：本周/更早这类模糊桶让人对不上具体日期。
  const day = new Date(ts);
  return `day-${new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime()}`;
};

export const sessionGroupLabel = (item: SessionAgentItem, groupMode: string): string => {
  if (groupMode === 'project') return projectDisplayName(item.projectDir) || '—';
  const key = sessionGroupKey(item, groupMode);
  if (key === 'today') return t('session_agent.group.today');
  if (key === 'yesterday') return t('session_agent.group.yesterday');
  const ts = item.lastActiveAt || item.createdAt;
  return ts ? dayLabel(ts) : '—';
};

// 项目组头的时间标注：整组都在今天的给首次会话的具体时刻，否则给
// 最近活跃的具体日期，让项目卡片能对上日历。
export const projectGroupStamp = (items: SessionAgentItem[]): string => {
  if (items.length === 0) return '';
  const activeTs = (item: SessionAgentItem) => item.lastActiveAt || item.createdAt;
  const latest = activeTs(items[0]);
  if (!latest) return '';
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (latest < todayStart) return dayLabel(latest);
  let first = items[0];
  for (const item of items) {
    const ts = item.createdAt || item.lastActiveAt;
    if (ts && ts < (first.createdAt || first.lastActiveAt)) first = item;
  }
  const firstTs = first.createdAt || first.lastActiveAt;
  return firstTs >= todayStart
    ? new Date(firstTs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : dayLabel(latest);
};

export const buildSessionGroups = (items: SessionAgentItem[], groupMode: string): SessionGroup[] => {
  const groups: SessionGroup[] = [];
  let current: SessionGroup | null = null;
  for (const item of sortSessionItems(items, groupMode)) {
    const key = sessionGroupKey(item, groupMode);
    if (!current || current.key !== key) {
      current = { key, label: sessionGroupLabel(item, groupMode), items: [] };
      groups.push(current);
    }
    current.items.push(item);
  }
  return groups;
};
