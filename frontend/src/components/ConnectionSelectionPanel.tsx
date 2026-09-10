import React, { useMemo } from 'react';
import { Button, Checkbox } from 'antd';
import { t } from '../i18n';
import type { ConnectionHealthGroup } from '../utils/connectionHealth';
import './ConnectionToolSettings.css';

export type ConnectionSelectionEntry = {
  id: string;
  name: string;
  type?: string;
};

type ConnectionSelectionPanelProps = {
  connections: ConnectionSelectionEntry[];
  groups?: ConnectionHealthGroup[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
};

const toggleIds = (current: string[], ids: string[], selected: boolean): string[] => {
  const next = new Set(current);
  ids.forEach((id) => {
    if (selected) next.add(id);
    else next.delete(id);
  });
  return Array.from(next);
};

const ConnectionSelectionPanel: React.FC<ConnectionSelectionPanelProps> = ({
  connections,
  groups = [],
  selectedIds,
  onChange,
  disabled = false,
}) => {
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const allIds = useMemo(() => connections.map((item) => item.id), [connections]);
  const selectedCount = selectedIds.length;
  const totalCount = connections.length;

  const visibleGroups = groups.filter((group) => group.connectionIds.length > 0);

  return (
    <div className="gn-conn-picker" data-connection-selection-panel="true">
      <div className="gn-conn-picker__toolbar">
        <div className="gn-conn-picker__summary">
          {t('app.connection_package.dialog.export_connections_summary', {
            selected: selectedCount,
            total: totalCount,
          })}
        </div>
        <div className="gn-conn-tool-actions">
          <Button
            size="small"
            type="text"
            disabled={disabled || totalCount === 0 || selectedCount === totalCount}
            onClick={() => onChange(allIds)}
          >
            {t('data_export.action.select_all')}
          </Button>
          <Button
            size="small"
            type="text"
            disabled={disabled || selectedCount === 0}
            onClick={() => onChange([])}
          >
            {t('data_export.action.clear')}
          </Button>
        </div>
      </div>
      {visibleGroups.length > 0 ? (
        <div className="gn-conn-picker__groups" aria-label={t('connection_health.selection.title')}>
          <button
            type="button"
            className={`gn-conn-picker__group${selectedCount === totalCount && totalCount > 0 ? ' is-selected' : selectedCount > 0 ? ' is-partial' : ''}`}
            disabled={disabled || totalCount === 0}
            onClick={() => onChange(selectedCount === totalCount ? [] : allIds)}
          >
            <span>{t('connection_health.selection.all', { count: totalCount })}</span>
          </button>
          {visibleGroups.map((group) => {
            const groupSelected = group.connectionIds.filter((id) => selectedSet.has(id)).length;
            const allSelected = groupSelected === group.connectionIds.length && group.connectionIds.length > 0;
            const partial = groupSelected > 0 && !allSelected;
            return (
              <button
                key={group.id}
                type="button"
                className={`gn-conn-picker__group${allSelected ? ' is-selected' : partial ? ' is-partial' : ''}`}
                disabled={disabled}
                aria-label={t('connection_health.selection.group', { name: group.name, count: group.connectionIds.length })}
                onClick={() => onChange(toggleIds(selectedIds, group.connectionIds, !allSelected))}
              >
                <span>{group.name}</span>
                <span className="gn-conn-picker__group-count">{group.connectionIds.length}</span>
              </button>
            );
          })}
        </div>
      ) : null}
      <div className="gn-conn-picker__grid">
        {connections.map((connection) => {
          const selected = selectedSet.has(connection.id);
          return (
            <label
              key={connection.id}
              className={`gn-conn-picker__item${selected ? ' is-selected' : ''}${disabled ? ' is-disabled' : ''}`}
              data-connection-picker-item={connection.id}
            >
              <Checkbox
                checked={selected}
                disabled={disabled}
                onChange={(event) => onChange(toggleIds(selectedIds, [connection.id], event.target.checked))}
              />
              <span className="gn-conn-picker__name" title={connection.name}>{connection.name}</span>
              {connection.type ? <span className="gn-conn-picker__type">{connection.type}</span> : null}
            </label>
          );
        })}
      </div>
    </div>
  );
};

export default ConnectionSelectionPanel;
