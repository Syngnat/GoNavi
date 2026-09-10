import React from 'react';
import { Dropdown } from 'antd';
import type { MenuProps } from 'antd';
import {
  CheckOutlined,
  DownOutlined,
  LoadingOutlined,
  SettingOutlined,
} from '@ant-design/icons';

import { t as catalogTranslate } from '../../i18n/catalog';
import { useOptionalI18n } from '../../i18n/provider';
import type { AIProviderConfig } from '../../types';
import { isLocalCLISubscriptionProvider } from '../../utils/aiProviderPresets';
import { enabledProviderModels } from '../../utils/aiProviderManagement';

interface AIChatProviderModelSelectProps {
  activeProvider?: AIProviderConfig | null;
  providers?: AIProviderConfig[];
  providerModels?: Record<string, string[]>;
  dynamicModels: string[];
  loadingModels: boolean;
  onModelChange: (value: string) => void | Promise<void>;
  onProviderModelChange?: (providerId: string, model: string) => void | Promise<void>;
  onManageProvider?: (providerId: string) => void;
  onFetchModels: () => void;
  onFetchProviderModels?: (providerId: string) => void;
}

interface ProviderModelChoice {
  providerId: string;
  model: string;
}

const connectedProviders = (
  providers: AIProviderConfig[] | undefined,
  activeProvider: AIProviderConfig,
): AIProviderConfig[] => {
  const available = Array.isArray(providers) ? providers.filter((provider) => Boolean(provider?.id)) : [];
  if (available.some((provider) => provider.id === activeProvider.id)) return available;
  return [activeProvider, ...available];
};

const selectableModels = (
  provider: AIProviderConfig,
  activeProviderId: string,
  dynamicModels: string[],
  discoveredModels: string[] = [],
): string[] => enabledProviderModels(
  [
    ...(provider.id === activeProviderId && dynamicModels.length > 0
      ? dynamicModels
      : discoveredModels.length > 0 ? discoveredModels : (provider.models || [])),
    ...(provider.customModels || []),
    ...(String(provider.model || '').trim() ? [String(provider.model).trim()] : []),
  ],
  provider.disabledModels,
);

const AIChatProviderModelSelect: React.FC<AIChatProviderModelSelectProps> = ({
  activeProvider,
  providers,
  providerModels,
  dynamicModels,
  loadingModels,
  onModelChange,
  onProviderModelChange,
  onManageProvider,
  onFetchModels,
  onFetchProviderModels,
}) => {
  const i18n = useOptionalI18n();
  const t = i18n?.t ?? ((key: string, params?: Record<string, string | number | boolean | null | undefined>) =>
    catalogTranslate('en-US', key, params));
  const [open, setOpen] = React.useState(false);

  if (!activeProvider) return null;

  const choicesByKey = new Map<string, ProviderModelChoice>();
  const providerIdByMenuKey = new Map<string, string>();
  let selectedKey = '';
  const autoModelLabel = t('ai_settings.provider.auto_model');
  const providerItems: MenuProps['items'] = connectedProviders(providers, activeProvider).map((provider, providerIndex) => {
    const usesLocalCLI = isLocalCLISubscriptionProvider(provider);
    const models = selectableModels(provider, activeProvider.id, dynamicModels, providerModels?.[provider.id]);
    const modelChoices = usesLocalCLI ? ['', ...models] : models;
    const children: NonNullable<MenuProps['items']> = modelChoices.map((model, modelIndex) => {
      const key = `provider-model-${providerIndex}-${modelIndex}`;
      choicesByKey.set(key, { providerId: provider.id, model });
      if (provider.id === activeProvider.id && model === String(activeProvider.model || '').trim()) {
        selectedKey = key;
      }
      return {
        key,
        label: model || autoModelLabel,
        icon: provider.id === activeProvider.id && model === String(activeProvider.model || '').trim()
          ? <CheckOutlined />
          : undefined,
      };
    });
    if (children.length === 0) {
      children.push({
        key: `provider-empty-${providerIndex}`,
        label: t('ai_settings.models.sync_empty'),
        disabled: true,
      });
    }
    const providerKey = `provider-${providerIndex}`;
    providerIdByMenuKey.set(providerKey, provider.id);
    return {
      key: providerKey,
      label: provider.name || provider.id,
      children,
    };
  });

  const menuItems: MenuProps['items'] = [
    ...providerItems,
    { type: 'divider' },
    {
      key: 'manage-models',
      icon: <SettingOutlined />,
      label: t('ai_settings.models.manage'),
    },
  ];
  const usesLocalCLI = isLocalCLISubscriptionProvider(activeProvider);
  const currentModelLabel = String(activeProvider.model || '').trim()
    || (usesLocalCLI ? autoModelLabel : t('ai_chat.input.model.placeholder'));
  const triggerLabel = `${activeProvider.name || activeProvider.id} / ${currentModelLabel}`;

  const handleMenuClick: NonNullable<MenuProps['onClick']> = ({ key }) => {
    if (key === 'manage-models') {
      onManageProvider?.(activeProvider.id);
      setOpen(false);
      return;
    }
    const choice = choicesByKey.get(key);
    if (!choice) return;
    if (onProviderModelChange) {
      void onProviderModelChange(choice.providerId, choice.model);
    } else if (choice.providerId === activeProvider.id) {
      void onModelChange(choice.model);
    }
    setOpen(false);
  };

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (
      nextOpen
      && selectableModels(activeProvider, activeProvider.id, dynamicModels, providerModels?.[activeProvider.id]).length === 0
      && !usesLocalCLI
    ) {
      onFetchModels();
    }
  };

  return (
    <Dropdown
      open={open}
      trigger={['click']}
      placement="topLeft"
      overlayClassName="gn-v2-ai-provider-model-popup"
      onOpenChange={handleOpenChange}
      menu={{
        items: menuItems,
        selectedKeys: selectedKey ? [selectedKey] : [],
        onClick: handleMenuClick,
        onOpenChange: (openKeys) => {
          const providerId = providerIdByMenuKey.get(String(openKeys[openKeys.length - 1] || ''));
          if (providerId) onFetchProviderModels?.(providerId);
        },
      }}
    >
      <button
        type="button"
        className="gn-v2-ai-model-select gn-v2-ai-provider-model-trigger"
        aria-label={triggerLabel}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className="gn-v2-ai-provider-model-label">{triggerLabel}</span>
        {loadingModels ? <LoadingOutlined spin /> : <DownOutlined />}
      </button>
    </Dropdown>
  );
};

export default AIChatProviderModelSelect;
