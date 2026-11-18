import { Button, Rate, Tag, Typography } from 'antd';
import { AppstoreOutlined, ArrowUpOutlined, DownloadOutlined, SafetyCertificateOutlined } from '@ant-design/icons';
import { useI18n } from '../i18n/provider';
import { PluginLogo } from '../components/pluginManager/PluginLogo';
import { useMarketPluginIcon } from './useMarketPluginIcon';
import { compareMarketVersions } from './versionCompare';
import type { MarketPlugin } from './types';

interface Props { plugin: MarketPlugin; installedVersion?: string; sourceId?: string; retryKey?: string | number; onSelect: () => void; sourceScoped?: boolean; onInstall?: () => void; allowed?: boolean }
export function MarketPluginCard({ plugin, installedVersion, sourceId, retryKey = 0, onSelect, sourceScoped = false, onInstall, allowed = true }: Props) {
  const { t } = useI18n();
  const remoteIcon = useMarketPluginIcon(plugin, sourceId, installedVersion === undefined, retryKey);
  const upgradeAvailable = installedVersion !== undefined && compareMarketVersions(installedVersion, plugin.version) < 0;
  const sameVersionInstalled = installedVersion !== undefined && installedVersion === plugin.version;
  return <article className="plugin-card plugin-market-card" data-official={plugin.official}>
    <header className="plugin-card-header"><div className="plugin-market-card-heading">
      <PluginLogo pluginId={plugin.id} name={plugin.name} version={installedVersion ?? plugin.version} installed={installedVersion !== undefined} remoteSources={remoteIcon} retryKey={retryKey} fallback={<AppstoreOutlined aria-hidden />} />
      <Typography.Title level={5}>{plugin.name}</Typography.Title></div>
      {plugin.official && <Tag color="success" icon={<SafetyCertificateOutlined />}>{t('plugin.market.official')}</Tag>}</header>
    <code className="plugin-identity">{plugin.id} · {plugin.version}</code>
    {installedVersion !== undefined && (sourceScoped
      ? <Tag>{t('plugin.market.installed_identity', { version: installedVersion })}</Tag>
      : upgradeAvailable
      ? <Tag className="plugin-market-upgrade" color="processing" icon={<ArrowUpOutlined />}>{t('plugin.market.upgrade_available', { version: plugin.version })}</Tag>
      : <Tag>{t('plugin.market.installed_version', { version: installedVersion })}</Tag>)}
    <Typography.Paragraph className="plugin-market-description" ellipsis={{ rows: 3 }}>{plugin.description}</Typography.Paragraph>
    <div className="plugin-market-card-meta">
      <span>{t('plugin.market.author', { name: plugin.author })}</span>
      {plugin.minHostVersion && <span className="plugin-market-requirement">{t('plugin.market.requires_host', { version: plugin.minHostVersion })}</span>}
    </div>
    <footer className="plugin-market-card-footer">
      <div className="plugin-market-metrics">
        {plugin.ratingCount > 0 ? <><Rate disabled allowHalf value={plugin.ratingAverage} /><span>{t('plugin.market.rating_summary', { average: plugin.ratingAverage.toFixed(2), count: plugin.ratingCount })}</span></>
          : <span>{t('plugin.market.no_ratings')}</span>}
        <span>{t('plugin.market.downloads', { count: plugin.downloadCount.toLocaleString() })}</span>
      </div>
      <div className="plugin-market-card-actions">
        <Button onClick={onSelect}>{t('plugin.market.details')}</Button>
        {onInstall && <Button type="primary" icon={<DownloadOutlined aria-hidden />} disabled={!allowed || sameVersionInstalled}
          title={!allowed ? t('plugin.install.disabled_hint') : sameVersionInstalled ? t('plugin.market.installed_version', { version: installedVersion ?? '' }) : undefined}
          onClick={onInstall}>{sameVersionInstalled ? t('plugin.market.versions.installed') : t('plugin.market.install')}</Button>}
      </div>
    </footer>
  </article>;
}
