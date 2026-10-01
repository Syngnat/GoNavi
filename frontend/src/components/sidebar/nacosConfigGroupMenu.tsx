import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { FileTextOutlined, PushpinOutlined } from '@ant-design/icons';
import { t } from '../../i18n';
import { useStore } from '../../store';
import type { SidebarTreeNode } from '../sidebarV2Utils';
import { buildNacosGroupPinScope, isNacosGroupPinned, pinNacosConfigGroupNodes } from '../nacos/nacosPinning';

export const buildNacosConfigGroupMenu = (
  node: SidebarTreeNode, addTab: (tab: Record<string, unknown>) => void,
  treeDataRef?: MutableRefObject<SidebarTreeNode[]>,
  setTreeData?: Dispatch<SetStateAction<SidebarTreeNode[]>>,
) => {
  const data = node.dataRef || {};
  const id = String(data.id || '');
  const namespaceId = String(data.nacosNamespaceId || '');
  const namespaceKey = namespaceId || 'public';
  const namespaceName = String(data.nacosNamespaceName || namespaceId || 'public');
  const isAll = !!data.nacosAllConfigs;
  const group = isAll ? '' : String(data.nacosGroup || '').trim() || 'DEFAULT_GROUP';
  const pinned = isNacosGroupPinned(useStore.getState().pinnedSidebarDatabases, id, namespaceId, group);
  return [
    {
      key: 'open-nacos-group',
      label: t(isAll ? 'nacos_viewer.action.open_all_configs' : 'nacos_viewer.action.open_group_configs'),
      icon: <FileTextOutlined />,
      onClick: () => addTab({
        id: isAll ? `nacos-config-${id}-ns-${namespaceKey}` : `nacos-config-${id}-ns-${namespaceKey}-g-${encodeURIComponent(group)}`,
        title: isAll ? `${namespaceName} · ${t('nacos_viewer.label.all')}` : `${namespaceName} · ${group}`,
        type: 'nacos-config', connectionId: id, nacosNamespaceId: namespaceId, nacosNamespaceName: namespaceName,
        ...(isAll ? {} : { nacosGroup: group }),
      }),
    },
    ...(!isAll ? [{
      key: pinned ? 'unpin-nacos-group' : 'pin-nacos-group',
      label: t(pinned ? 'nacos.pin.unpin_group' : 'nacos.pin.pin_group'),
      icon: <PushpinOutlined />,
      onClick: () => {
        const store = useStore.getState();
        store.setSidebarDatabasePinned(id, buildNacosGroupPinScope(namespaceId, group),
          !isNacosGroupPinned(store.pinnedSidebarDatabases, id, namespaceId, group));
        const keys = useStore.getState().pinnedSidebarDatabases;
        const update = (nodes: SidebarTreeNode[]): SidebarTreeNode[] => nodes.map((item) => {
          if (item.type === 'nacos-config-entry' && item.dataRef?.id === id
            && String(item.dataRef.nacosNamespaceId || '') === namespaceId && item.children) {
            return { ...item, children: pinNacosConfigGroupNodes(item.children, keys, id, namespaceId) };
          }
          return item.children ? { ...item, children: update(item.children) } : item;
        });
        if (treeDataRef && setTreeData) {
          const next = update(treeDataRef.current);
          treeDataRef.current = next;
          setTreeData(next);
        }
      },
    }] : []),
  ];
};
