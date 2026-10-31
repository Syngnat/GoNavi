import React from 'react';
import type { TabData } from '../../types';
import { wailsSessionAgentApi, type SessionAgentApi } from './sessionAgentApi';
import { SessionAgentListView } from './SessionAgentListView';
import { SessionAgentDetailPanel } from './SessionAgentDetailPanel';
import { useSessionAgentList } from './useSessionAgentList';
import { useSessionAgentDetail } from './useSessionAgentDetail';
import { useSessionAgentDetailActions } from './useSessionAgentDetailActions';
import './SessionAgentWorkbench.css';

// 列表与沉浸详情互斥展示，外层菜单和数据源树不属于此组件。
export const SessionAgentWorkbench: React.FC<{
  tab: TabData;
  api?: SessionAgentApi;
}> = ({ tab, api = wailsSessionAgentApi }) => {
  const list = useSessionAgentList(api, tab.agentIntegrationId);
  const detail = useSessionAgentDetail(api);
  const actions = useSessionAgentDetailActions(api, detail.selected, detail.clear, list.reload);

  React.useEffect(() => {
    if (!list.loading && list.items.length === 0) detail.clear();
  }, [list.loading, list.items.length, detail.clear]);

  return (
    <div className={`gn-session-agent-workbench${detail.selected ? ' is-detail' : ''}`} data-session-agent-workbench="true">
      {detail.selected ? (
        <SessionAgentDetailPanel
          item={detail.selected}
          messages={detail.messages}
          turns={detail.turns}
          loading={detail.loading}
          onBack={detail.clear}
          onReload={detail.reload}
          onExport={actions.exportMarkdown}
          onCopyResume={actions.copyResume}
          onCopyId={actions.copyId}
          onCopyPath={actions.copyPath}
          onDelete={actions.remove}
          onOpenFull={actions.openFull}
        />
      ) : (
        <SessionAgentListView controller={list} onSelect={detail.select} />
      )}
    </div>
  );
};

export default SessionAgentWorkbench;
