import type { ReactNode } from 'react';
import { Button, Tooltip } from 'antd';
import type { ConnectionConfig } from '../../../types';
import { GnRollbackIcon, GnSaveIcon, GnSqlDocIcon } from '../../icons/gnIcons';
import { getDataGridSaveCapability } from '../dataGridSaveCapability';
import './DataGridSaveRestriction.css';

export interface DataGridSaveRestrictionProps {
  connectionConfig?: ConnectionConfig;
  tableName?: string;
  translate: (key: string, params?: Record<string, string | number>) => string;
  hasChanges: boolean;
  pendingChangeCount: number;
  onPreviewChanges: () => void;
  onResetPendingChanges: () => void;
}

export const DataGridSaveRestriction = ({
  connectionConfig, tableName, translate, hasChanges, pendingChangeCount,
  onPreviewChanges, onResetPendingChanges,
}: DataGridSaveRestrictionProps) => {
  const capability = getDataGridSaveCapability(connectionConfig);
  if (!tableName || capability.supported) return null;
  const reason = translate(capability.messageKey);
  const commitLabel = translate('data_grid.toolbar.commit', { count: pendingChangeCount });
  const previewLabel = translate('data_grid.toolbar.preview_sql');
  const rollbackLabel = translate('data_grid.toolbar.rollback');

  return (
    <div className="data-grid-save-restriction" data-grid-save-restriction="true">
      <Tooltip title={reason} trigger={['hover', 'focus']}>
        <span role="button" tabIndex={0} aria-disabled="true"
          aria-label={`${commitLabel}: ${reason}`} data-grid-disabled-action="commit">
          <Button className="gn-v2-data-grid-toolbar-action" icon={<GnSaveIcon />}
            disabled aria-hidden="true" tabIndex={-1} />
        </span>
      </Tooltip>
      <Tooltip title={reason} trigger={['hover', 'focus']}>
        <span className="data-grid-save-restriction-label">
          {translate('data_grid.toolbar.navicat_http_tunnel_read_only')}
        </span>
      </Tooltip>
      {hasChanges && (
        <>
          <Tooltip title={previewLabel}>
            <Button className="gn-v2-data-grid-toolbar-action" aria-label={previewLabel}
              icon={<GnSqlDocIcon />} onClick={onPreviewChanges} />
          </Tooltip>
          <Tooltip title={rollbackLabel}>
            <Button className="gn-v2-data-grid-toolbar-action" aria-label={rollbackLabel}
              icon={<GnRollbackIcon />} onClick={onResetPendingChanges} />
          </Tooltip>
        </>
      )}
    </div>
  );
};

export const buildDataGridSaveRestrictionActions = (
  props: DataGridSaveRestrictionProps & { extraActions?: ReactNode },
): ReactNode => {
  const { extraActions, ...restrictionProps } = props;
  if (!props.tableName || getDataGridSaveCapability(props.connectionConfig).supported) return extraActions;
  return <><DataGridSaveRestriction {...restrictionProps} />{extraActions}</>;
};
