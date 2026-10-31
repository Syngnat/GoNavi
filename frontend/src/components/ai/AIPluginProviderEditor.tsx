import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Button, Form, Input, Space } from 'antd';
import type { AISettingsProvidersSectionProps } from './AISettingsProvidersSection';
import { usePluginProviderCatalog } from '../../plugins/aiProvider/context';
import { clearedPluginProviderSettings, hasForeignPluginProviderSettings } from '../../plugins/aiProvider/configValidation';
import { useOptionalI18n } from '../../i18n/provider';
import { t as translate } from '../../i18n';
import AIPluginProviderAccount from './AIPluginProviderAccount';
import { usePluginProviderAccount } from './usePluginProviderAccount';
import AIPluginProviderAdvanced from './AIPluginProviderAdvanced';
import AIPluginProviderFields from './AIPluginProviderFields';
import { AIPluginProviderSection } from './AIPluginProviderSection';
import AISettingsProviderTestResult from './AISettingsProviderTestResult';
import { PluginLogo } from '../pluginManager/PluginLogo';
import { usePluginProviderHealth } from './usePluginProviderHealth';
import { normalizeProviderModels } from '../../utils/aiProviderManagement';
import AIPluginProviderModelScan from './AIPluginProviderModelScan';
import AIPluginProviderContextPicker from './AIPluginProviderContextPicker';
import { useModelsDevCatalog } from './useModelsDevCatalog';
import { modelsForKey, previewModelList, resolveProviderKeyId } from './pluginProviderKeyScope';
import type { ScannedModelItem } from './aiPluginProviderAccountApi';

// The provider form reads top-down as three ruled blocks: account, model access, advanced.
// Identity and the raw plugin:<id>:<provider> type live in the header only, never as body text.
export function AIPluginProviderEditor(props: AISettingsProvidersSectionProps) {
  const t = useOptionalI18n()?.t ?? translate; const catalog = usePluginProviderCatalog(); const { form, editingProvider } = props;
  const values = Form.useWatch([], { form, preserve: true }) as Record<string, unknown> | undefined;
  const [replacingKey, setReplacingKey] = useState(false);
  // 网关按密钥分组暴露模型：扫描结果留在这里，测试前用它判断当前密钥能否访问所选模型。
  const [scannedModels, setScannedModels] = useState<ScannedModelItem[]>([]);
  const [testBlocked, setTestBlocked] = useState('');
  const handleScanned = useCallback((items: ScannedModelItem[]) => setScannedModels(items), []);
  const type = editingProvider?.type || String(values?.type || props.watchedPresetKey || '');
  const source = catalog?.find(type);
  const account = usePluginProviderAccount(source?.pluginId);
  const health = usePluginProviderHealth(source?.pluginId, source?.available === true);
  const modelId = String(values?.model ?? editingProvider?.model ?? '');
  const model = source?.models.find((item) => item.id === modelId);
  const unsupported = hasForeignPluginProviderSettings({ ...editingProvider, ...form.getFieldsValue(true), ...values }, source?.supportsImages === true);
  const customModels = normalizeProviderModels(values?.customModels);
  // 模型区展示统一走 models.dev 公共目录：插件声明的模型与已选模型一起去补名称与窗口。
  const modelsDev = useModelsDevCatalog([
    ...(source?.models.map((item) => item.id) ?? []),
    ...customModels,
    modelId,
  ]);
  const applyModels = (ids: string[]) => {
    // The bubble list is the only model picker now, so the active model follows
    // it: keep the current one when still selected, otherwise take the first.
    const nextModel = ids.includes(modelId) ? modelId : ids[0];
    const patch = nextModel ? { customModels: ids, model: nextModel } : { customModels: ids };
    form.setFieldsValue(patch);
    props.onValuesChange?.(patch);
  };
  // A stored credential lives in the secret store: apiKey stays empty while hasSecret is set.
  const formKey = String(values?.apiKey ?? '').trim();
  const storedKey = String(editingProvider?.apiKey ?? '').trim();
  const hasSavedKey = Boolean(formKey || storedKey || editingProvider?.hasSecret || editingProvider?.secretRef);
  const hintSource = formKey || storedKey;
  const savedKeyHint = hintSource.length >= 8 ? hintSource.slice(-4) : '';
  const applyKey = (key: string) => {
    form.setFieldsValue({ apiKey: key });
    setReplacingKey(false);
    props.onValuesChange?.({ apiKey: key });
  };
  // An untouched form uses the account's first key instead of a dead-end empty
  // picker; a stored secret or an explicit pick always wins.
  const firstKey = account.keys.items.find((item) => item.key)?.key ?? '';
  useEffect(() => {
    if (!firstKey || hasSavedKey) return;
    if (String(form.getFieldValue('apiKey') ?? '').trim()) return;
    form.setFieldsValue({ apiKey: firstKey });
  }, [firstKey, hasSavedKey, form]);
  // A key picked before the list arrived has no option to match, so the picker
  // would render blank; keep a stand-in option for the current value.
  const keyChoices = useMemo(() => {
    const items = account.keys.items;
    if (!formKey || items.some((item) => item.key === formKey)) return items;
    return [{ id: 'pending', name: '', key: formKey, status: '', groupName: '', lastUsedAt: '' }, ...items];
  }, [account.keys.items, formKey]);
  // The editor has no clear button: reaching save or test with leftover settings
  // clears them first, then runs the same action once.
  const runClean = (action?: () => void) => () => {
    if (unsupported) {
      form.setFieldsValue(clearedPluginProviderSettings);
      props.onValuesChange?.(clearedPluginProviderSettings);
    }
    action?.();
  };
  // 测试只用当前密钥真正能访问到的模型：选的模型不在该密钥列表里就直接说明可用哪些，
  // 而不是把网关的拒绝伪装成一次连接失败。
  const runTest = runClean(() => {
    const keyId = resolveProviderKeyId(account.keys.items, formKey, savedKeyHint);
    const available = modelsForKey(scannedModels, keyId);
    if (keyId && available.length > 0 && !available.includes(modelId)) {
      setTestBlocked(t('plugin.ai_provider.test_model_unavailable', { model: modelId, models: previewModelList(available) }));
      return;
    }
    setTestBlocked('');
    props.onTestProvider?.();
  });

  return <div className="gn-plugin-provider-editor">
    <header className="gn-provider-head">
      {source && <PluginLogo pluginId={source.pluginId} name={source.name} version={source.version} />}
      <div className="gn-provider-identity">
        <h2 className="gn-provider-name" title={type}>{source?.name || editingProvider?.name || type}</h2>
        <div className="gn-provider-meta">
          <span className="gn-provider-chip">{t('plugin.ai_provider.label')}</span>
          {source?.version && <span className="gn-provider-fact">v{source.version}</span>}
          <span className="gn-provider-dot">·</span>
          <span className="gn-provider-fact">{t('plugin.ai_provider.model_count', { count: source?.models.length ?? 0 })}</span>
          <span className="gn-provider-dot">·</span>
          <span className="gn-provider-fact">{t(source?.supportsTools ? 'plugin.ai_provider.tools_supported' : 'plugin.ai_provider.tools_unavailable')}</span>
        </div>
      </div>
      {source && (
        <span className={health.online ? 'gn-provider-live is-on' : 'gn-provider-live is-off'} role="status">
          <span className="gn-provider-live-dot" />
          {health.online ? t('plugin.ai_provider.online') : t('plugin.ai_provider.offline')}
          {health.online && health.latencyMs !== null && (
            <> · {t('plugin.ai_provider.latency', { ms: health.latencyMs })}</>
          )}
        </span>
      )}
    </header>

    {!source?.available && <Alert type="warning" showIcon message={t('plugin.ai_provider.error.unavailable')} />}
    {unsupported && <Alert type="error" showIcon message={t('plugin.ai_provider.error.unsupported_settings')} />}
    {testBlocked && <Alert type="warning" showIcon message={testBlocked} />}

    <Form form={form} layout="vertical" onValuesChange={props.onValuesChange}>
      <Form.Item name="id" hidden><Input /></Form.Item>
      <Form.Item name="type" hidden><Input /></Form.Item>
      <Form.Item name="presetKey" hidden><Input /></Form.Item>

      <AIPluginProviderSection title={t('plugin.ai_provider.section_account')} hint={t('plugin.ai_provider.section_account_hint')}>
        <AIPluginProviderAccount pluginId={source?.pluginId} showTitle={false} account={account} onUseKey={applyKey} />
      </AIPluginProviderSection>

      <AIPluginProviderSection title={t('plugin.ai_provider.section_model')} hint={t('plugin.ai_provider.section_model_hint')}>
        <AIPluginProviderFields
          t={t}
          model={model}
          catalog={modelsDev.index}
          hasSavedKey={hasSavedKey}
          savedKeyHint={savedKeyHint}
          replacingKey={replacingKey}
          onReplaceKey={() => setReplacingKey(true)}
          onPickedKey={() => setReplacingKey(false)}
          keyChoices={keyChoices}
        />
        <AIPluginProviderModelScan
          key={type}
          pluginId={source?.pluginId}
          t={t}
          selected={customModels}
          declared={source?.models}
          catalog={modelsDev.index}
          onChange={applyModels}
          onSave={editingProvider?.id ? props.onSaveProvider : undefined}
          saving={props.loading}
          onScanned={handleScanned}
        />
        <AIPluginProviderContextPicker
          catalog={modelsDev.index}
          modelIds={customModels.length > 0 ? customModels : [modelId]}
          value={typeof values?.contextWindow === 'number' ? values.contextWindow : 0}
          onChange={(next) => {
            form.setFieldsValue({ contextWindow: next });
            props.onValuesChange?.({ contextWindow: next });
          }}
        />
      </AIPluginProviderSection>

      <AIPluginProviderSection title={t('plugin.ai_provider.section_advanced')} hint={t('plugin.ai_provider.section_advanced_hint')}>
        <AIPluginProviderAdvanced t={t} form={form} model={model} />
      </AIPluginProviderSection>
    </Form>

    <AISettingsProviderTestResult testStatus={props.testStatus} testResult={props.testResult ?? null} copy={t} testAction={null} saveAction={null} />

    <footer className="gn-provider-footer">
      <span className="gn-footer-hint">{t('plugin.ai_provider.keychain_hint')}</span>
      <Space wrap>
        <Button onClick={props.onCancelEdit}>{t('common.cancel')}</Button>
        <Button onClick={runTest} loading={props.testing} disabled={!source?.available || !model || props.loading}>{t('plugin.ai_provider.test')}</Button>
        <Button type="primary" onClick={runClean(props.onSaveProvider)} loading={props.loading} disabled={props.testing}>{t('common.save')}</Button>
        {editingProvider?.id && props.onSaveProviderAsCopy && <Button onClick={runClean(props.onSaveProviderAsCopy)} disabled={props.loading || props.testing}>{t('plugin.ai_provider.save_copy')}</Button>}
      </Space>
    </footer>
  </div>;
}
