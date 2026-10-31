import { useMemo, useState } from 'react';
import { invokeAccountCommand, parseScanAccountModels, type ScannedModelItem } from './aiPluginProviderAccountApi';
import {
  formatContextTier,
  modelCatalogNameFor,
  modelCatalogWindowFor,
  type ModelCatalogEntry,
} from '../../utils/modelsDevCatalog';

type CopyText = (key: string, params?: Record<string, string | number>) => string;

interface DeclaredModel {
  id: string;
  name: string;
  contextWindow: number;
}

interface AIPluginProviderModelScanProps {
  pluginId?: string;
  t: CopyText;
  selected: string[];
  /** 插件清单里声明的模型：名称与窗口优先展示插件自己写的那份。 */
  declared?: readonly DeclaredModel[];
  /** models.dev 公共目录索引：声明缺失时补名称与窗口。 */
  catalog: Map<string, ModelCatalogEntry>;
  onChange: (models: string[]) => void;
  /** Saves the provider right here so the model list never needs the footer. */
  onSave?: () => void;
  saving?: boolean;
  /** 回传扫描结果给编辑器：测试前要按当前密钥过滤可用模型。 */
  onScanned?: (items: ScannedModelItem[]) => void;
}

// One row per model, toggled by click: the union of every key's model list,
// because each key group reaches a different set on the gateway. Each row shows
// the catalog name and context tier so a gateway alias stays readable.
export default function AIPluginProviderModelScan({
  pluginId, t, selected, declared = [], catalog, onChange, onSave, saving, onScanned,
}: AIPluginProviderModelScanProps) {
  const [scanning, setScanning] = useState(false);
  const [scanned, setScanned] = useState<ScannedModelItem[]>(() => selected.map((id) => ({ id, name: '', contextWindow: 0, keyIds: [] })));
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState('');
  const [message, setMessage] = useState('');
  const chosen = useMemo(() => new Set(selected), [selected]);
  const scannedById = useMemo(() => new Map(scanned.map((item) => [item.id, item])), [scanned]);
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle ? scanned.filter((item) => item.id.toLowerCase().includes(needle)) : scanned;
  }, [scanned, query]);

  // 名称与窗口的优先级：网关扫描给的元数据 → 插件声明 → models.dev 目录 → 原始 ID。
  const labelFor = (id: string) => {
    const scannedModel = scannedById.get(id);
    const declaredModel = declared.find((item) => item.id === id);
    const name = scannedModel?.name || declaredModel?.name || modelCatalogNameFor(catalog, id) || id;
    const tier = formatContextTier(scannedModel?.contextWindow || modelCatalogWindowFor(catalog, id) || declaredModel?.contextWindow);
    return tier ? `${name} · ${tier}` : name;
  };

  const scan = async () => {
    if (!pluginId || scanning) return;
    setScanning(true);
    setMessage('');
    const outcome = await invokeAccountCommand(pluginId, 'account.listModels', parseScanAccountModels);
    setScanning(false);
    if (outcome.kind !== 'ok') {
      setMessage(outcome.kind === 'error' && outcome.message ? outcome.message : t('plugin.ai_provider.models_scan_failed'));
      return;
    }
    // 扫描结果与已有列表取并集：手工加的 ID 不该被下一次扫描挤掉，
    // 已有的网关元数据也不会被只回 id 的那把 Key 清空。
    const merged: ScannedModelItem[] = [];
    const seen = new Set<string>();
    for (const item of [...outcome.data, ...scanned]) {
      const existing = seen.has(item.id) ? merged.find((entry) => entry.id === item.id) : undefined;
      if (existing) {
        if (!existing.name) existing.name = item.name;
        if (item.contextWindow > existing.contextWindow) existing.contextWindow = item.contextWindow;
        continue;
      }
      seen.add(item.id);
      merged.push({ ...item });
    }
    setScanned(merged);
    onScanned?.(merged);
    if (outcome.data.length === 0) setMessage(t('plugin.ai_provider.models_scan_empty'));
    // Everything reachable is selected on the first scan; the user trims it down.
    else onChange(merged.map((item) => item.id));
  };

  const toggle = (id: string) => {
    onChange(chosen.has(id) ? selected.filter((item) => item !== id) : [...selected, id]);
  };

  // 目录里没有、扫描也没返回的模型（私有部署、别名）直接手填 ID。
  const addDraft = () => {
    const id = draft.trim();
    if (!id) return;
    setScanned((current) => (current.some((item) => item.id === id) ? current : [...current, { id, name: '', contextWindow: 0, keyIds: [] }]));
    if (!chosen.has(id)) onChange([...selected, id]);
    setDraft('');
  };

  return (
    <div className="gn-model-scan">
      <div className="gn-model-scan-head">
        {scanned.length > 0 && (
          <span className="gn-model-scan-count">
            {t('plugin.ai_provider.models_scan_count', { count: selected.length, total: scanned.length })}
          </span>
        )}
        <span className="gn-model-scan-actions">
          {scanned.length > 0 && (
            <>
              <button type="button" className="gn-model-scan-link" onClick={() => onChange(scanned.map((item) => item.id))}>
                {t('plugin.ai_provider.models_all')}
              </button>
              <button type="button" className="gn-model-scan-link" onClick={() => onChange([])}>
                {t('plugin.ai_provider.models_none')}
              </button>
            </>
          )}
          <button type="button" className="gn-model-scan-button" disabled={!pluginId || scanning} onClick={() => void scan()}>
            {t(scanning ? 'plugin.ai_provider.models_scan_running' : 'plugin.ai_provider.models_scan')}
          </button>
          {onSave && (
            <button type="button" className="gn-model-scan-save" disabled={selected.length === 0 || Boolean(saving)} onClick={onSave}>
              {t('plugin.ai_provider.models_save')}
            </button>
          )}
        </span>
      </div>
      <div className="gn-model-scan-head">
        {scanned.length > 0 && (
          <label className="gn-model-scan-search">
            <input
              type="search"
              value={query}
              placeholder={t('plugin.ai_provider.models_filter')}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
        )}
        <span className="gn-model-scan-actions">
          <input
            className="gn-model-scan-input"
            value={draft}
            maxLength={256}
            placeholder={t('plugin.ai_provider.models_add_placeholder')}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return;
              event.preventDefault();
              addDraft();
            }}
          />
          <button type="button" className="gn-model-scan-link" disabled={!draft.trim()} onClick={addDraft}>
            {t('plugin.ai_provider.models_add')}
          </button>
        </span>
      </div>
      {visible.length > 0 && (
        <div className="gn-model-chips">
          {visible.map((item) => (
            <button
              type="button"
              key={item.id}
              className={chosen.has(item.id) ? 'gn-model-chip is-on' : 'gn-model-chip'}
              aria-pressed={chosen.has(item.id)}
              title={item.id}
              onClick={() => toggle(item.id)}
            >
              {chosen.has(item.id) && <span className="gn-model-chip-check" aria-hidden="true">✓</span>}
              {labelFor(item.id)}
            </button>
          ))}
        </div>
      )}
      <p className="gn-model-scan-source">
        {t(catalog.size > 0 ? 'plugin.ai_provider.models_source' : 'plugin.ai_provider.models_catalog_unavailable')}
      </p>
      {message && <p className="gn-model-scan-message" role="alert">{message}</p>}
    </div>
  );
}
