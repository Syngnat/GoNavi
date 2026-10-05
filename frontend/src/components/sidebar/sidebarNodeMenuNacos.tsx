import { t } from '../../i18n';
import { CloudOutlined, FileTextOutlined, EditOutlined, DeleteOutlined } from '@ant-design/icons';
import { buildNacosServicesTabData } from '../sidebarV2Utils';
import {
  type SidebarNodeMenuContext, isNacosNamespaceStructureRestricted, resolveCurrentNacosConnection,
  resolveCurrentNacosNamespaceDiscoveryMode, openNacosNamespaceFormModal,
  assertNacosNamespaceDiscoveryAllowsCrud, assertNacosNamespaceStructureEditable,
} from './sidebarNodeMenuHelpers';
import { type MenuProps, message } from 'antd';
import { buildNacosConfigGroupMenu } from './nacosConfigGroupMenu';
import type { SavedConnection } from '../../types';
import { buildNacosNamespacePinMenuItem } from './nacosNamespacePinMenu';
import Modal from '../common/ResizableDraggableModal';
import { confirmProductionMutation } from '../../utils/productionRiskConfirm';
import { buildRpcConnectionConfig } from '../../utils/connectionRpcConfig';

export interface BuildNacosServiceGroupMenuItemsInput {
  node: any;
  context: SidebarNodeMenuContext;
}

export const buildNacosServiceGroupMenuItems = ({ node, context }: BuildNacosServiceGroupMenuItemsInput): MenuProps['items'] => {
  const { addTab } = context;
  return [
      {
          key: 'open-nacos-service-group',
          label: t('nacos_service.title.service_explorer'),
          icon: <CloudOutlined />,
          onClick: () => addTab(buildNacosServicesTabData(node.dataRef || {})),
      },
  ];
};

export interface BuildNacosConfigGroupMenuItemsInput {
  node: any;
  context: SidebarNodeMenuContext;
}

export const buildNacosConfigGroupMenuItems = ({ node, context }: BuildNacosConfigGroupMenuItemsInput): MenuProps['items'] => {
  const { addTab, treeDataRef, setTreeData } = context;
  return buildNacosConfigGroupMenu(node, addTab, treeDataRef, setTreeData);
};

export interface BuildNacosEntryMenuItemsInput {
  node: any;
  context: SidebarNodeMenuContext;
}

export const buildNacosEntryMenuItems = ({ node, context }: BuildNacosEntryMenuItemsInput): MenuProps['items'] => {
  const { addTab } = context;
  const {
      id,
      nacosNamespaceId = '',
      nacosNamespaceName = '',
  } = node.dataRef || {};
  const nsName = nacosNamespaceName || nacosNamespaceId || 'public';
  const nsKey = nacosNamespaceId || 'public';
  const isServices = node.type === 'nacos-services-entry';
  return [
      {
          key: 'open-nacos-entry',
          label: isServices
              ? t('nacos_service.title.service_explorer')
              : t('nacos_viewer.action.open_all_configs'),
          icon: isServices ? <CloudOutlined /> : <FileTextOutlined />,
          onClick: () => {
              addTab({
                  id: isServices
                      ? `nacos-services-${id}-ns-${nsKey}`
                      : `nacos-config-${id}-ns-${nsKey}`,
                  title: isServices ? `${nsName} · services` : nsName,
                  type: isServices ? 'nacos-services' : 'nacos-config',
                  connectionId: id,
                  nacosNamespaceId: nacosNamespaceId || '',
                  nacosNamespaceName: nsName,
              });
          },
      },
  ];
};

export interface BuildNacosNamespaceMenuItemsInput {
  node: any;
  context: SidebarNodeMenuContext;
}

export const buildNacosNamespaceMenuItems = ({ node, context }: BuildNacosNamespaceMenuItemsInput): MenuProps['items'] => {
  const { getNacosNamespaceDiscoveryMode, addTab, loadDatabases } = context;
  const {
      id,
      nacosNamespaceId = '',
      nacosNamespaceName = '',
      config,
  } = node.dataRef || {};
  const nsName = nacosNamespaceName || nacosNamespaceId || 'public';
  const nsKey = nacosNamespaceId || 'public';
  const isPublicNs = !String(nacosNamespaceId || '').trim() || String(nacosNamespaceId).toLowerCase() === 'public';
  const namespaceConnection = { id, config } as SavedConnection;
  const nacosStructureRestricted = isNacosNamespaceStructureRestricted(
      resolveCurrentNacosConnection(namespaceConnection).config,
  );
  const isNamespaceManagementBlocked = () =>
      resolveCurrentNacosNamespaceDiscoveryMode(
          id,
          node,
          getNacosNamespaceDiscoveryMode,
      ) === 'configured';
  const usesConfiguredNacosNamespace =
      isNamespaceManagementBlocked();
  const parentConnectionNode = {
      key: id,
      type: 'connection',
      dataRef: node.dataRef,
  };
  return [
      {
          key: 'open-nacos-config',
          label: t('nacos_viewer.title.config_explorer'),
          icon: <FileTextOutlined />,
          onClick: () => {
              addTab({
                  id: `nacos-config-${id}-ns-${nsKey}`,
                  title: nsName,
                  type: 'nacos-config',
                  connectionId: id,
                  nacosNamespaceId: nacosNamespaceId || '',
                  nacosNamespaceName: nsName,
              });
          },
      },
      {
          key: 'open-nacos-services',
          label: t('nacos_service.title.service_explorer'),
          icon: <CloudOutlined />,
          onClick: () => {
              addTab({
                  id: `nacos-services-${id}-ns-${nsKey}`,
                  title: `${nsName} · services`,
                  type: 'nacos-services',
                  connectionId: id,
                  nacosNamespaceId: nacosNamespaceId || '',
                  nacosNamespaceName: nsName,
              });
          },
      },
      buildNacosNamespacePinMenuItem(String(id || ''), nsKey, () => {
          void loadDatabases(parentConnectionNode, { ensureFresh: true });
      }),
      {
          key: 'edit-nacos-namespace',
          label: t('nacos.namespace.menu.edit'),
          icon: <EditOutlined />,
          disabled:
              isPublicNs ||
              nacosStructureRestricted ||
              usesConfiguredNacosNamespace,
          onClick: () => {
              if (isNamespaceManagementBlocked()) return;
              const currentConnection = resolveCurrentNacosConnection(namespaceConnection);
              if (
                  isPublicNs
                  || isNacosNamespaceStructureRestricted(currentConnection.config)
              ) return;
              openNacosNamespaceFormModal({
                  mode: 'edit',
                  connection: currentConnection,
                  initial: {
                      id: nacosNamespaceId || '',
                      showName: nsName,
                      description: '',
                  },
                  onSuccess: () => loadDatabases(parentConnectionNode, { ensureFresh: true }),
                  isNamespaceManagementBlocked,
              });
          },
      },
      {
          key: 'delete-nacos-namespace',
          label: t('nacos.namespace.menu.delete'),
          icon: <DeleteOutlined />,
          danger: true,
          disabled:
              isPublicNs ||
              nacosStructureRestricted ||
              usesConfiguredNacosNamespace,
          onClick: () => {
              if (isNamespaceManagementBlocked()) return;
              const currentConnection = resolveCurrentNacosConnection(namespaceConnection);
              if (
                  isPublicNs
                  || isNacosNamespaceStructureRestricted(currentConnection.config)
              ) return;
              Modal.confirm({
                  title: t('nacos.namespace.menu.delete'),
                  content: t('nacos.namespace.message.confirm_delete', {
                      name: nsName,
                      id: nacosNamespaceId || '',
                  }),
                  okButtonProps: { danger: true },
                  onOk: async () => {
                      assertNacosNamespaceDiscoveryAllowsCrud(
                          isNamespaceManagementBlocked,
                      );
                      const latestConnection =
                          assertNacosNamespaceStructureEditable(currentConnection);
                      if (!await confirmProductionMutation(
                          latestConnection,
                          t('connection.production_risk.action.modify_configuration'),
                          [nacosNamespaceId, nsName].filter(Boolean).join(' / '),
                          t,
                      )) return;
                      const rpcConfig = buildRpcConnectionConfig(
                          latestConnection.config as any,
                      );
                      const res = await (window as any).go.app.App.NacosDeleteNamespace(
                          rpcConfig,
                          nacosNamespaceId || '',
                      );
                      if (!res?.success) {
                          message.error(res?.message || 'delete failed');
                          throw new Error(res?.message || 'delete failed');
                      }
                      await loadDatabases(parentConnectionNode, { ensureFresh: true });
                      message.success(t('nacos.namespace.message.delete_success'));
                  },
              });
          },
      },
  ];
};
