import { Tag, Typography } from 'antd';
import { AppstoreOutlined, DownloadOutlined, SafetyCertificateOutlined, StarOutlined } from '@ant-design/icons';
import { useI18n } from '../i18n/provider';
import type { MarketPlugin } from './types';

export function MarketDetailOverview({ plugin, source, trustedOfficial }: { plugin: MarketPlugin; source: string; trustedOfficial: boolean }) {
  const { t } = useI18n();
  const platforms = Array.from(new Set(plugin.platforms));
  return <div className="market-detail-overview">
    <header className="market-detail-hero">
      <div className="market-detail-icon"><AppstoreOutlined aria-hidden /></div>
      <div className="market-detail-heading">
        <Typography.Title level={4}>{plugin.name}</Typography.Title>
        <code className="market-detail-id">{plugin.id}</code>
        <div className="market-detail-badges"><Tag>{plugin.version}</Tag>
          {trustedOfficial && plugin.official && <Tag color="success" icon={<SafetyCertificateOutlined aria-hidden />}>{t('plugin.market.official')}</Tag>}
        </div>
      </div>
    </header>
    <div className="market-detail-metrics">
      <span><StarOutlined aria-hidden />{plugin.ratingCount ? t('plugin.market.rating_summary', { average: plugin.ratingAverage.toFixed(2), count: plugin.ratingCount }) : t('plugin.market.no_ratings')}</span>
      <span><DownloadOutlined aria-hidden />{t('plugin.market.downloads', { count: plugin.downloadCount.toLocaleString() })}</span>
    </div>
    <section className="market-detail-section" aria-label={t('plugin.market.detail_about')}>
      <Typography.Title level={5}>{t('plugin.market.detail_about')}</Typography.Title>
      <Typography.Paragraph className="market-detail-description">{plugin.description || t('plugin.market.detail_not_provided')}</Typography.Paragraph>
    </section>
    <section className="market-detail-section market-detail-information" aria-label={t('plugin.market.detail_information')}>
      <Typography.Title level={5}>{t('plugin.market.detail_information')}</Typography.Title>
      <dl className="market-detail-fields">
        <div><dt>{t('plugin.market.detail_author')}</dt><dd>{plugin.author || t('plugin.market.detail_not_provided')}</dd></div>
        {plugin.minHostVersion && <div><dt>{t('plugin.market.detail_host')}</dt><dd><code>{plugin.minHostVersion}</code></dd></div>}
        <div className="market-detail-field-wide"><dt>{t('plugin.market.detail_platforms')}</dt>
          <dd className="market-detail-platforms">{platforms.length ? platforms.map((platform) => <Tag key={platform} className="market-detail-platform-badge">{platform}</Tag>) : t('plugin.market.detail_not_provided')}</dd></div>
        <div className="market-detail-field-wide"><dt>{t('plugin.label.source')}</dt><dd><code className="market-detail-source">{source}</code></dd></div>
      </dl>
    </section>
  </div>;
}
