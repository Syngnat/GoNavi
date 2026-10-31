import React from 'react';
import { Button, Input, Modal, Spin, Tooltip } from 'antd';
import { ArrowDownOutlined, ArrowLeftOutlined, ArrowUpOutlined, CopyOutlined, DeleteOutlined, ExportOutlined, MoreOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import { t } from '../../i18n';
import type { SessionAgentItem, SessionBlockContent, SessionContentRef, SessionMessageView, SessionTurnView } from './sessionAgentApi';
import { SessionAgentTurns } from './SessionAgentTurns';
import { SessionAgentChanges } from './SessionAgentChanges';
import { buildSessionChanges, formatSessionDateTime } from './sessionAgentView';
import { relativeTime } from './SessionAgentListPage';
import { useSessionSearchHighlight } from './useSessionSearchHighlight';
import './SessionAgentDetailPanel.css';

interface DetailProps {
  item: SessionAgentItem;
  messages: SessionMessageView[];
  turns: SessionTurnView[];
  loading: boolean;
  onBack: () => void;
  onReload: () => void;
  onExport: () => void;
  onCopyResume: () => void;
  onCopyId: () => void;
  onCopyPath: () => void;
  onDelete: () => void;
  onOpenFull: (ref: SessionContentRef) => Promise<SessionBlockContent | null>;
}

export const SessionAgentDetailPanel: React.FC<DetailProps> = (props) => {
  const { item, messages, turns, loading } = props;
  const [search, setSearch] = React.useState('');
  const [viewMode, setViewMode] = React.useState<'chat' | 'changes'>('chat');
  React.useEffect(() => {
    setSearch('');
    setViewMode('chat');
  }, [item.sourcePath]);
  const needle = search.trim().toLowerCase();
  const changes = React.useMemo(() => buildSessionChanges(messages), [messages]);
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  // 命中高亮与跳转基于渲染后的 DOM：内容切换、懒加载由 hook 内部的
  // MutationObserver 兜底重扫，这里只需给出内容代次。
  const searchHits = useSessionSearchHighlight(scrollRef, needle, `${viewMode}:${item.sourcePath}`);

  return (
    <section className="gn-session-agent-detail" data-session-agent-detail="true">
      <DetailHeader {...props} />
      <div className="gn-session-agent-detail-sub">
        <div className="gn-session-agent-detail-views">
          {(['chat', 'changes'] as const).map((mode) => (
            <button type="button" key={mode} className={viewMode === mode ? 'is-active' : ''} onClick={() => setViewMode(mode)}>
              {t(mode === 'chat' ? 'session_agent.detail.view_chat' : 'session_agent.detail.view_changes')}
              <span>{mode === 'chat' ? turns.length : changes.length}</span>
            </button>
          ))}
        </div>
        {needle ? (
          <span className="gn-session-agent-search-nav">
            <Button size="small" icon={<ArrowUpOutlined />} disabled={!searchHits.total} onClick={() => searchHits.step(-1)} aria-label={t('session_agent.detail.search_prev')} />
            <span className="gn-session-agent-search-position">{searchHits.total ? searchHits.active + 1 : 0} / {searchHits.total}</span>
            <Button size="small" icon={<ArrowDownOutlined />} disabled={!searchHits.total} onClick={() => searchHits.step(1)} aria-label={t('session_agent.detail.search_next')} />
          </span>
        ) : null}
        <Input
          allowClear
          size="small"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          prefix={<SearchOutlined />}
          placeholder={t('session_agent.detail.search_placeholder')}
          aria-label={t('session_agent.detail.search_placeholder')}
          className="gn-session-agent-detail-search"
        />
      </div>
      <div ref={scrollRef} className="gn-session-agent-detail-scroll">
        {loading ? <div className="gn-session-agent-detail-loading"><Spin /></div> : (
          <div className="gn-session-agent-detail-content">
            {viewMode === 'chat' ? (
              <SessionAgentTurns item={item} messages={messages} turns={turns} needle={needle} onOpenFull={props.onOpenFull} />
            ) : (
              <SessionAgentChanges messages={messages} needle={needle} onOpenFull={props.onOpenFull} />
            )}
          </div>
        )}
      </div>
    </section>
  );
};

const DetailHeader: React.FC<DetailProps> = (props) => {
  const { item, onBack, onReload, onExport, onCopyResume } = props;
  return (
    <header className="gn-session-agent-detail-head">
      <div className="gn-session-agent-detail-main">
        <Button className="gn-session-agent-back-btn" icon={<ArrowLeftOutlined />} onClick={onBack}><span className="gn-session-agent-back-label">{t('session_agent.action.back_to_list')}</span></Button>
        <div className="gn-session-agent-detail-titleline">
          <div className="gn-session-agent-detail-title-row">
            <h3 className="gn-session-agent-detail-title" title={item.title || item.sessionId}>{item.title || item.sessionId}</h3>
            {item.forkedFrom ? <span className="gn-session-agent-detail-fork">{t('session_agent.list.fork')}</span> : null}
          </div>
          <div className="gn-session-agent-detail-meta">
            <span title={item.projectDir}>{item.projectDir || '—'}</span>
            <span>·</span>
            <span>{t('session_agent.detail.created', { time: formatSessionDateTime(item.createdAt) })}</span>
            <span>·</span>
            <span>{t('session_agent.detail.last_active', { time: relativeTime(item.lastActiveAt || item.createdAt) })}</span>
          </div>
        </div>
        <div className="gn-session-agent-detail-actions">
          <Tooltip title={t('session_agent.action.reload')}><Button icon={<ReloadOutlined />} onClick={onReload} aria-label={t('session_agent.action.reload')} /></Tooltip>
          <Button icon={<CopyOutlined />} onClick={onCopyResume}><span className="gn-session-agent-action-label">{t('session_agent.action.copy_resume')}</span></Button>
          <Button icon={<ExportOutlined />} onClick={onExport}><span className="gn-session-agent-action-label">{t('session_agent.action.export')}</span></Button>
          <DetailMore {...props} />
        </div>
      </div>
    </header>
  );
};

const DetailMore: React.FC<DetailProps> = ({ onCopyId, onCopyPath, onDelete }) => (
  <details className="gn-session-agent-detail-more">
    <summary aria-label={t('session_agent.detail.more')}><MoreOutlined /></summary>
    <div className="gn-session-agent-detail-menu">
      <button type="button" onClick={onCopyId}>{t('session_agent.action.copy_id')}</button>
      <button type="button" onClick={onCopyPath}>{t('session_agent.action.copy_path')}</button>
      <button type="button" className="is-danger" onClick={onDelete}><DeleteOutlined />{t('session_agent.action.delete')}</button>
    </div>
  </details>
);

export const confirmSessionAgentDelete = (item: SessionAgentItem, onConfirm: () => void) => {
  Modal.confirm({
    title: t('session_agent.delete.title'),
    content: (
      <div data-session-agent-delete-confirm="true">
        <p>{t('session_agent.delete.body', { title: item.title || item.sessionId })}</p>
        <ul><li>{t('session_agent.delete.scope_file')}</li><li>{t('session_agent.delete.scope_no_restore')}</li></ul>
      </div>
    ),
    okText: t('session_agent.action.delete'),
    okButtonProps: { danger: true },
    cancelText: t('common.cancel'),
    onOk: onConfirm,
  });
};
