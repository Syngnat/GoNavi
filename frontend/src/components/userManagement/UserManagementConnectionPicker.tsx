import { useMemo, useState } from 'react';
import { Input, Tag } from 'antd';
import { useI18n } from '../../i18n/provider';
import { useStore } from '../../store';
import { resolveConnectionAccentColor, resolveConnectionIconType } from '../../utils/connectionVisual';
import { getDataSourceCapabilities } from '../../utils/dataSourceCapabilities';
import { buildUserManagementWorkbenchTab, USER_MANAGEMENT_PICKER_TAB_ID } from '../../utils/userManagementTab';
import { getDbIcon } from '../DatabaseIcons';
import { GnDatabaseIcon, GnSearchIcon } from '../icons/gnIcons';
import './UserManagementConnectionPicker.css';
import UserManagementEmpty from './UserManagementEmpty';
import { GnUsersIcon } from './userManagementIcons';

interface UserManagementConnectionPickerProps {
  currentTabId: string;
}

/** 选择要管理账号的连接；不支持的数据源置灰并注明原因。 */
export default function UserManagementConnectionPicker({ currentTabId }: UserManagementConnectionPickerProps) {
  const { t } = useI18n();
  const connections = useStore((state) => state.connections);
  const addTab = useStore((state) => state.addTab);
  const closeTab = useStore((state) => state.closeTab);
  const [keyword, setKeyword] = useState('');

  const items = useMemo(() => {
    const normalized = keyword.trim().toLowerCase();
    return connections
      .filter((connection) => !normalized || String(connection.name || '').toLowerCase().includes(normalized))
      .map((connection) => ({ connection, supported: getDataSourceCapabilities(connection.config).supportsUserManagement }))
      .sort((left, right) => Number(right.supported) - Number(left.supported));
  }, [connections, keyword]);

  const open = (connectionId: string) => {
    addTab(buildUserManagementWorkbenchTab(connectionId));
    if (currentTabId === USER_MANAGEMENT_PICKER_TAB_ID) closeTab(currentTabId);
  };

  return (
    <div className="gn-user-mgmt gn-user-mgmt-picker">
      <div className="gn-user-mgmt-picker-head">
        <span className="gn-user-mgmt-title-icon"><GnUsersIcon /></span>
        <div>
          <h2>{t('user_management.picker.title')}</h2>
          <p>{t('user_management.picker.description')}</p>
        </div>
      </div>
      <Input
        allowClear
        prefix={<GnSearchIcon />}
        placeholder={t('user_management.picker.search')}
        value={keyword}
        onChange={(event) => setKeyword(event.target.value)}
        className="gn-user-mgmt-picker-search"
      />
      {items.length === 0 ? (
        <UserManagementEmpty icon={<GnDatabaseIcon />} text={t('user_management.picker.empty')} />
      ) : (
        <div className="gn-user-mgmt-picker-grid" role="list">
          {items.map(({ connection, supported }) => (
            <button
              key={connection.id}
              type="button"
              role="listitem"
              className="gn-user-mgmt-picker-item"
              disabled={!supported}
              onClick={() => open(connection.id)}
            >
              <span className="gn-user-mgmt-picker-icon">
                {getDbIcon(resolveConnectionIconType(connection), resolveConnectionAccentColor(connection), 20)}
              </span>
              <span className="gn-user-mgmt-picker-name">{connection.name}</span>
              <span className="gn-user-mgmt-picker-meta">{connection.config?.host || connection.config?.type}</span>
              {!supported && <Tag>{t('user_management.picker.unsupported')}</Tag>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
