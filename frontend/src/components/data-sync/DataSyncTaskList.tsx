import React from 'react';

import type { DataSyncTaskDefinition, DataSyncTaskKind } from './model';
import type { DataSyncWorkbenchTranslate } from './text';

const taskKindKey = (kind: DataSyncTaskKind) => `task_kind.${kind}` as const;

const endpointName = (
  task: DataSyncTaskDefinition,
  side: 'source' | 'target',
  fallback: string,
) => task[side].connectionName || task[side].connectionId || fallback;

export const DataSyncTaskList: React.FC<{
  id?: string;
  containerRef?: React.Ref<HTMLElement>;
  tasks: DataSyncTaskDefinition[];
  selectedTaskId: string;
  search: string;
  t: DataSyncWorkbenchTranslate;
  onSearchChange: (value: string) => void;
  onSelectTask: (taskId: string) => void;
  onNewTask: () => void;
  onClose?: () => void;
}> = ({
  id,
  containerRef,
  tasks,
  selectedTaskId,
  search,
  t,
  onSearchChange,
  onSelectTask,
  onNewTask,
  onClose,
}) => (
  <aside
    ref={containerRef}
    id={id}
    className="gn-data-sync-task-list"
    aria-label={t('task_list.title')}
  >
    <div className="gn-data-sync-task-list__header">
      <strong>{t('task_list.title')}</strong>
      <span className="gn-data-sync-task-list__header-actions">
        <button
          type="button"
          className="gn-data-sync-icon-button"
          aria-label={t('workbench.new_task')}
          title={t('workbench.new_task')}
          onClick={onNewTask}
        >
          +
        </button>
        {onClose ? (
          <button
            type="button"
            className="gn-data-sync-icon-button gn-data-sync-task-list__close"
            aria-label={t('common.dismiss')}
            title={t('common.dismiss')}
            onClick={onClose}
          >
            ×
          </button>
        ) : null}
      </span>
    </div>
    <label className="gn-data-sync-search">
      <span className="gn-data-sync-visually-hidden">{t('task_list.search')}</span>
      <input
        value={search}
        placeholder={t('task_list.search')}
        onChange={(event) => onSearchChange(event.target.value)}
      />
    </label>
    <div className="gn-data-sync-task-list__items">
      {tasks.length === 0 ? (
        <div className="gn-data-sync-task-list__empty">{t('task_list.empty')}</div>
      ) : (
        tasks.map((task) => (
          <button
            key={task.id}
            type="button"
            className="gn-data-sync-task-row"
            data-task-id={task.id}
            data-selected={task.id === selectedTaskId ? 'true' : 'false'}
            aria-current={task.id === selectedTaskId ? 'true' : undefined}
            onClick={() => onSelectTask(task.id)}
          >
            <span className="gn-data-sync-task-row__marker" aria-hidden="true" />
            <span className="gn-data-sync-task-row__content">
              <span className="gn-data-sync-task-row__name">
                {task.name || t(taskKindKey(task.kind))}
              </span>
              <span className="gn-data-sync-task-row__route">
                {endpointName(task, 'source', t('route.pending_source'))}
                <span aria-hidden="true">→</span>
                {endpointName(task, 'target', t('route.pending_target'))}
              </span>
              <span className="gn-data-sync-task-row__meta">
                {t(taskKindKey(task.kind))} ·{' '}
                {t('task_list.revision', { revision: task.revision })}
              </span>
            </span>
            <span
              className="gn-data-sync-state-label"
              data-state={task.lifecycle}
            >
              {t(`task_list.lifecycle.${task.lifecycle}`)}
            </span>
          </button>
        ))
      )}
    </div>
  </aside>
);

const TASK_KINDS: DataSyncTaskKind[] = [
  'migration',
  'reconcile',
  'querySink',
  'compare',
  'cdc',
];

export const DataSyncTaskKindSelector: React.FC<{
  t: DataSyncWorkbenchTranslate;
  onSelect: (kind: DataSyncTaskKind) => void;
}> = ({ t, onSelect }) => (
  <section className="gn-data-sync-kind-selector" data-data-sync-kind-selector="true">
    <header>
      <h2>{t('task_kind.title')}</h2>
      <p>{t('task_kind.subtitle')}</p>
    </header>
    <div className="gn-data-sync-kind-table" role="list">
      {TASK_KINDS.map((kind) => (
        <button
          key={kind}
          type="button"
          role="listitem"
          className="gn-data-sync-kind-row"
          data-task-kind={kind}
          onClick={() => onSelect(kind)}
        >
          <span className="gn-data-sync-kind-row__arrow" aria-hidden="true">→</span>
          <span>
            <strong>{t(taskKindKey(kind))}</strong>
            <small>{t(`task_kind.${kind}_desc`)}</small>
          </span>
        </button>
      ))}
    </div>
  </section>
);
