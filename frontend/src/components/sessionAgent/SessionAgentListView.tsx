import React from 'react';
import { Button, Input, Select, Tooltip } from 'antd';
import { ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import { t } from '../../i18n';
import type { SessionAgentItem } from './sessionAgentApi';
import type { useSessionAgentList } from './useSessionAgentList';
import { SessionAgentListPage } from './SessionAgentListPage';

type ListController = ReturnType<typeof useSessionAgentList>;

// 全页列表态：标题、筛选工具和分组会话使用同一阅读宽度。
export const SessionAgentListView: React.FC<{
  controller: ListController;
  selectedPath?: string;
  onSelect: (item: SessionAgentItem) => void;
}> = ({ controller, selectedPath = '', onSelect }) => (
  <>
    <header className="gn-session-agent-header">
      <h2 className="gn-session-agent-heading">{t('session_agent.workbench.heading')}</h2>
      <p className="gn-session-agent-description">{t('session_agent.workbench.description')}</p>
    </header>
    <div className="gn-session-agent-toolbar">
      <Input
        allowClear
        value={controller.query}
        onChange={(event) => controller.setQuery(event.target.value)}
        prefix={<SearchOutlined />}
        placeholder={t('session_agent.list.search_placeholder')}
        aria-label={t('session_agent.list.search_placeholder')}
        className="gn-session-agent-search"
      />
      <Select
        value={controller.providerFilter}
        onChange={controller.setProviderFilter}
        className="gn-session-agent-filter"
        aria-label={t('session_agent.list.filter_label')}
        options={controller.providerOptions}
      />
      <Select
        value={controller.groupMode}
        onChange={controller.setGroupMode}
        className="gn-session-agent-filter"
        aria-label={t('session_agent.list.group_label')}
        options={[
          { value: 'project', label: t('session_agent.list.group_project') },
          { value: 'time', label: t('session_agent.list.group_time') },
        ]}
      />
      <Tooltip title={t('session_agent.list.refresh')}>
        <Button
          icon={<ReloadOutlined />}
          onClick={() => { void controller.reload(); }}
          aria-label={t('session_agent.list.refresh')}
        />
      </Tooltip>
    </div>
    <div className="gn-session-agent-list-meta">
      <span>
        {controller.filtering
          ? t('session_agent.list.matched', { matched: controller.items.length, total: controller.scopeTotal })
          : t('session_agent.list.total', { count: controller.items.length })}
      </span>
      {controller.filtering ? (
        <Button type="link" size="small" onClick={() => controller.setQuery('')}>
          {t('session_agent.list.clear_filter')}
        </Button>
      ) : null}
    </div>
    <div className="gn-session-agent-workbench-columns">
      <SessionAgentListPage
        items={controller.items}
        loading={controller.loading}
        groupMode={controller.groupMode}
        selectedPath={selectedPath}
        onSelect={onSelect}
      />
    </div>
  </>
);
