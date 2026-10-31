import type { PluginPresetOption } from './AIProviderPresetSelect';
import AISettingsProvidersSection, { type AISettingsProvidersSectionProps } from './AISettingsProvidersSection';
import { isPluginAIProviderNamespace } from '../../plugins/aiProvider/identity';
import { usePluginProviderCatalog } from '../../plugins/aiProvider/context';
import { AIPluginProviderEditor } from './AIPluginProviderEditor';
import { AIPluginProviderCatalog } from './AIPluginProviderCatalog';
import './AIPluginProvider.css';
export default function AISettingsPluginProviderSection(props: AISettingsProvidersSectionProps) {
  const plugin = isPluginAIProviderNamespace(props.editingProvider?.type) || isPluginAIProviderNamespace(props.watchedPresetKey);
  const catalog = usePluginProviderCatalog();
  const pluginPresets: PluginPresetOption[] = (catalog?.items ?? []).map((item) => ({
    key: item.type,
    label: item.name + ' · ' + item.pluginId,
    available: item.available,
    iconSrc: item.icon,
    detail: item.reason,
  }));
  if (props.isEditing && plugin) return <AIPluginProviderEditor {...props} />;
  return <div className="gn-plugin-provider-section"><div className="gn-plugin-provider-builtin">
    <AISettingsProvidersSection {...props} pluginPresets={pluginPresets}
      providers={props.providers.filter((provider) => !isPluginAIProviderNamespace(provider.type))} />
  </div><AIPluginProviderCatalog {...props} /></div>;
}
