import { t } from '../../i18n';
import {
  DeleteOutlined, EditOutlined, MessageOutlined,
} from '@ant-design/icons';
import type { MenuProps } from 'antd';
import type { SidebarNodeMenuContext } from './sidebarNodeMenuHelpers';

export interface BuildAgentIntegrationMenuItemsInput {
  node: any;
  context: SidebarNodeMenuContext;
}

/**
 * 智能体节点的右键菜单：与数据连接节点同级的操作能力——打开会话管理、
 * 编辑（展示名 / 数据目录）、移除（只删配置）。
 */
export const buildAgentIntegrationMenuItems = ({ node, context }: BuildAgentIntegrationMenuItemsInput): MenuProps['items'] => {
  const {
    openAgentWorkbench, openAgentIntegrationEditor, removeAgentIntegration,
  } = context;
  return [
    {
      key: 'open-agent-workbench',
      label: t('sidebar.menu.open_agent_sessions'),
      icon: <MessageOutlined />,
      onClick: () => {
        openAgentWorkbench?.(node);
      },
    },
    {
      key: 'edit-agent-integration',
      label: t('sidebar.menu.edit_agent'),
      icon: <EditOutlined />,
      onClick: () => {
        openAgentIntegrationEditor?.(node);
      },
    },
    { type: 'divider' },
    {
      key: 'remove-agent-integration',
      label: t('sidebar.menu.remove_agent'),
      icon: <DeleteOutlined />,
      danger: true,
      onClick: () => {
        removeAgentIntegration?.(node);
      },
    },
  ];
};
