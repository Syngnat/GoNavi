import type { DataSyncWorkbenchStateApi } from './hooks/useDataSyncWorkbenchState';
import type { DataSyncWorkbenchDiffActionsApi } from './hooks/useDataSyncWorkbenchDiffActions';
import type { DataSyncWorkbenchRunActionsApi } from './hooks/useDataSyncWorkbenchRunActions';
import type { DataSyncWorkbenchShellProps } from '../DataSyncWorkbenchShell';

export interface DataSyncWorkbenchHeaderProps {
  t: DataSyncWorkbenchStateApi['t'];
  workbenchChrome: DataSyncWorkbenchDiffActionsApi['workbenchChrome'];
  viewKeys: DataSyncWorkbenchStateApi['viewKeys'];
  activeView: DataSyncWorkbenchStateApi['activeView'];
  setActiveView: DataSyncWorkbenchStateApi['setActiveView'];
  setTaskRailOpen: DataSyncWorkbenchStateApi['setTaskRailOpen'];
  scheduleControl: DataSyncWorkbenchRunActionsApi['scheduleControl'];
  taskRailToggleRef: DataSyncWorkbenchStateApi['taskRailToggleRef'];
  taskListId: DataSyncWorkbenchStateApi['taskListId'];
  taskRailOpen: DataSyncWorkbenchStateApi['taskRailOpen'];
  compactTaskRail: DataSyncWorkbenchStateApi['compactTaskRail'];
  setShowKindSelector: DataSyncWorkbenchStateApi['setShowKindSelector'];
  onClose: DataSyncWorkbenchShellProps['onClose'];
}

export const DataSyncWorkbenchHeader = ({
  t, workbenchChrome, viewKeys, activeView, setActiveView, setTaskRailOpen, scheduleControl,
  taskRailToggleRef, taskListId, taskRailOpen, compactTaskRail, setShowKindSelector, onClose,
}: DataSyncWorkbenchHeaderProps) => (
  <header className="gn-data-sync-workbench__header">
    <div className="gn-data-sync-workbench__identity">
      <strong>
        <span className="gn-data-sync-workbench__title-full">
          {t(workbenchChrome.title)}
        </span>
        <span className="gn-data-sync-workbench__title-short">
          {t(workbenchChrome.titleShort)}
        </span>
      </strong>
      <span className="gn-data-sync-workbench__subtitle">
        {t(workbenchChrome.subtitle)}
      </span>
    </div>
    <nav className="gn-data-sync-global-nav" aria-label={t('workbench.view_navigation')}>
      {viewKeys.map((view) => (
        <button
          key={view}
          type="button"
          data-active={activeView === view ? 'true' : 'false'}
          aria-current={activeView === view ? 'page' : undefined}
          onClick={() => {
            setActiveView(view);
            setTaskRailOpen(false);
            // Schedule rows live in the schedule control, not in this
            // component's state: entering the view must pull a fresh
            // snapshot so the list can never render a stale or empty set.
            if (view === 'schedules') void scheduleControl.refresh();
          }}
        >
          {t(`nav.${view}`)}
        </button>
      ))}
    </nav>
    <div className="gn-data-sync-workbench__header-actions">
      {activeView === 'tasks' ? (
        <button
          ref={taskRailToggleRef}
          type="button"
          className="gn-data-sync-button gn-data-sync-header-action gn-data-sync-task-rail-toggle"
          aria-controls={taskListId}
          aria-expanded={taskRailOpen}
          aria-label={t('workbench.task_list_toggle')}
          title={t('workbench.task_list_toggle')}
          onClick={() => setTaskRailOpen((open) => !open)}
        >
          <span
            className="gn-data-sync-header-action__icon"
            aria-hidden="true"
          >
            ☷
          </span>
          <span className="gn-data-sync-header-action__label">
            {t('workbench.task_list_toggle')}
          </span>
        </button>
      ) : null}
      {activeView !== 'tasks' || compactTaskRail ? (
        <button
          type="button"
          className="gn-data-sync-button gn-data-sync-header-action"
          aria-label={t('workbench.new_task')}
          title={t('workbench.new_task')}
          onClick={() => {
            setActiveView('tasks');
            setShowKindSelector(true);
            setTaskRailOpen(false);
          }}
        >
          <span
            className="gn-data-sync-header-action__icon"
            aria-hidden="true"
          >
            ＋
          </span>
          <span className="gn-data-sync-header-action__label">
            {t('workbench.new_task')}
          </span>
        </button>
      ) : null}
      {onClose ? (
        <button
          type="button"
          className="gn-data-sync-icon-button"
          aria-label={t('workbench.close')}
          title={t('workbench.close')}
          onClick={onClose}
        >
          ×
        </button>
      ) : null}
    </div>
  </header>
);
