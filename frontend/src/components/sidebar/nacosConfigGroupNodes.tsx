import React from 'react';
import { AppstoreOutlined, FolderOpenOutlined } from '@ant-design/icons';
import { t } from '../../i18n';
import type { SidebarTreeNode } from '../sidebarV2Utils';
import { pinNacosConfigGroupNodes } from '../nacos/nacosPinning';

export const buildPinnedNacosConfigGroups = (
  dataRef: Record<string, unknown>, groups: readonly string[], pinnedKeys: readonly string[],
): SidebarTreeNode[] => {
  const connectionId = String(dataRef.id || '');
  const namespaceId = String(dataRef.nacosNamespaceId ?? '');
  const namespaceName = String(dataRef.nacosNamespaceName || namespaceId || 'public');
  const nodeKeyId = namespaceId || 'public';
  const allNode: SidebarTreeNode = {
    title: t('nacos_viewer.label.all'),
    key: `${connectionId}-nacos-ns-${nodeKeyId}-group-__all__`,
    icon: <AppstoreOutlined style={{ color: '#2E6BE6' }} />,
    type: 'nacos-config-group',
    dataRef: { ...dataRef, nacosNamespaceId: namespaceId, nacosNamespaceName: namespaceName, nacosGroup: '', nacosAllConfigs: true },
    isLeaf: true,
  };
  const groupNodes: SidebarTreeNode[] = groups.map((group) => ({
    title: group,
    key: `${connectionId}-nacos-ns-${nodeKeyId}-group-${encodeURIComponent(group)}`,
    icon: <FolderOpenOutlined style={{ color: '#2E6BE6' }} />,
    type: 'nacos-config-group',
    dataRef: { ...dataRef, nacosNamespaceId: namespaceId, nacosNamespaceName: namespaceName, nacosGroup: group, nacosAllConfigs: false },
    isLeaf: true,
  }));
  return pinNacosConfigGroupNodes([allNode, ...groupNodes], pinnedKeys, connectionId, namespaceId);
};
