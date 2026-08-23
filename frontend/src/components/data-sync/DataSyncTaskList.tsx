import React from 'react';

import type { DataSyncTaskDefinition, DataSyncTaskKind } from './model';
import type { DataSyncWorkbenchTranslate } from './text';

const taskKindKey = (kind: DataSyncTaskKind) => `task_kind.${kind}` as const;

export const DataSyncTaskList: React.FC<{
  tasks: DataSyncTaskDefinition[];
  selectedTaskId: string;
  search: string;
  t: DataSyncWorkbenchTranslate;
  onSearchChange: (value: string) => void;
  onSelectTask: (taskId: string) => void;
  onNewTask: () => void;
}> = ({
  tasks,
  selectedTaskId,
  search,
  t,
  onSearchChange,
  onSelectTask,
  onNewTask,
}) => (
  <aside className="gn-data-sync-task-list" aria-label={t('task_list.title')}>
    <div className="gn-data-sync-task-list__header">
      <strong>{t('task_list.title')}</strong>
      <button
        type="button"
        className="gn-data-sync-icon-button"
        aria-label={t('workbench.new_task')}
        title={t('workbench.new_task')}
        onClick={onNewTask}
      >
        +
      </button>
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
            onClick={() => onSelectTask(task.id)}
          >
            <span className="gn-data-sync-task-row__marker" aria-hidden="true" />
            <span className="gn-data-sync-task-row__content">
              <span className="gn-data-sync-task-row__name">
                {task.name || t(taskKindKey(task.kind))}
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
