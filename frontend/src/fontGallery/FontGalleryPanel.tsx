import { Alert, Button, Select } from 'antd';
import { useEffect, useMemo } from 'react';
import { useI18n } from '../i18n/provider';
import { useFontGalleryPanel, fontEntryKey } from './useFontGalleryPanel';
import { fontFamilyKey, systemHasFamily } from './options';
import { buildFontCatalogRows, type CatalogRow } from './catalogRows';
import { FontGalleryDetail } from './FontGalleryDetail';
import type { InstalledFontFamily } from '../utils/fontFamilies';
import './FontGalleryPanel.css';

interface Props {
  installedFontFamilies: InstalledFontFamily[];
  onEnable: (kind: 'ui' | 'mono', cssFamily: string) => void;
  activeUi?: string | null;
  activeMono?: string | null;
}

interface CatalogOption {
  value: string;
  label: string;
  row: CatalogRow;
}

export function FontGalleryPanel({ installedFontFamilies, onEnable, activeUi, activeMono }: Props) {
  const { t, language } = useI18n();
  const gallery = useFontGalleryPanel();
  const rows = useMemo(() => buildFontCatalogRows(gallery.entries),
    [gallery.entries]);
  const nameOf = (row: CatalogRow) => row.names[language] || row.names['en-US'] || row.family;
  const selected = rows.find(row => row.id === gallery.selectedId) || rows[0] || null;
  const installed = (row: CatalogRow) => gallery.installed.find(item => item.entry.id === row.id || fontFamilyKey(item.entry.family) === fontFamilyKey(row.family));
  const local = (row: CatalogRow) => systemHasFamily(installedFontFamilies, row.family);
  const selectedInstalled = selected ? installed(selected) : undefined;
  const selectedEntry = selected ? selectedInstalled?.entry ?? selected.remote : undefined;
  // 选中即预览：默认字体与点击选中的字体都自动加载预览，仅随 id+版本变化触发，避免行对象每次重建引发循环。
  useEffect(() => {
    if (selectedEntry) gallery.preview(selectedEntry, selectedInstalled);
  }, [selectedEntry ? fontEntryKey(selectedEntry) : null]);
  const status = (row: CatalogRow) => local(row)
    ? t('app.theme.font_family.gallery.status_system')
    : installed(row) ? t('app.theme.font_family.gallery.status_downloaded')
      : t(row.remote ? 'app.theme.font_family.gallery.status_remote' : 'app.theme.font_family.gallery.status_catalog_pending');
  return <section className="gonavi-font-gallery" aria-label={t('app.theme.font_family.gallery.title')}>
    <h3 className="gonavi-font-gallery-heading">{t('app.theme.font_family.gallery.title')}</h3>
    <p className="gonavi-settings-inline-meta">{t('app.theme.font_family.gallery.description')}</p>
    <div className="gonavi-font-gallery-controls">
      <Select<{ value: string; label: string }, CatalogOption>
        className="gonavi-font-gallery-select"
        aria-label={t('app.theme.font_family.gallery.title')}
        showSearch
        labelInValue
        optionLabelProp="label"
        loading={gallery.loading}
        value={selected ? { value: selected.id, label: nameOf(selected) } : undefined}
        options={rows.map(row => ({ value: row.id, label: nameOf(row), row }))}
        filterOption={(input, option) => {
          const needle = input.trim().toLowerCase();
          if (!needle || !option) return Boolean(option);
          const row = (option as CatalogOption).row;
          return row.family.toLowerCase().includes(needle)
            || Object.values(row.names).some(name => name.toLowerCase().includes(needle));
        }}
        onChange={next => { if (next?.value) gallery.setSelectedId(next.value); }}
        listHeight={288}
        optionRender={({ data }) => (
          <div className="gonavi-font-option">
            <span className="gonavi-font-option-name" title={data.label}>{data.label}</span>
            <span className="gonavi-font-option-source">{status(data.row)}</span>
          </div>
        )}
      />
      <Button disabled={gallery.loading || Boolean(gallery.pending)} onClick={() => { void gallery.refresh(); }}>
        {t('app.theme.font_family.gallery.refresh')}
      </Button>
    </div>
    {gallery.error && <Alert type="error" showIcon role="alert" message={t(gallery.error)} />}
    {gallery.state.stale && <Alert type="warning" showIcon message={t('app.theme.font_family.gallery.stale')} />}
    {selected && <FontGalleryDetail key={selected.id} row={selected} name={nameOf(selected)} local={local(selected)}
      installed={installed(selected)} gallery={gallery} activeUi={activeUi} activeMono={activeMono} onEnable={onEnable} />}
  </section>;
}
