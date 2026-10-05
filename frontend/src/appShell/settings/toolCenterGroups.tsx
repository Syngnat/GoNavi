import {
  SettingOutlined, UploadOutlined, DownloadOutlined, SafetyCertificateOutlined, HddOutlined,
  FileTextOutlined, SwitcherOutlined, CodeOutlined, LinkOutlined, AuditOutlined, BugOutlined,
} from '@ant-design/icons';
import type { SettingsCenterNavigationGroup } from '../settingsCenterNavigation';
import AiSparkOutlined from '../../components/icons/AiSparkOutlined';
import { buildSqlAuditWorkbenchTab } from '../../utils/sqlAuditTab';
import { buildRequestDiagnosticsWorkbenchTab } from '../../utils/requestDiagnosticsTab';
import { buildDMLSnapshotWorkbenchTab } from '../../utils/dmlSnapshotTab';
import type { RenderAppSettingsCenterModalInput } from './renderAppSettingsCenterModal';

export interface BuildToolCenterGroupsInput {
  t: RenderAppSettingsCenterModalInput['t'];
  handleOpenToolCenterPane: RenderAppSettingsCenterModalInput['handleOpenToolCenterPane'];
  handleExportConnections: RenderAppSettingsCenterModalInput['handleExportConnections'];
  handleOpenConnectionHealth: RenderAppSettingsCenterModalInput['handleOpenConnectionHealth'];
  securityUpdateEntryVisibility: RenderAppSettingsCenterModalInput['securityUpdateEntryVisibility'];
  securityUpdateHasLegacySensitiveItems: RenderAppSettingsCenterModalInput['securityUpdateHasLegacySensitiveItems'];
  securityUpdateStatusMeta: RenderAppSettingsCenterModalInput['securityUpdateStatusMeta'];
  handleOpenDataSyncWorkbench: RenderAppSettingsCenterModalInput['handleOpenDataSyncWorkbench'];
  handleCancelSettingsCenterPane: RenderAppSettingsCenterModalInput['handleCancelSettingsCenterPane'];
  addTab: RenderAppSettingsCenterModalInput['addTab'];
}

export const buildToolCenterGroups = ({
  t, handleOpenToolCenterPane, handleExportConnections, handleOpenConnectionHealth,
  securityUpdateEntryVisibility, securityUpdateHasLegacySensitiveItems, securityUpdateStatusMeta,
  handleOpenDataSyncWorkbench, handleCancelSettingsCenterPane, addTab,
}: BuildToolCenterGroupsInput) => {
  const toolCenterGroups: SettingsCenterNavigationGroup[] = [
    {
      key: 'config',
      icon: <SettingOutlined />,
      title: t('app.tools.group.config.title'),
      description: t('app.tools.group.config.description'),
      items: [
        {
          key: 'import',
          icon: <UploadOutlined />,
          title: t('app.tools.entry.import.title'),
          description: t('app.tools.entry.import.description'),
          onClick: () => {
            handleOpenToolCenterPane('config', 'import');
          },
        },
        {
          key: 'export',
          icon: <DownloadOutlined />,
          title: t('app.tools.entry.export.title'),
          description: t('app.tools.entry.export.description'),
          onClick: () => {
            handleOpenToolCenterPane('config', 'export');
            void handleExportConnections('config');
          },
        },
        {
          key: 'connection-health',
          icon: <SafetyCertificateOutlined />,
          title: t('app.tools.entry.connection_health.title'),
          description: t('app.tools.entry.connection_health.description'),
          onClick: () => {
            handleOpenToolCenterPane('config', 'connection-health');
            handleOpenConnectionHealth();
          },
        },
        {
          key: 'data-root',
          icon: <HddOutlined />,
          title: t('app.tools.entry.data_root.title'),
          description: t('app.tools.entry.data_root.description'),
          onClick: () => {
            handleOpenToolCenterPane('config', 'data-root-application');
          },
          children: [
            {
              key: 'data-root-application',
              icon: <HddOutlined />,
              title: t('app.data_root.current_directory'),
              description: t('app.data_root.description'),
              onClick: () => handleOpenToolCenterPane('config', 'data-root-application'),
            },
            {
              key: 'data-root-agent',
              icon: <AiSparkOutlined />,
              title: t('app.data_root.agent_data.title'),
              description: t('app.data_root.agent_data.description'),
              onClick: () => handleOpenToolCenterPane('config', 'data-root-agent'),
            },
            {
              key: 'data-root-saved-queries',
              icon: <FileTextOutlined />,
              title: t('app.data_root.saved_query_directory.title'),
              description: t('app.data_root.saved_query_directory.description'),
              onClick: () => handleOpenToolCenterPane('config', 'data-root-saved-queries'),
            },
          ],
        },
        {
          key: 'security-update',
          icon: <SafetyCertificateOutlined />,
          title: t('app.tools.entry.security_update.title'),
          description: securityUpdateEntryVisibility.showDetailEntry || securityUpdateHasLegacySensitiveItems
            ? t('app.tools.entry.security_update.status_description', { status: securityUpdateStatusMeta.label })
            : t('app.tools.entry.security_update.description'),
          onClick: () => {
            handleOpenToolCenterPane('config', 'security-update');
          },
        },
      ],
    },
    {
      key: 'workflow',
      icon: <SwitcherOutlined />,
      title: t('app.tools.group.workflow.title'),
      description: t('app.tools.group.workflow.description'),
      items: [
        {
          key: 'sync',
          icon: <UploadOutlined rotate={90} />,
          title: t('app.tools.entry.sync.title'),
          description: t('app.tools.entry.sync.description'),
          onClick: () => {
            handleOpenDataSyncWorkbench('sync');
          },
        },
        {
          key: 'compare',
          icon: <SwitcherOutlined />,
          title: t('app.tools.entry.compare.title'),
          description: t('app.tools.entry.compare.description'),
          onClick: () => {
            handleOpenDataSyncWorkbench('compare');
          },
        },
      ],
    },
    {
      key: 'workspace',
      icon: <CodeOutlined />,
      title: t('app.tools.group.workspace.title'),
      description: t('app.tools.group.workspace.description'),
      items: [
        {
          key: 'drivers',
          icon: <SettingOutlined />,
          title: t('app.tools.entry.drivers.title'),
          description: t('app.tools.entry.drivers.description'),
          onClick: () => {
            handleOpenToolCenterPane('workspace', 'drivers');
          },
        },
        {
          key: 'snippet-settings',
          icon: <CodeOutlined />,
          title: t('app.tools.entry.snippets.title'),
          description: t('app.tools.entry.snippets.description'),
          onClick: () => {
            handleOpenToolCenterPane('workspace', 'snippet-settings');
          },
        },
        {
          key: 'shortcut-settings',
          icon: <LinkOutlined />,
          title: t('app.tools.entry.shortcuts.title'),
          description: t('app.tools.entry.shortcuts.description'),
          onClick: () => {
            handleOpenToolCenterPane('workspace', 'shortcut-settings');
          },
        },
        {
          key: 'sql-audit',
          icon: <AuditOutlined />,
          title: t('app.tools.entry.sql_audit.title'),
          description: t('app.tools.entry.sql_audit.description'),
          onClick: () => {
            handleCancelSettingsCenterPane();
            addTab(buildSqlAuditWorkbenchTab());
          },
        },
        {
          key: 'request-diagnostics',
          icon: <BugOutlined />,
          title: t('app.tools.entry.request_diagnostics.title'),
          description: t('app.tools.entry.request_diagnostics.description'),
          onClick: () => {
            handleCancelSettingsCenterPane();
            addTab(buildRequestDiagnosticsWorkbenchTab());
          },
        },
        {
          key: 'dml-snapshot',
          icon: <SafetyCertificateOutlined />,
          title: t('dml_snapshot.workbench.title'),
          description: t('dml_snapshot.workbench.description'),
          onClick: () => {
            handleCancelSettingsCenterPane();
            addTab(buildDMLSnapshotWorkbenchTab());
          },
        },
      ],
    },
  ];
  return { toolCenterGroups };
};
