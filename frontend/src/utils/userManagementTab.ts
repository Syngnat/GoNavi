import { t } from '../i18n';
import type { TabData } from '../types';

export const USER_MANAGEMENT_TAB_PREFIX = 'user-management:';
/** 未选定连接时的入口标签：工作台内展示连接选择器。 */
export const USER_MANAGEMENT_PICKER_TAB_ID = `${USER_MANAGEMENT_TAB_PREFIX}picker`;

/** 每个连接一个用户管理标签；重复打开会激活已有标签（addTab 按 id 去重）。 */
export const buildUserManagementWorkbenchTab = (connectionId?: string): TabData => {
  const normalized = String(connectionId || '').trim();
  return {
    id: normalized ? `${USER_MANAGEMENT_TAB_PREFIX}${normalized}` : USER_MANAGEMENT_PICKER_TAB_ID,
    title: t('user_management.tab.title'),
    type: 'user-management',
    connectionId: normalized,
  };
};
