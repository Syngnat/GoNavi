import { useEffect, useMemo, useState } from 'react';
import { useOptionalI18n } from '../../i18n/provider';
import { t as translate } from '../../i18n';
import {
  contextTierOptions,
  formatContextTier,
  parseContextTier,
  snapContextTier,
  type ModelCatalogEntry,
} from '../../utils/modelsDevCatalog';

// Context window as tier bubbles instead of a free number: the models.dev catalog
// (plus whatever the plugin declares) decides the tiers a selected model can
// reach, and a typed 1M / 1000000 lands on the same tier.
export default function AIPluginProviderContextPicker({
  modelIds, value, onChange, catalog,
}: {
  modelIds: string[];
  value?: number;
  onChange: (value: number) => void;
  /** models.dev 公共目录索引；未提供时退回常用档位。 */
  catalog?: Map<string, ModelCatalogEntry>;
}) {
  const t = useOptionalI18n()?.t ?? translate;
  const tiers = useMemo(() => contextTierOptions(catalog, modelIds), [catalog, modelIds]);
  const current = snapContextTier(value ?? 0);
  const [draft, setDraft] = useState(formatContextTier(value));
  useEffect(() => { setDraft(formatContextTier(value)); }, [value]);

  const commit = () => {
    const parsed = parseContextTier(draft);
    if (parsed === null) {
      setDraft(formatContextTier(value));
      return;
    }
    setDraft(formatContextTier(parsed));
    onChange(parsed);
  };

  return (
    <div className="gn-context-picker">
      <span className="gn-context-label">{t('plugin.ai_provider.context')}</span>
      <div className="gn-context-chips">
        {tiers.map((tier) => (
          <button
            type="button"
            key={tier}
            className={current === tier ? 'gn-context-chip is-on' : 'gn-context-chip'}
            aria-pressed={current === tier}
            onClick={() => onChange(tier)}
          >
            {formatContextTier(tier)}
          </button>
        ))}
        <input
          className="gn-context-input"
          value={draft}
          placeholder={t('plugin.ai_provider.context_placeholder')}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); commit(); } }}
        />
      </div>
    </div>
  );
}
