import { useId } from 'react';
import { Button, Input, Select } from 'antd';
import { ClearOutlined } from '@ant-design/icons';
import { useI18n } from '../i18n/provider';
import { CATALOG_CATEGORIES, CATALOG_PLATFORMS, selectedPlatforms, type MarketFilterState } from './catalogFilters';
import type { MarketSource } from './types';

interface Props { sources: MarketSource[]; value: MarketFilterState; onChange: (value: MarketFilterState) => void; onReset: () => void }
export function MarketSearchFilters({ sources, value, onChange, onReset }: Props) {
  const { t } = useI18n();
  const prefix = useId();
  const field = (key: string) => prefix + key;
  return <section className="plugin-market-filter-panel" aria-label={t('plugin.market.filters_title')}>
    <div className="plugin-market-filter-heading"><span>{t('plugin.market.filters_title')}</span>
      <Button type="text" icon={<ClearOutlined aria-hidden />} onClick={onReset}>{t('plugin.market.filters_reset')}</Button></div>
    <div className="plugin-market-filter-grid">
      <div><label htmlFor={field('sources')}>{t('plugin.market.filter_sources')}</label>
        <Select id={field('sources')} aria-label={t('plugin.market.filter_sources')} mode="multiple" allowClear maxTagCount="responsive"
          placeholder={t('plugin.market.filter_all_sources')} value={value.sourceIds} onChange={(sourceIds: string[]) => onChange({ ...value, sourceIds })}
          options={sources.map((source) => ({ value: source.sourceId, label: source.baseUrl }))} /></div>
      <div><label htmlFor={field('category')}>{t('plugin.market.filter_categories')}</label>
        <Select id={field('category')} aria-label={t('plugin.market.filter_categories')} mode="multiple" allowClear maxTagCount="responsive"
          placeholder={t('plugin.market.filter_all_categories')} value={value.categories} onChange={(categories: string[]) => onChange({ ...value, categories })}
          options={CATALOG_CATEGORIES.map((category) => ({ value: category, label: t('plugin.market.category.' + category) }))} /></div>
      <div><label htmlFor={field('identity')}>{t('plugin.market.filter_identity')}</label>
        <Select id={field('identity')} aria-label={t('plugin.market.filter_identity')} value={value.official} onChange={(official: MarketFilterState['official']) => onChange({ ...value, official })}
          options={[{ value: '', label: t('plugin.market.filter_any_identity') }, { value: 'official', label: t('plugin.market.official') }, { value: 'community', label: t('plugin.market.filter_community') }]} /></div>
      <div><label htmlFor={field('platform')}>{t('plugin.market.filter_platforms')}</label>
        <Select id={field('platform')} aria-label={t('plugin.market.filter_platforms')} mode="multiple" maxTagCount="responsive" value={value.platforms.length ? value.platforms : ['current']}
          onChange={(next: string[]) => onChange({ ...value, platforms: selectedPlatforms(next, value.platforms) })}
          options={[{ value: 'current', label: t('plugin.market.filter_current_platform') }, { value: 'all', label: t('plugin.market.filter_all_platforms') }, ...CATALOG_PLATFORMS.map((platform) => ({ value: platform, label: platform }))]} /></div>
      <div><label htmlFor={field('author')}>{t('plugin.market.filter_author')}</label>
        <Input id={field('author')} aria-label={t('plugin.market.filter_author')} allowClear maxLength={200} value={value.author}
          placeholder={t('plugin.market.filter_author_placeholder')} onChange={(event) => onChange({ ...value, author: event.target.value })} /></div>
    </div>
    <span className="plugin-market-filter-hint">{t('plugin.market.filters_hint')}</span>
  </section>;
}
