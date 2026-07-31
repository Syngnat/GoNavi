import React from 'react';
import { Spin } from 'antd';
import type { TabData } from '../types';
import { useStore } from '../store';
import '../styles/v2-theme-workbench.css';

const DataViewer = React.lazy(() => import('./DataViewer'));
const QueryEditor = React.lazy(() => import('./QueryEditor'));
const TableDesigner = React.lazy(() => import('./TableDesigner'));
const RedisViewer = React.lazy(() => import('./RedisViewer'));
const RedisCommandEditor = React.lazy(() => import('./RedisCommandEditor'));
const RedisMonitor = React.lazy(() => import('./RedisMonitor'));
const NacosViewer = React.lazy(() => import('./NacosViewer'));
const NacosServiceViewer = React.lazy(() => import('./NacosServiceViewer'));
const TriggerViewer = React.lazy(() => import('./TriggerViewer'));
const DefinitionViewer = React.lazy(() => import('./DefinitionViewer'));
const TableOverview = React.lazy(() => import('./TableOverview'));
const TableExportWorkbench = React.lazy(() => import('./TableExportWorkbench'));
const DataImportWorkbench = React.lazy(() => import('./DataImportWorkbench'));
const DataSyncWorkbench = React.lazy(() => import('./DataSyncWorkbench'));
const SQLFileExecutionWorkbench = React.lazy(() => import('./SQLFileExecutionWorkbench'));
const JVMOverview = React.lazy(() => import('./JVMOverview'));
const JVMResourceBrowser = React.lazy(() => import('./JVMResourceBrowser'));
const JVMAuditViewer = React.lazy(() => import('./JVMAuditViewer'));
const JVMDiagnosticConsole = React.lazy(() => import('./JVMDiagnosticConsole'));
const JVMMonitoringDashboard = React.lazy(() => import('./JVMMonitoringDashboard'));
const SqlAnalysisWorkbench = React.lazy(() => import('./explain/SqlAnalysisWorkbench'));
const SqlAuditWorkbench = React.lazy(() => import('./audit/SqlAuditWorkbench'));

const QueryWorkbenchContent: React.FC<{ tab: TabData; isActive: boolean }> = React.memo(({
  tab,
  isActive,
}) => {
  // Keep the editor subscribed to its own live SQL while its TabManager/Floating
  // host ignores query-only updates. Local typing remains contained here, and
  // native/external query replacements still reach the editor.
  const liveQuery = useStore((state) => (
    state.tabs.find((candidate) => candidate.id === tab.id)?.query
  ));
  const liveTab = React.useMemo(
    () => (Object.is(liveQuery, tab.query) ? tab : { ...tab, query: liveQuery }),
    [liveQuery, tab],
  );
  return <QueryEditor tab={liveTab} isActive={isActive} />;
});

QueryWorkbenchContent.displayName = 'QueryWorkbenchContent';

export const WORKBENCH_CONTENT_READY_FALLBACK_MS = 4_000;
const WORKBENCH_PENDING_CONTENT_SELECTOR = '[data-monaco-editor-loading="true"]';

export const waitForWorkbenchContentReady = (
  onReady: () => void,
  root: Pick<Document, 'querySelector'> = document,
): (() => void) => {
  let settled = false;
  let observer: MutationObserver | null = null;
  const finish = () => {
    if (settled) return;
    settled = true;
    observer?.disconnect();
    clearTimeout(fallbackTimer);
    onReady();
  };
  const check = () => {
    if (!root.querySelector(WORKBENCH_PENDING_CONTENT_SELECTOR)) finish();
  };
  const fallbackTimer = setTimeout(finish, WORKBENCH_CONTENT_READY_FALLBACK_MS);
  check();
  if (!settled && typeof MutationObserver !== 'undefined') {
    observer = new MutationObserver(check);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    check();
  }
  return () => {
    settled = true;
    observer?.disconnect();
    clearTimeout(fallbackTimer);
  };
};

const WorkbenchContentReady: React.FC<{
  marker: string;
  onReady?: () => void;
}> = ({ onReady }) => {
  React.useEffect(() => {
    if (!onReady) return undefined;
    return waitForWorkbenchContentReady(onReady);
  }, [onReady]);
  return null;
};

export interface WorkbenchTabContentProps {
  tab: TabData;
  isActive: boolean;
  onContentReady?: () => void;
}

export const WorkbenchTabContent: React.FC<WorkbenchTabContentProps> = React.memo(({
  tab,
  isActive,
  onContentReady,
}) => {
  let content: React.ReactNode;
  if (tab.type === 'query') {
    content = <QueryWorkbenchContent tab={tab} isActive={isActive} />;
  } else if (tab.type === 'table') {
    content = <DataViewer tab={tab} isActive={isActive} />;
  } else if (tab.type === 'design') {
    content = <TableDesigner tab={tab} />;
  } else if (tab.type === 'redis-keys') {
    content = <RedisViewer connectionId={tab.connectionId} redisDB={tab.redisDB ?? 0} />;
  } else if (tab.type === 'redis-command') {
    content = <RedisCommandEditor connectionId={tab.connectionId} redisDB={tab.redisDB ?? 0} />;
  } else if (tab.type === 'redis-monitor') {
    content = <RedisMonitor connectionId={tab.connectionId} redisDB={tab.redisDB ?? 0} isActive={isActive} />;
  } else if (tab.type === 'nacos-config') {
    content = (
      <NacosViewer
        connectionId={tab.connectionId}
        namespaceId={tab.nacosNamespaceId ?? ''}
        namespaceName={tab.nacosNamespaceName}
        initialGroup={tab.nacosGroup}
      />
    );
  } else if (tab.type === 'nacos-services') {
    content = (
      <NacosServiceViewer
        connectionId={tab.connectionId}
        namespaceId={tab.nacosNamespaceId ?? ''}
        namespaceName={tab.nacosNamespaceName}
        initialGroup={tab.nacosGroup}
      />
    );
  } else if (tab.type === 'trigger') {
    content = <TriggerViewer tab={tab} />;
  } else if (tab.type === 'view-def' || tab.type === 'event-def' || tab.type === 'routine-def' || tab.type === 'sequence-def' || tab.type === 'package-def') {
    content = <DefinitionViewer tab={tab} />;
  } else if (tab.type === 'table-overview') {
    content = <TableOverview tab={tab} />;
  } else if (tab.type === 'table-export') {
    content = <TableExportWorkbench tab={tab} />;
  } else if (tab.type === 'data-import') {
    content = <DataImportWorkbench tab={tab} />;
  } else if (tab.type === 'data-sync') {
    content = <DataSyncWorkbench tab={tab} />;
  } else if (tab.type === 'sql-file-execution') {
    content = <SQLFileExecutionWorkbench tab={tab} />;
  } else if (tab.type === 'sql-analysis') {
    content = <SqlAnalysisWorkbench tab={tab} />;
  } else if (tab.type === 'sql-audit') {
    content = <SqlAuditWorkbench tab={tab} isActive={isActive} />;
  } else if (tab.type === 'jvm-overview') {
    content = <JVMOverview tab={tab} />;
  } else if (tab.type === 'jvm-resource') {
    content = <JVMResourceBrowser tab={tab} />;
  } else if (tab.type === 'jvm-audit') {
    content = <JVMAuditViewer tab={tab} />;
  } else if (tab.type === 'jvm-diagnostic') {
    content = <JVMDiagnosticConsole tab={tab} />;
  } else if (tab.type === 'jvm-monitoring') {
    content = <JVMMonitoringDashboard tab={tab} />;
  } else {
    const exhaustiveType: never = tab.type;
    return exhaustiveType;
  }

  return (
    <React.Suspense
      fallback={(
        <div
          aria-busy="true"
          style={{ flex: '1 1 auto', minWidth: 0, minHeight: 0, display: 'grid', placeItems: 'center' }}
        >
          <Spin size="small" />
        </div>
      )}
    >
      {content}
      <WorkbenchContentReady
        key={`${tab.id}:${tab.type}`}
        marker={`${tab.id}:${tab.type}`}
        onReady={onContentReady}
      />
    </React.Suspense>
  );
});

WorkbenchTabContent.displayName = 'WorkbenchTabContent';

export default WorkbenchTabContent;
