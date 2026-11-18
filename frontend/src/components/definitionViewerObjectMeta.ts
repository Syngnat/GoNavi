import type { TabData } from '../types';

type Translate = (key: string) => string;

export const resolveDefinitionViewerObjectMeta = (tab: TabData, translate: Translate) => {
  if (tab.type === 'job-def') {
    return {
      label: translate('definition_viewer.object.job'),
      name: tab.jobLabel || tab.jobName,
      loadingTip: translate('definition_viewer.loading.job_definition'),
    };
  }
  if (tab.type === 'view-def') {
    const materialized = tab.viewKind === 'materialized';
    return {
      label: translate(materialized ? 'definition_viewer.object.materialized_view' : 'definition_viewer.object.view'),
      name: tab.viewName,
      loadingTip: translate('definition_viewer.loading.view_definition'),
    };
  }
  if (tab.type === 'event-def') {
    return {
      label: translate('definition_viewer.object.event'),
      name: tab.eventName,
      loadingTip: translate('definition_viewer.loading.event_definition'),
    };
  }
  if (tab.type === 'sequence-def') {
    return {
      label: translate('definition_viewer.object.sequence'),
      name: tab.sequenceName,
      loadingTip: translate('definition_viewer.loading.sequence_definition'),
    };
  }
  if (tab.type === 'package-def') {
    return {
      label: translate('definition_viewer.object.package'),
      name: tab.packageName,
      loadingTip: translate('definition_viewer.loading.package_definition'),
    };
  }
  if (tab.type === 'database-link-def') {
    return {
      label: translate('definition_viewer.object.database_link'),
      name: tab.databaseLinkName,
      loadingTip: translate('definition_viewer.loading.database_link_definition'),
    };
  }
  if (tab.type === 'database-def') {
    return {
      label: translate('definition_viewer.object.database'),
      name: tab.dbName,
      loadingTip: translate('definition_viewer.loading.database_definition'),
    };
  }
  return {
    label: translate('definition_viewer.object.routine'),
    name: tab.routineName,
    loadingTip: translate('definition_viewer.loading.routine_definition'),
  };
};
