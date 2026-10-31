import { useState } from 'react';
import { Alert, Button, Modal, Popconfirm, Select, Space, Tag } from 'antd';
import type { AISettingsProvidersSectionProps } from './AISettingsProvidersSection';
import { usePluginProviderCatalog } from '../../plugins/aiProvider/context';
import { isPluginAIProviderNamespace } from '../../plugins/aiProvider/identity';
import { useOptionalI18n } from '../../i18n/provider';
import { t as translate } from '../../i18n';
import AIProviderLogo from './AIProviderLogo';
export function AIPluginProviderCatalog(props: AISettingsProvidersSectionProps) {
  const t = useOptionalI18n()?.t ?? translate; const catalog = usePluginProviderCatalog();
  const [open, setOpen] = useState(false); const [selected, setSelected] = useState<string>();
  const saved = props.providers.filter((provider) => isPluginAIProviderNamespace(provider.type));
  return <section className="gn-plugin-provider-catalog" aria-label={t('plugin.ai_provider.label')}>
    <Space wrap><strong>{t('plugin.ai_provider.label')}</strong><Button onClick={() => setOpen(true)}>{t('plugin.ai_provider.configure')}</Button>
      <Button loading={catalog?.loading} onClick={() => void catalog?.refresh()}>{t('plugin.action.refresh')}</Button></Space>
    {catalog?.error && <Alert type="warning" showIcon message={t(catalog.error)} />}
    <div className="gn-plugin-provider-saved">{saved.map((provider) => {
      const source = catalog?.find(provider.type);
      const available = source?.available === true;
      return <div key={provider.id} className="gn-plugin-provider-row"><div className="gn-plugin-provider-identity">
        <AIProviderLogo presetKey={provider.type} label={provider.name || provider.type} iconPath={source?.icon} />
        <div><strong>{provider.name || provider.type}</strong><br /><code>{provider.type}</code><br /><span>{provider.model}</span></div></div>
        <Space wrap><Tag>{t(available ? 'plugin.ai_provider.available' : 'plugin.ai_provider.unavailable')}</Tag>
          <Button onClick={() => props.onEditProvider(provider)}>{t('common.edit')}</Button>
          <Button disabled={!available || props.pendingProviderId === provider.id || props.activeProviderId === provider.id} onClick={() => props.onSetActiveProvider(provider.id)}>{t(props.activeProviderId === provider.id ? 'plugin.ai_provider.active' : 'plugin.ai_provider.use')}</Button>
          <Popconfirm title={t('plugin.ai_provider.delete_confirm')} onConfirm={() => props.onDeleteProvider(provider.id)}><Button danger>{t('common.delete')}</Button></Popconfirm>
        </Space></div>;
    })}</div>
    <Modal open={open} title={t('plugin.ai_provider.configure')} onCancel={() => setOpen(false)} destroyOnClose footer={null}>
      <p>{t('plugin.ai_provider.catalog_hint')}</p>
      <Select className="gn-plugin-provider-select" value={selected} onChange={setSelected} showSearch optionFilterProp="label"
        options={(catalog?.items ?? []).map((item) => ({ value: item.type, label: item.name + ' · ' + item.type + (item.available ? '' : ' · ' + t('plugin.ai_provider.unavailable')) }))} />
      {catalog?.loaded && !catalog.items.length && <p>{t('plugin.ai_provider.empty')}</p>}
      <Button type="primary" disabled={!selected || !catalog?.find(selected)} onClick={() => { if (selected) { props.onAddProvider(selected); setOpen(false); } }}>{t('plugin.ai_provider.configure')}</Button>
    </Modal>
  </section>;
}
