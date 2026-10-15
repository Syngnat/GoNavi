import React, { useMemo } from 'react';

import { useStore } from '../../store';
import { t } from '../../i18n';
import {
  type ObjectOverviewKind,
  openObjectOverview,
} from '../../components/objectOverview/objectOverviewActions';
import { SIDEBAR_LOCATE_SAVED_QUERIES_EVENT } from '../../utils/sidebarLocate';
import { buildDatabaseExportWorkbenchTab, buildBatchTableExportWorkbenchTab } from '../../utils/tableExportTab';
import { buildDataImportWorkbenchTab } from '../../utils/dataImportTab';
import WorkbenchToolbarObjectActions, {
  type WorkbenchToolbarObjectMenuChild,
  type WorkbenchToolbarObjectActionItem,
} from '../layout/WorkbenchToolbarObjectActions';
import {
  TitlebarBackupIcon,
  TitlebarDesignTableIcon,
  TitlebarErModelIcon,
  TitlebarEventIcon,
  TitlebarExportIcon,
  TitlebarFunctionIcon,
  TitlebarImportIcon,
  TitlebarOpenTableIcon,
  TitlebarSavedQueryIcon,
  TitlebarTableIcon,
  TitlebarViewIcon,
  TitlebarExternalSqlIcon,
} from '../../components/titlebar/gonaviTitlebarObjectIcons';

// 组装工具条「对象类」按钮（对齐 Navicat 原型 + 评审收敛）：
// 常显：表 / 视图 / 函数 / 事件 / 查询 / 备份；
// 次级能力（打开表 / 设计表 / 导入 / 导出 / 模型 / 外部 SQL）收进「其它」下拉——
// 顶栏是场景菜单，不是功能清单。
//
// 列表与向导类按钮作用于当前活动上下文（store.activeContext）；
// 打开表 / 设计表 / 模型 还要求选中了具体表。

interface WorkbenchToolbarContext {
  connectionId: string;
  dbName: string;
  schemaName?: string;
  tableName: string;
}

const resolveToolbarContext = (
  activeContext: { connectionId?: string; dbName?: string; schemaName?: string; tableName?: string } | null,
): WorkbenchToolbarContext => ({
  connectionId: String(activeContext?.connectionId || ''),
  dbName: String(activeContext?.dbName || ''),
  schemaName: String(activeContext?.schemaName || '').trim() || undefined,
  tableName: String(activeContext?.tableName || '').trim(),
});

const hasActiveDatabase = (
  context: WorkbenchToolbarContext,
  connections: Array<{ id: string }>,
): boolean => (
  context.connectionId !== ''
  && context.dbName !== ''
  && connections.some(c => c.id === context.connectionId)
);

export const useWorkbenchToolbarObjectActions = (): { node: React.ReactNode } => {
  const connections = useStore(state => state.connections);
  const activeContext = useStore(state => state.activeContext);
  const addTab = useStore(state => state.addTab);
  const sidebarExternalSqlVisible = useStore(state => state.sidebarExternalSqlVisible);
  const toggleSidebarExternalSqlVisible = useStore(state => state.toggleSidebarExternalSqlVisible);
  // 对象类按钮只属于 Navicat 布局主题；classic 保持既有工具条形态。
  const navicatLayout = useStore(state => state.appearance.uiLayoutMode === 'navicat');

  const context = resolveToolbarContext(activeContext);
  const contextReady = hasActiveDatabase(context, connections);
  const tableReady = contextReady && context.tableName !== '';
  const needDatabase = t('workbench.toolbar.tooltip.need_database');
  const needTable = t('workbench.toolbar.tooltip.need_table');
  const tabIdSuffix = `${context.connectionId}-${context.dbName}${context.schemaName ? `-${context.schemaName}` : ''}`;

  const items = useMemo<WorkbenchToolbarObjectActionItem[]>(() => {
    const overviewButton = (
      key: ObjectOverviewKind,
      label: string,
      icon: React.ReactNode,
    ): WorkbenchToolbarObjectActionItem => ({
      type: 'button',
      key,
      label,
      title: contextReady ? label : needDatabase,
      icon,
      disabled: !contextReady,
      onClick: () => openObjectOverview(addTab, key, {
        connectionId: context.connectionId,
        dbName: context.dbName,
        schemaName: context.schemaName,
      }),
    });

    const openTableTab = (mode: 'data' | 'design' | 'er') => {
      if (!tableReady) return;
      addTab({
        id: mode === 'design'
          ? `design-${tabIdSuffix}-${context.tableName}`
          : `${tabIdSuffix}-${context.tableName}`,
        title: mode === 'design'
          ? t('table_overview.tab.design_table_title', { table: context.tableName })
          : context.tableName,
        type: mode === 'design' ? 'design' : 'table',
        connectionId: context.connectionId,
        dbName: context.dbName,
        tableName: context.tableName,
        schemaName: context.schemaName,
        ...(mode === 'design' ? { initialTab: 'columns' } : { objectType: 'table' }),
        ...(mode === 'er' ? { initialViewMode: 'er' as const, initialViewModeRequestId: String(Date.now()) } : {}),
      } as any);
    };

    const openTableButton: WorkbenchToolbarObjectActionItem = {
      type: 'button',
      key: 'open-table',
      label: t('workbench.toolbar.open_table'),
      title: tableReady ? t('workbench.toolbar.open_table') : needTable,
      icon: <TitlebarOpenTableIcon size="100%" />,
      disabled: !tableReady,
      onClick: () => openTableTab('data'),
    };
    const designTableButton: WorkbenchToolbarObjectActionItem = {
      type: 'button',
      key: 'design-table',
      label: t('workbench.toolbar.design_table'),
      title: tableReady ? t('workbench.toolbar.design_table') : needTable,
      icon: <TitlebarDesignTableIcon size="100%" />,
      disabled: !tableReady,
      onClick: () => openTableTab('design'),
    };
    const importWizardButton: WorkbenchToolbarObjectActionItem = {
      type: 'button',
      key: 'import-wizard',
      label: t('workbench.toolbar.import_wizard'),
      title: contextReady ? t('workbench.toolbar.import_wizard') : needDatabase,
      icon: <TitlebarImportIcon size="100%" />,
      disabled: !contextReady,
      onClick: () => {
        if (!contextReady) return;
        addTab(buildDataImportWorkbenchTab({
          connectionId: context.connectionId,
          dbName: context.dbName,
          mode: 'database',
        }));
      },
    };
    const exportWizardButton: WorkbenchToolbarObjectActionItem = {
      type: 'button',
      key: 'export-wizard',
      label: t('workbench.toolbar.export_wizard'),
      title: contextReady ? t('workbench.toolbar.export_wizard') : needDatabase,
      icon: <TitlebarExportIcon size="100%" />,
      disabled: !contextReady,
      onClick: () => {
        if (!contextReady) return;
        addTab(buildBatchTableExportWorkbenchTab({
          connectionId: context.connectionId,
          dbName: context.dbName,
          title: t('workbench.toolbar.export_wizard'),
        }));
      },
    };
    const modelButton: WorkbenchToolbarObjectActionItem = {
      type: 'button',
      key: 'model',
      label: t('workbench.toolbar.model'),
      title: tableReady ? t('workbench.toolbar.model') : needTable,
      icon: <TitlebarErModelIcon size="100%" />,
      disabled: !tableReady,
      onClick: () => openTableTab('er'),
    };
    const externalSqlButton: WorkbenchToolbarObjectActionItem = {
      type: 'button',
      key: 'external-sql',
      label: t('workbench.toolbar.external_sql'),
      title: t('workbench.toolbar.external_sql_hint'),
      icon: <TitlebarExternalSqlIcon size="100%" />,
      disabled: false,
      active: sidebarExternalSqlVisible,
      onClick: () => toggleSidebarExternalSqlVisible(),
    };
    const moreMenuChildren: WorkbenchToolbarObjectMenuChild[] = [
      openTableButton.type === 'button' ? {
        type: 'menu-item' as const,
        key: openTableButton.key,
        label: openTableButton.label,
        icon: openTableButton.icon,
        title: openTableButton.title,
        disabled: openTableButton.disabled,
        onClick: openTableButton.onClick,
      } : { type: 'divider' as const, key: 'open-table-divider' },
      designTableButton.type === 'button' ? {
        type: 'menu-item' as const,
        key: designTableButton.key,
        label: designTableButton.label,
        icon: designTableButton.icon,
        title: designTableButton.title,
        disabled: designTableButton.disabled,
        onClick: designTableButton.onClick,
      } : { type: 'divider' as const, key: 'design-table-divider' },
      importWizardButton.type === 'button' ? {
        type: 'menu-item' as const,
        key: importWizardButton.key,
        label: importWizardButton.label,
        icon: importWizardButton.icon,
        title: importWizardButton.title,
        disabled: importWizardButton.disabled,
        onClick: importWizardButton.onClick,
      } : { type: 'divider' as const, key: 'import-wizard-divider' },
      exportWizardButton.type === 'button' ? {
        type: 'menu-item' as const,
        key: exportWizardButton.key,
        label: exportWizardButton.label,
        icon: exportWizardButton.icon,
        title: exportWizardButton.title,
        disabled: exportWizardButton.disabled,
        onClick: exportWizardButton.onClick,
      } : { type: 'divider' as const, key: 'export-wizard-divider' },
      modelButton.type === 'button' ? {
        type: 'menu-item' as const,
        key: modelButton.key,
        label: modelButton.label,
        icon: modelButton.icon,
        title: modelButton.title,
        disabled: modelButton.disabled,
        onClick: modelButton.onClick,
      } : { type: 'divider' as const, key: 'model-divider' },
      { type: 'divider' as const, key: 'more-external-sql-sep' },
      externalSqlButton.type === 'button' ? {
        type: 'menu-item' as const,
        key: externalSqlButton.key,
        label: externalSqlButton.label,
        icon: externalSqlButton.icon,
        title: externalSqlButton.title,
        disabled: externalSqlButton.disabled,
        onClick: externalSqlButton.onClick,
      } : { type: 'divider' as const, key: 'external-sql-divider' },
    ];

    return [
      overviewButton('tables', t('workbench.toolbar.tables'), <TitlebarTableIcon size="100%" />),
      overviewButton('views', t('workbench.toolbar.views'), <TitlebarViewIcon size="100%" />),
      overviewButton('routines', t('workbench.toolbar.functions'), <TitlebarFunctionIcon size="100%" />),
      overviewButton('events', t('workbench.toolbar.events'), <TitlebarEventIcon size="100%" />),
      {
        type: 'button',
        key: 'saved-queries',
        label: t('workbench.toolbar.saved_queries'),
        title: t('workbench.toolbar.saved_queries'),
        icon: <TitlebarSavedQueryIcon size="100%" />,
        disabled: false,
        onClick: () => {
          window.dispatchEvent(new CustomEvent(SIDEBAR_LOCATE_SAVED_QUERIES_EVENT));
        },
      },
      {
        type: 'button',
        key: 'backup',
        label: t('workbench.toolbar.backup'),
        title: contextReady ? t('workbench.toolbar.backup') : needDatabase,
        icon: <TitlebarBackupIcon size="100%" />,
        disabled: !contextReady,
        onClick: () => {
          if (!contextReady) return;
          addTab(buildDatabaseExportWorkbenchTab({
            connectionId: context.connectionId,
            dbName: context.dbName,
            contentMode: 'backup',
            includeDropIfExists: false,
          }));
        },
      },
      { type: 'divider', key: 'sep-more' },
      {
        type: 'overflow',
        key: 'more',
        label: t('workbench.toolbar.more'),
        title: t('workbench.toolbar.more_hint'),
        children: moreMenuChildren,
      },
    ];
  }, [addTab, context, contextReady, needDatabase, needTable, sidebarExternalSqlVisible, tableReady, tabIdSuffix, toggleSidebarExternalSqlVisible]);

  const node = useMemo(() => (
    navicatLayout ? <WorkbenchToolbarObjectActions items={items} /> : null
  ), [items, navicatLayout]);

  return { node };
};
