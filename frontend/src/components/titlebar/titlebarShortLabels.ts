type Translate = (key: string) => string;

/**
 * 标题栏「图标 + 文字」模式下的精简名称，完整名称仍用于悬浮提示与无障碍名。
 * 这里只覆盖 Sidebar 注入的快捷入口；AI、关于本身已足够短。
 */
export const resolveTitlebarQuickActionShortLabel = (key: string, t: Translate): string | undefined => {
  switch (key) {
    case 'data-workflow':
      return t('app.titlebar.short_label.data_workflow');
    case 'sql-tools':
      return t('app.titlebar.short_label.sql_tools');
    case 'user-management':
      return t('app.titlebar.short_label.user_management');
    case 'session-workbench':
      return t('app.titlebar.short_label.session_workbench');
    case 'drivers':
      return t('app.titlebar.short_label.drivers');
    default:
      return undefined;
  }
};
