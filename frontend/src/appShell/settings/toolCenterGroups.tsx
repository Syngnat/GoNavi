import {
  SettingOutlined, SafetyCertificateOutlined, HddOutlined,
  FileTextOutlined,
} from '@ant-design/icons';
import type { SettingsCenterNavigationGroup } from '../settingsCenterNavigation';
import AiSparkOutlined from '../../components/icons/AiSparkOutlined';
import type { RenderAppSettingsCenterModalInput } from './renderAppSettingsCenterModal';

export interface BuildToolCenterGroupsInput {
  t: RenderAppSettingsCenterModalInput['t'];
  handleOpenToolCenterPane: RenderAppSettingsCenterModalInput['handleOpenToolCenterPane'];
  securityUpdateEntryVisibility: RenderAppSettingsCenterModalInput['securityUpdateEntryVisibility'];
  securityUpdateHasLegacySensitiveItems: RenderAppSettingsCenterModalInput['securityUpdateHasLegacySensitiveItems'];
  securityUpdateStatusMeta: RenderAppSettingsCenterModalInput['securityUpdateStatusMeta'];
}

export const buildToolCenterGroups = ({
  t, handleOpenToolCenterPane,
  securityUpdateEntryVisibility, securityUpdateHasLegacySensitiveItems, securityUpdateStatusMeta,
}: BuildToolCenterGroupsInput) => {
  // 插件不进设置中心导航树：入口在标题栏工具条（titlebarTrailingActions），
  // 以独立工作台 Tab 打开（utils/pluginManagerTab）。
  const toolCenterGroups: SettingsCenterNavigationGroup[] = [
    {
      key: 'config',
      icon: <SettingOutlined />,
      title: t('app.tools.group.config.title'),
      description: t('app.tools.group.config.description'),
      items: [
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
  ];
  return { toolCenterGroups };
};
