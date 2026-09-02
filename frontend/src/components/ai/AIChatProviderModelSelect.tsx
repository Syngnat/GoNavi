import React from 'react';
import { Select } from 'antd';
import { DownOutlined } from '@ant-design/icons';

import { t as catalogTranslate } from '../../i18n/catalog';
import { useOptionalI18n } from '../../i18n/provider';
import type { AIProviderConfig } from '../../types';
import { isLocalCLISubscriptionProvider } from '../../utils/aiProviderPresets';
import { enabledProviderModels } from '../../utils/aiProviderManagement';

interface AIChatProviderModelSelectProps {
  activeProvider?: AIProviderConfig | null;
  dynamicModels: string[];
  loadingModels: boolean;
  variant: 'legacy' | 'v2';
  onModelChange: (value: string) => void;
  onFetchModels: () => void;
}

const AIChatProviderModelSelect: React.FC<AIChatProviderModelSelectProps> = ({
  activeProvider,
  dynamicModels,
  loadingModels,
  variant,
  onModelChange,
  onFetchModels,
}) => {
  const i18n = useOptionalI18n();
  const t = i18n?.t ?? ((key: string, params?: Record<string, string | number | boolean | null | undefined>) =>
    catalogTranslate('en-US', key, params));

  if (!activeProvider) {
    return null;
  }

  const usesLocalCLI = isLocalCLISubscriptionProvider(activeProvider);
  const options = enabledProviderModels(
    [...(dynamicModels.length > 0 ? dynamicModels : (activeProvider.models || [])), ...(activeProvider.customModels || [])],
    activeProvider.disabledModels,
  )
    .map((model) => ({ label: model, value: model }));

  const handleOpenChange = (open: boolean) => {
    if (open && options.length === 0 && !usesLocalCLI) {
      onFetchModels();
    }
  };
  const modelPlaceholder = usesLocalCLI
    ? t('ai_settings.provider.auto_model')
    : t('ai_chat.input.model.placeholder');

  if (variant === 'legacy') {
    return (
      <Select
        size="small"
        variant="filled"
        value={activeProvider.model || undefined}
        onChange={onModelChange}
        onOpenChange={handleOpenChange}
        loading={loadingModels}
        options={options}
        style={{ width: 130, fontSize: 11, background: 'transparent' }}
        styles={{ popup: { root: { minWidth: 200 } } }}
        showSearch
        placeholder={modelPlaceholder}
      />
    );
  }

  return (
    <Select
      size="small"
      value={activeProvider.model || undefined}
      onChange={onModelChange}
      onOpenChange={handleOpenChange}
      loading={loadingModels}
      options={options}
      styles={{ popup: { root: { minWidth: 200 } } }}
      placeholder={modelPlaceholder}
      className="gn-v2-ai-model-select"
      suffixIcon={<DownOutlined />}
    />
  );
};

export default AIChatProviderModelSelect;
