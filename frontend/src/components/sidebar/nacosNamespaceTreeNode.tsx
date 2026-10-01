import React from 'react';
import { CloudOutlined, DatabaseOutlined } from '@ant-design/icons';
import { t } from '../../i18n';
import type { SavedConnection } from '../../types';
import type { SidebarTreeNode } from '../sidebarV2Utils';

export const buildNacosNamespaceTreeNode = (
  sourceConnection: SavedConnection, namespaceId: string, showName: string,
  configCount: number, discoveryMode: 'listed' | 'configured',
): SidebarTreeNode => {
  const nodeKeyId = namespaceId || 'public';
  const nsDataRef = {
      ...sourceConnection,
      nacosNamespaceId: namespaceId,
      nacosNamespaceName: showName,
      nacosConfigCount: Number.isFinite(configCount) ? configCount : 0,
      nacosNamespaceDiscoveryMode: discoveryMode,
  };
  return {
      title: showName,
      key: `${sourceConnection.id}-nacos-ns-${nodeKeyId}`,
      icon: <DatabaseOutlined style={{ color: '#2E6BE6' }} />,
      type: 'nacos-namespace',
      dataRef: nsDataRef,
      isLeaf: false,
      children: [
          {
              title: t('nacos_viewer.title.config_explorer'),
              key: `${sourceConnection.id}-nacos-ns-${nodeKeyId}-config`,
              icon: <DatabaseOutlined style={{ color: '#2E6BE6' }} />,
              type: 'nacos-config-entry',
              dataRef: nsDataRef,
              // Expand to load Group list.
              isLeaf: false,
          },
          {
              title: t('nacos_service.title.service_explorer'),
              key: `${sourceConnection.id}-nacos-ns-${nodeKeyId}-services`,
              icon: <CloudOutlined style={{ color: '#13C2C2' }} />,
              type: 'nacos-services-entry',
              dataRef: nsDataRef,
              isLeaf: false,
          },
      ],
  };

};
