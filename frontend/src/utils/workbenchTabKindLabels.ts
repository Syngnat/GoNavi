import { t } from '../i18n';
import type { TabData } from '../types';

/** 标签页类型徽标文案；TabManager 与浮动窗口共用，避免两处分叉。 */
export const getWorkbenchTabKindLabel = (tab: TabData): string => {
  if (tab.type === 'query') return t('tab_manager.kind_badge.query');
  if (tab.type === 'table') return t('tab_manager.kind_badge.table');
  if (tab.type === 'design') return t('tab_manager.kind_badge.design');
  if (tab.type === 'table-overview') return t('tab_manager.kind_badge.table_overview');
  if (tab.type === 'table-export') return t('tab_manager.kind_badge.table_export');
  if (tab.type === 'data-import') return t('tab_manager.kind_badge.data_import');
  if (tab.type === 'data-sync') {
    return t(
      tab.dataSyncEntryMode === 'compare' ||
        tab.dataSyncEntryMode === 'schemaCompare' ||
        tab.dataSyncEntryMode === 'dataCompare'
        ? 'app.tools.entry.compare.title'
        : 'app.tools.entry.sync.title',
    );
  }
  if (tab.type === 'sql-file-execution') return t('sidebar.sql_file_exec.title');
  if (tab.type === 'sql-analysis') return t('tab_manager.kind_badge.sql_analysis');
  if (tab.type === 'sql-audit') return t('tab_manager.kind_badge.sql_audit');
  if (tab.type === 'dml-snapshot') return t('tab_manager.kind_badge.dml_snapshot');
  if (tab.type === 'user-management') return t('tab_manager.kind_badge.user_management');
  if (tab.type === 'driver-manager') return t('tab_manager.kind_badge.driver_manager');
  if (tab.type === 'settings-center') return t('tab_manager.kind_badge.settings_center');
  if (tab.type === 'message-queue') return t('message_queue_workbench.tab_kind');
  if (tab.type.startsWith('redis')) return t('tab_manager.kind_badge.redis');
  if (tab.type.startsWith('jvm')) return t('tab_manager.kind_badge.jvm');
  if (tab.type === 'trigger') return t('tab_manager.kind_badge.trigger');
  if (tab.type === 'view-def') {
    return tab.viewKind === 'materialized'
      ? t('tab_manager.kind_badge.materialized_view')
      : t('tab_manager.kind_badge.view');
  }
  if (tab.type === 'event-def') return t('tab_manager.kind_badge.event');
  if (tab.type === 'routine-def') return t('tab_manager.kind_badge.routine');
  if (tab.type === 'sequence-def') return t('tab_manager.kind_badge.sequence');
  if (tab.type === 'package-def') return t('tab_manager.kind_badge.package');
  if (tab.type === 'database-link-def') return t('tab_manager.kind_badge.database_link');
  return t('tab_manager.kind_badge.fallback');
};

/** 标签页悬停提示中的类型文案。 */
export const getWorkbenchTabKindTooltipLabel = (tab: TabData): string => {
  if (tab.type === 'query') return t('tab_manager.hover.kind.query');
  if (tab.type === 'table') return t('tab_manager.hover.kind.table');
  if (tab.type === 'design') return t('tab_manager.hover.kind.design');
  if (tab.type === 'table-overview') return t('tab_manager.hover.kind.table_overview');
  if (tab.type === 'table-export') return t('tab_manager.hover.kind.table_export');
  if (tab.type === 'data-import') return t('tab_manager.hover.kind.data_import');
  if (tab.type === 'data-sync') {
    return t(
      tab.dataSyncEntryMode === 'compare' ||
        tab.dataSyncEntryMode === 'schemaCompare' ||
        tab.dataSyncEntryMode === 'dataCompare'
        ? 'app.tools.entry.compare.title'
        : 'app.tools.entry.sync.title',
    );
  }
  if (tab.type === 'sql-file-execution') return t('sidebar.sql_file_exec.title');
  if (tab.type === 'sql-analysis') return t('tab_manager.hover.kind.sql_analysis');
  if (tab.type === 'sql-audit') return t('tab_manager.hover.kind.sql_audit');
  if (tab.type === 'dml-snapshot') return t('tab_manager.hover.kind.dml_snapshot');
  if (tab.type === 'user-management') return t('tab_manager.hover.kind.user_management');
  if (tab.type === 'driver-manager') return t('tab_manager.hover.kind.driver_manager');
  if (tab.type === 'settings-center') return t('tab_manager.hover.kind.settings_center');
  if (tab.type === 'message-queue') return t('message_queue_workbench.tab_kind');
  if (tab.type === 'redis-keys') return t('tab_manager.hover.kind.redis_keys');
  if (tab.type === 'redis-command') return t('tab_manager.hover.kind.redis_command');
  if (tab.type === 'redis-monitor') return t('tab_manager.hover.kind.redis_monitor');
  if (tab.type === 'nacos-config') return t('tab_manager.hover.kind.nacos_config');
  if (tab.type === 'nacos-services') return t('tab_manager.hover.kind.nacos_services');
  if (tab.type === 'jvm-overview') return t('tab_manager.hover.kind.jvm_overview');
  if (tab.type === 'jvm-resource') return t('tab_manager.hover.kind.jvm_resource');
  if (tab.type === 'jvm-audit') return t('tab_manager.hover.kind.jvm_audit');
  if (tab.type === 'jvm-diagnostic') return t('tab_manager.hover.kind.jvm_diagnostic');
  if (tab.type === 'jvm-monitoring') return t('tab_manager.hover.kind.jvm_monitoring');
  if (tab.type === 'trigger') return t('tab_manager.hover.kind.trigger');
  if (tab.type === 'view-def') {
    return tab.viewKind === 'materialized'
      ? t('tab_manager.hover.kind.materialized_view')
      : t('tab_manager.hover.kind.view');
  }
  if (tab.type === 'event-def') return t('tab_manager.hover.kind.event');
  if (tab.type === 'routine-def') return t('tab_manager.hover.kind.routine');
  if (tab.type === 'sequence-def') return t('tab_manager.hover.kind.sequence');
  if (tab.type === 'package-def') return t('tab_manager.hover.kind.package');
  if (tab.type === 'database-link-def') return t('tab_manager.hover.kind.database_link');
  return t('tab_manager.hover.kind.fallback');
};
