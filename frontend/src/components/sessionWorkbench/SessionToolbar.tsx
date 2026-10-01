import { ReloadOutlined } from '@ant-design/icons';
import { Button, Checkbox, Input, Select, Space, Typography } from 'antd';
import type { SavedConnection } from '../../types';
import { useI18n } from '../../i18n/provider';
import SessionConnectionSelect from './SessionConnectionSelect';

export interface SessionToolbarProps {
  connections: SavedConnection[];
  selectedConnectionId: string;
  /**
   * Databases the connection can read sessions from. Selecting one is a
   * server-side rescope on engines that scope the session list (PostgreSQL
   * lineage), and a narrowing filter elsewhere.
   */
  databaseOptions: string[];
  /** Empty means "the connection's own default database". */
  databaseName: string;
  filter: string;
  runningOnly: boolean;
  loading: boolean;
  /** The catalog request for the current connection is still running. */
  databaseLoading: boolean;
  onConnectionChange: (connectionId: string) => void;
  onDatabaseChange: (databaseName: string) => void;
  onFilterChange: (filter: string) => void;
  onRunningOnlyChange: (runningOnly: boolean) => void;
  onRefresh: () => void;
}

export default function SessionToolbar({
  connections,
  selectedConnectionId,
  databaseOptions,
  databaseName,
  databaseLoading,
  filter,
  runningOnly,
  loading,
  onConnectionChange,
  onDatabaseChange,
  onFilterChange,
  onRunningOnlyChange,
  onRefresh,
}: SessionToolbarProps) {
  const { t } = useI18n();
  return (
    <div className="gn-session-workbench-toolbar">
      <div className="gn-session-workbench-toolbar-row">
        <Typography.Text className="gn-session-workbench-toolbar-label">
          {t('session_workbench.connection.label')}
        </Typography.Text>
        <SessionConnectionSelect
          connections={connections}
          value={selectedConnectionId}
          onChange={onConnectionChange}
        />
        {/* Always rendered: hiding it whenever the catalog was empty made the
            picker unreachable exactly when it was needed. */}
        <Typography.Text className="gn-session-workbench-toolbar-label">
          {t('session_workbench.database.label')}
        </Typography.Text>
        <Select
          allowClear
          showSearch
          className="gn-session-workbench-database-select"
          aria-label={t('session_workbench.database.label')}
          value={databaseName || undefined}
          placeholder={databaseLoading
            ? t('session_workbench.loading')
            : t('session_workbench.database.placeholder')}
          loading={databaseLoading}
          options={databaseOptions.map((name) => ({ value: name, label: name }))}
          onChange={(next) => onDatabaseChange(next ?? '')}
        />
        <Button
          type="default"
          icon={<ReloadOutlined />}
          loading={loading}
          onClick={onRefresh}
          aria-label={t('session_workbench.refresh')}
        >
          {t('session_workbench.refresh')}
        </Button>
      </div>
      <Space className="gn-session-workbench-filter" size={8} wrap>
        <Typography.Text>{t('session_workbench.filter.label')}</Typography.Text>
        <Input
          allowClear
          value={filter}
          aria-label={t('session_workbench.filter.label')}
          placeholder={t('session_workbench.filter.placeholder')}
          onChange={(event) => onFilterChange(event.target.value)}
        />
        <Checkbox
          checked={runningOnly}
          onChange={(event) => onRunningOnlyChange(event.target.checked)}
        >
          {t('session_workbench.filter.running_only')}
        </Checkbox>
      </Space>
    </div>
  );
}
