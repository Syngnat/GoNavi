import { Alert, Button, Empty, Spin, Typography } from 'antd';
import { useI18n } from '../i18n/provider';
import { useSourceCatalog } from './useSourceCatalog';
import { MarketSourceHeader } from './MarketSourceHeader';
import { MarketPluginCard } from './MarketPluginCard';
import { SourceErrorNotice } from './SourceErrorNotice';
import type { MarketPlugin, MarketSource, MarketSort } from './types';
import type { CatalogFilters } from './catalogFilters';

interface Props { filters?: CatalogFilters; source: MarketSource; query: string; sort: MarketSort; revision: number; allowed: boolean; installed: ReadonlyMap<string, string>;
  onSelect: (plugin: MarketPlugin, source: MarketSource) => void; onClearSearch: () => void }
export function MarketSourceGroup({ source, query, sort, revision, allowed, installed, onSelect, onClearSearch, filters }: Props) {
  const { t } = useI18n();
  const catalog = useSourceCatalog(source.sourceId, source.trustedOfficial, query, sort, revision, filters);
  return <section className="plugin-market-group" aria-label={source.baseUrl} data-source-id={source.sourceId}>
    <MarketSourceHeader source={source} refreshing={catalog.refreshing} onRefresh={catalog.reload} />
    {catalog.stale && <Alert type="warning" showIcon message={t('plugin.market.cached')} description={catalog.cachedAt ? t('plugin.market.cached_at', { time: catalog.cachedAt }) : undefined} />}
    {catalog.warning && <Alert type="warning" showIcon message={catalog.warning} />}
    {catalog.error && <SourceErrorNotice source={source.baseUrl} error={catalog.error} onRetry={catalog.reload} />}
    <div className="plugin-market-group-body" aria-busy={catalog.loading || catalog.refreshing}>
      {catalog.loading && <div className="plugin-market-loading"><Spin /></div>}
      {!catalog.loading && !catalog.error && catalog.items.length === 0 && <div className="plugin-market-empty">
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t(query ? 'plugin.market.empty_search' : 'plugin.market.empty')}>
          <Button onClick={query ? onClearSearch : catalog.reload}>{t(query ? 'plugin.market.reset_search' : 'plugin.action.refresh')}</Button>
        </Empty>
      </div>}
      <div className="plugin-market-grid">{catalog.items.map((plugin) => <MarketPluginCard key={plugin.id} plugin={plugin} sourceScoped
        installedVersion={installed.get(plugin.id)} onSelect={() => onSelect(plugin, source)} />)}</div>
    </div>
    <footer className="plugin-market-pagination">
      <Typography.Text type="secondary" aria-live="polite">{catalog.refreshing && <Spin size="small" aria-label={t('plugin.action.refresh')} />} {t('plugin.market.source_page', { page: catalog.page, count: catalog.items.length })}</Typography.Text>
      <div className="plugin-market-page-actions">
        <Button disabled={catalog.loading || catalog.refreshing || catalog.page <= 1} onClick={catalog.previous}>{t('plugin.market.source_previous')}</Button>
        <Button disabled={catalog.loading || catalog.refreshing || !catalog.canNext} onClick={catalog.next}>{t('plugin.market.source_next')}</Button>
      </div>
    </footer>
  </section>;
}
