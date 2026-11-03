import { useState } from 'react';
import { LayoutPreferencePreview } from './LayoutPreferencePreview';
import { TablePreferencePreview } from './TablePreferencePreview';
import { InputNumber, Select, Switch } from 'antd';
import { useStore } from '../../../store';
import { useOptionalI18n } from '../../../i18n/provider';
import { t as defaultTranslate } from '../../../i18n';
import type { AppearanceSettings } from '../../../store/storeStateTypes';
import { resolveLowSpecModeActive, detectRuntimeCapabilityCached } from '../../../utils/runtimeCapability';

export { QUICK_PREFERENCE_KEYS as PREFERENCE_CONTROL_KEYS } from '../../../utils/favoriteSettings';
export type { QuickPreference as PreferenceControl } from '../../../utils/favoriteSettings';
import { QUICK_PREFERENCE_KEYS as PREFERENCE_CONTROL_KEYS, type QuickPreference as PreferenceControl, toggleFavoriteSetting, DEFAULT_FAVORITE_SETTINGS } from '../../../utils/favoriteSettings';
const booleanFields = { collapse: 'workbenchSidebarAutoCollapse', singleDatabase: 'sidebarSingleDatabaseExpansion', rows: 'showDataTableRowNumber', borders: 'showDataTableVerticalBorders', motion: 'reduceMotion' } as const;

export function PreferenceControls({ controls, compact = false, tablePreview, collapsiblePreviews = false }: { controls: readonly PreferenceControl[]; compact?: boolean; tablePreview?: boolean; collapsiblePreviews?: boolean }) {
  const [previewOpen, setPreviewOpen] = useState(false);
  const t = useOptionalI18n()?.t ?? defaultTranslate;
  const appearance = useStore(state => state.appearance);
  const favorites = appearance.favoriteSettings ?? DEFAULT_FAVORITE_SETTINGS;
  const setAppearance = useStore(state => state.setAppearance);
  const scale = useStore(state => state.uiScale);
  const setScale = useStore(state => state.setUiScale);
  const log = useStore(state => state.queryOptions.showSqlExecutionLog);
  const setQueryOptions = useStore(state => state.setQueryOptions);
  const control = (key: PreferenceControl) => {
    const label = t(PREFERENCE_CONTROL_KEYS[key]);
    if (key in booleanFields) {
      const field = booleanFields[key as keyof typeof booleanFields];
      return <Switch aria-label={label} checked={appearance[field] === true} onChange={value => setAppearance({ [field]: value } as Partial<AppearanceSettings>)} />;
    }
    if (key === 'layout') return <Switch aria-label={label} checked={appearance.uiLayoutMode === 'navicat'} onChange={value => setAppearance({ uiLayoutMode: value ? 'navicat' : 'classic' })} />;
    if (key === 'scale') return <InputNumber aria-label={label} min={80} max={125} step={5} value={Math.round(scale * 100)} addonAfter="%" onChange={value => { if (value !== null) setScale(value / 100); }} />;
    if (key === 'log') return <Switch aria-label={label} checked={log !== false} onChange={value => setQueryOptions({ showSqlExecutionLog: value })} />;
    if (key === 'lowSpec') return <Switch aria-label={label} checked={resolveLowSpecModeActive(appearance.lowSpecMode, detectRuntimeCapabilityCached().lowSpec)} onChange={value => setAppearance({ lowSpecMode: value })} />;
    if (key === 'doubleClick') return <Select aria-label={label} value={appearance.tableDoubleClickAction} options={[
      { value: 'open-data', label: t('app.theme.data_table.table_double_click_action.open_data') },
      { value: 'open-design', label: t('app.theme.data_table.table_double_click_action.open_design') },
    ]} onChange={value => setAppearance({ tableDoubleClickAction: value })} />;
    return <Select aria-label={label} value={appearance.dataTableDensity} options={['compact', 'standard', 'comfortable'].map(value => ({ value, label: t(`app.theme.data_table.density.${value}`) }))} onChange={value => setAppearance({ dataTableDensity: value })} />;
  };
  const lastTableControl = controls.filter(key => ['density', 'rows', 'borders'].includes(key)).slice(-1)[0];
  return <div className={`gn-preference-controls${compact ? ' is-compact' : ''}`}>
    {controls.map(key => <div className="gn-preference-control-block" key={key}>
      <div className="gn-preference-control" data-preference-control={key}>
        <label>{t(PREFERENCE_CONTROL_KEYS[key])}</label>
        <div className="gn-preference-control-actions">
          {!compact && collapsiblePreviews && (key === 'layout' || (key === lastTableControl && tablePreview !== false)) && <button type="button" className="gn-preference-preview-toggle" aria-expanded={previewOpen}
            aria-label={t('settings.preview.show_named', { name: t(PREFERENCE_CONTROL_KEYS[key]) })} onClick={() => setPreviewOpen(!previewOpen)}>{t(previewOpen ? 'settings.preview.hide' : 'settings.preview.show')}</button>}
          <div className="gn-preference-control-input">{control(key)}</div>
          {!compact && <button className={`gn-preference-pin${favorites.includes(key) ? ' is-pinned' : ''}`} type="button"
            aria-label={t(favorites.includes(key) ? 'settings.favorites.remove_label' : 'settings.favorites.add_label', { name: t(PREFERENCE_CONTROL_KEYS[key]) })}
            title={t(favorites.includes(key) ? 'settings.favorites.remove_label' : 'settings.favorites.add_label', { name: t(PREFERENCE_CONTROL_KEYS[key]) })}
            onClick={() => setAppearance({ favoriteSettings: toggleFavoriteSetting(favorites, key) })}>
            {favorites.includes(key) ? '★' : '☆'}
          </button>}
        </div>
      </div>
      {!compact && (!collapsiblePreviews || previewOpen) && key === 'layout' && <LayoutPreferencePreview />}
      {!compact && (!collapsiblePreviews || previewOpen) && key === lastTableControl && tablePreview !== false && <TablePreferencePreview />}
    </div>)}
  </div>;
}
