import { PushpinOutlined } from '@ant-design/icons';
import { t } from '../../i18n';
import { useStore } from '../../store';
import { isSidebarDatabasePinned } from './sidebarDatabasePinning';

export const buildNacosNamespacePinMenuItem = (
  connectionId: string, namespaceId: string, onRefresh: () => void,
) => {
  const isPinned = isSidebarDatabasePinned(
    useStore.getState().pinnedSidebarDatabases, connectionId, namespaceId,
  );
  return {
    key: isPinned ? 'unpin-nacos-namespace' : 'pin-nacos-namespace',
    label: t(isPinned ? 'nacos.namespace.menu.unpin' : 'nacos.namespace.menu.pin'),
    icon: <PushpinOutlined />,
    onClick: () => {
      const store = useStore.getState();
      const nextPinned = !isSidebarDatabasePinned(
        store.pinnedSidebarDatabases, connectionId, namespaceId,
      );
      store.setSidebarDatabasePinned(connectionId, namespaceId, nextPinned);
      onRefresh();
    },
  };
};
