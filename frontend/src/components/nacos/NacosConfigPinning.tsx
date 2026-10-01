import React, { useMemo } from 'react';
import { Button, Dropdown, Tag, Tooltip } from 'antd';
import { PushpinOutlined, StarFilled } from '@ant-design/icons';
import { useStore } from '../../store';
import { t, type I18nParams } from '../../i18n';
import { buildNacosConfigPinScope, isNacosConfigPinned, sortPinnedNacosConfigs, type NacosConfigIdentity } from './nacosPinning';

type Translate = (key: string, params?: I18nParams) => string;

export const useNacosConfigPinning = <T extends NacosConfigIdentity>(
  items: readonly T[], connectionId: string, namespaceId: string,
) => {
  const keys = useStore((state) => state.pinnedSidebarTables);
  return useMemo(() => sortPinnedNacosConfigs(items, keys, connectionId, namespaceId),
    [items, keys, connectionId, namespaceId]);
};

export const NacosConfigRow: React.FC<{
  row: NacosConfigIdentity; connectionId: string; namespaceId: string; tr?: Translate;
}> = ({ row, connectionId, namespaceId, tr = t }) => {
  const keys = useStore((state) => state.pinnedSidebarTables);
  const pinned = isNacosConfigPinned(keys, connectionId, namespaceId, row);
  const label = tr(pinned ? 'nacos.pin.unpin_config' : 'nacos.pin.pin_config');
  const toggle = () => {
    const store = useStore.getState();
    store.setSidebarTablePinned(connectionId, buildNacosConfigPinScope(namespaceId), row.dataId, row.group,
      !isNacosConfigPinned(store.pinnedSidebarTables, connectionId, namespaceId, row));
  };
  return (
    <Dropdown trigger={['contextMenu']} menu={{ items: [{ key: 'pin-config', label, icon: <PushpinOutlined />, onClick: toggle }] }}>
      <div className="gn-nacos-config-row">
        <div className="gn-nacos-config-row__main">
          <div className="gn-nacos-config-row__id" title={row.dataId}>{row.dataId}</div>
          <div className="gn-nacos-config-row__group" title={row.group}>{row.group || 'DEFAULT_GROUP'}</div>
        </div>
        <Tooltip title={label}>
          <Button type="text" size="small" aria-label={label} aria-pressed={pinned}
            icon={pinned ? <StarFilled /> : <PushpinOutlined />}
            onClick={(event) => { event.stopPropagation(); toggle(); }} />
        </Tooltip>
        {row.type ? <Tag className="gn-nacos-config-row__type" bordered={false} title={row.type}>{row.type}</Tag> : null}
      </div>
    </Dropdown>
  );
};
