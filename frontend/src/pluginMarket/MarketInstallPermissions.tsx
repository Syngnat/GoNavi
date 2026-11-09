import type { ReactNode } from 'react';
import { AppstoreOutlined, DatabaseOutlined, ExportOutlined, RobotOutlined } from '@ant-design/icons';
import { Typography } from 'antd';
import type { PluginManifest } from '../plugins/types';
import { useI18n } from '../i18n/provider';
import { pluginPermissionText } from '../plugins/permissionLabel';

interface Props {
  manifest: PluginManifest;
}

type PermissionCategory = 'data' | 'ai' | 'ui' | 'export';

interface PermissionCard {
  key: PermissionCategory;
  title: string;
  icon: ReactNode;
  permissions: string[];
  detail: string;
}

const dataPermissions = new Set([
  'data.sources',
  'host.query.read',
  'host.schema.write',
  'host.metadata.read',
  'host.connections.read',
  'host.connections.credentials',
]);

function categoryOf(permission: string): PermissionCategory {
  if (dataPermissions.has(permission)) return 'data';
  if (permission.startsWith('ai.')) return 'ai';
  if (permission === 'data.export') return 'export';
  return 'ui';
}

export function MarketInstallPermissions({ manifest }: Props) {
  const { t } = useI18n();
  const permissions = manifest.permissions ?? [];
  const notes = manifest.permissionNotes;
  const contributes = manifest.contributes;
  const dataSources = contributes?.dataSources ?? [];
  const skills = contributes?.skills ?? [];
  const providers = contributes?.aiProviders ?? [];
  const pages = (contributes?.pages?.length ?? 0) + (manifest.window ? 1 : 0);
  const exporters = contributes?.exporters ?? [];

  const grouped: Record<PermissionCategory, string[]> = { data: [], ai: [], ui: [], export: [] };
  permissions.forEach(permission => { grouped[categoryOf(permission)].push(permission); });

  const fallback = (count: number) => t('plugin.market.install_permission_fallback', { count });
  const allCards: PermissionCard[] = [
    {
      key: 'data',
      title: t('plugin.market.install_permission_data'),
      icon: <DatabaseOutlined />,
      permissions: grouped.data,
      detail: dataSources.length > 0
        ? t('plugin.market.install_permission_data_detail', { count: dataSources.length })
        : fallback(grouped.data.length),
    },
    {
      key: 'ai',
      title: t('plugin.market.install_permission_ai'),
      icon: <RobotOutlined />,
      permissions: grouped.ai,
      detail: skills.length > 0 || providers.length > 0
        ? t('plugin.market.install_permission_ai_detail', { skills: skills.length, providers: providers.length })
        : fallback(grouped.ai.length),
    },
    {
      key: 'ui',
      title: t('plugin.market.install_permission_ui'),
      icon: <AppstoreOutlined />,
      permissions: grouped.ui,
      detail: pages > 0
        ? t('plugin.market.install_permission_ui_detail', { count: pages })
        : fallback(grouped.ui.length),
    },
    {
      key: 'export',
      title: t('plugin.market.install_permission_export'),
      icon: <ExportOutlined />,
      permissions: grouped.export,
      detail: exporters.length > 0
        ? t('plugin.market.install_permission_export_detail', { count: exporters.length })
        : fallback(grouped.export.length),
    },
  ];
  const cards = allCards.filter(card => card.permissions.length > 0);

  return (
    <section className="market-install-permissions" data-component="market-install-permissions">
      <div className="market-install-section-heading">
        <Typography.Text strong>{t('plugin.install.permissions')}</Typography.Text>
        <Typography.Text type="secondary">{t('plugin.market.install_permission_total', { count: permissions.length })}</Typography.Text>
      </div>
      {cards.length === 0 ? (
        <Typography.Text type="secondary">{t('plugin.install.no_permissions')}</Typography.Text>
      ) : (
        <div className="market-install-permission-grid">
          {cards.map(card => (
            <article className="market-install-permission" data-category={card.key} key={card.key}>
              <span className="market-install-permission-icon" aria-hidden>{card.icon}</span>
              <div className="market-install-permission-body">
                <div className="market-install-permission-head">
                  <Typography.Text strong>{card.title}</Typography.Text>
                  <span>{t('plugin.market.install_permission_count', { count: card.permissions.length })}</span>
                </div>
                <span className="market-install-permission-detail">{card.detail}</span>
                <div className="market-install-permission-chips">
                  {card.permissions.map(permission => (
                    <code key={permission} title={pluginPermissionText(permission, t, notes?.[permission])}>{permission}</code>
                  ))}
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
