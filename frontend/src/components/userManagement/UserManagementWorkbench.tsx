import { useStore } from '../../store';
import type { TabData } from '../../types';
import UserManagementConnectionPicker from './UserManagementConnectionPicker';
import UserManagementConsole from './UserManagementConsole';
import { resolveUserManagementBackend, type UserManagementBackend } from './userManagementRpc';
import './UserManagementWorkbench.css';

interface UserManagementWorkbenchProps {
  tab: TabData;
  isActive?: boolean;
  backend?: UserManagementBackend;
}

/** 用户管理工作台：标签绑定连接时进入控制台，否则展示连接选择器。 */
export default function UserManagementWorkbench({ tab, backend: backendOverride }: UserManagementWorkbenchProps) {
  const connections = useStore((state) => state.connections);
  const connection = connections.find((item) => item.id === tab.connectionId) || null;
  const backend = backendOverride ?? resolveUserManagementBackend();
  if (!connection) {
    return <UserManagementConnectionPicker currentTabId={tab.id} />;
  }
  return <UserManagementConsole key={connection.id} connection={connection} backend={backend} />;
}
