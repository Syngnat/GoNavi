import { Button, Rate, Tag, Typography } from 'antd';
import { ArrowUpOutlined, SafetyCertificateOutlined } from '@ant-design/icons';
import { useI18n } from '../i18n/provider';
import { compareMarketVersions } from './versionCompare';
import type { MarketPlugin } from './types';

export function MarketPluginCard({ plugin, installedVersion, onSelect, sourceScoped = false }: { plugin: MarketPlugin; installedVersion?: string; onSelect: () => void; sourceScoped?: boolean }) {
  const { t } = useI18n();
  const upgradeAvailable = installedVersion !== undefined && compareMarketVersions(installedVersion, plugin.version) < 0;
  return <article className="plugin-card plugin-market-card" data-official={plugin.official}>
    <header className="plugin-card-header"><Typography.Title level={5}>{plugin.name}</Typography.Title>
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
      <Button onClick={onSelect}>{t('plugin.market.details')}</Button>
    </footer>
  </article>;
}
