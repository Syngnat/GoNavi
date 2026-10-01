import { Alert, Button, Select, Space, Tag, Tooltip } from 'antd';
import { useI18n } from '../../i18n/provider';
import { useStore } from '../../store';
import type { SavedConnection } from '../../types';
import { getDataSourceCapabilities } from '../../utils/dataSourceCapabilities';
import { buildUserManagementWorkbenchTab } from '../../utils/userManagementTab';
import { GnRefreshIcon } from '../icons/gnIcons';
import { GnInfoIcon, GnUsersIcon } from './userManagementIcons';
import type { UMNotice, UMServerProfile } from './userManagementTypes';

interface UserManagementHeaderProps {
  connection: SavedConnection;
  profile: UMServerProfile | null;
  loading: boolean;
  databases: string[];
  database: string;
  onDatabaseChange: (database: string) => void;
  onRefresh: () => void;
}

const noticeLevel = (notice: UMNotice) => (notice.level === 'danger' ? 'danger' : notice.level === 'warning' ? 'warning' : 'info');

/** 头部：连接切换、服务端版本徽标、当前账号、按库作用域选择与提示条。 */
export default function UserManagementHeader({
  connection,
  profile,
  loading,
  databases,
  database,
  onDatabaseChange,
  onRefresh,
}: UserManagementHeaderProps) {
  const { t } = useI18n();
  const connections = useStore((state) => state.connections);
  const addTab = useStore((state) => state.addTab);
  const supportedConnections = connections.filter((item) => getDataSourceCapabilities(item.config).supportsUserManagement);
  const databaseScoped = Boolean(profile?.features?.databaseScoped);
  const notices = profile?.notices ?? [];

  return (
    <div className="gn-user-mgmt-header">
      <div className="gn-user-mgmt-header-row">
        <span className="gn-user-mgmt-title-icon"><GnUsersIcon /></span>
        <Select
          className="gn-user-mgmt-connection-select"
          value={connection.id}
          aria-label={t('user_management.header.connection')}
          options={supportedConnections.map((item) => ({ value: item.id, label: item.name }))}
          onChange={(value) => addTab(buildUserManagementWorkbenchTab(value))}
          popupMatchSelectWidth={false}
        />
        {profile && (
          <Space size={6} wrap className="gn-user-mgmt-profile">
            <Tag color="blue">{profile.versionText || profile.family}</Tag>
            {profile.flavor && profile.flavor !== profile.family && <Tag>{profile.flavor}</Tag>}
            {profile.topology && <Tag>{t('user_management.header.topology', { topology: profile.topology })}</Tag>}
            {profile.experimental && <Tag color="orange">{t('user_management.header.experimental')}</Tag>}
            {profile.readOnly && <Tag color="gold">{t('user_management.header.read_only')}</Tag>}
            {profile.currentUser && (
              <span className="gn-user-mgmt-current-user">
                {t('user_management.header.current_user', { user: profile.currentUser })}
              </span>
            )}
          </Space>
        )}
        <div className="gn-user-mgmt-header-actions">
          {databaseScoped && (
            <Select
              className="gn-user-mgmt-database-select"
              showSearch
              value={database || undefined}
              placeholder={t('user_management.header.database')}
              aria-label={t('user_management.header.database')}
              options={databases.map((item) => ({ value: item, label: item }))}
              onChange={onDatabaseChange}
            />
          )}
          <Tooltip title={t('user_management.action.refresh')}>
            <Button icon={<GnRefreshIcon />} loading={loading} onClick={onRefresh} aria-label={t('user_management.action.refresh')} />
          </Tooltip>
        </div>
      </div>
      {profile?.unsupportedReason && (
        <Alert type="warning" showIcon message={profile.unsupportedReason.text || t('user_management.error.unsupported')} />
      )}
      {notices.length > 0 && (
        <ul className="gn-user-mgmt-notices">
          {notices.map((notice) => (
            <li key={notice.code} className={`gn-user-mgmt-notice is-${noticeLevel(notice)}`}>
              <GnInfoIcon className="gn-user-mgmt-notice-icon" />
              <span>{notice.text || notice.code}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
