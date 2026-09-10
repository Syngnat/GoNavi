import React from 'react';
import { Select } from 'antd';
import { DownOutlined } from '@ant-design/icons';

import { t as catalogTranslate } from '../../i18n/catalog';
import { useOptionalI18n } from '../../i18n/provider';
import type { AIProviderConfig } from '../../types';
import {
  resolveProviderThinkingIntensityControl,
} from '../../utils/aiThinkingIntensity';
import type { CLIModelCatalog } from '../../utils/aiProviderManagement';
import type { CLIThinkingCapability } from './useAIChatRuntimeResources';

interface AIChatThinkingIntensitySelectProps {
  activeProvider?: AIProviderConfig | null;
  value: string;
  onChange: (value: string) => void;
  cliCapability?: CLIThinkingCapability;
  cliCatalog?: CLIModelCatalog;
}

const AIChatThinkingIntensitySelect: React.FC<AIChatThinkingIntensitySelectProps> = ({
  activeProvider,
  value,
  onChange,
  cliCapability,
  cliCatalog,
}) => {
  const i18n = useOptionalI18n();
  const t = i18n?.t ?? ((key: string, params?: Record<string, string | number | boolean | null | undefined>) =>
    catalogTranslate('en-US', key, params));

  if (!activeProvider) {
    return null;
  }

  const control = resolveProviderThinkingIntensityControl(activeProvider, cliCapability, cliCatalog);
  const options = control.options.map((item) => ({
    value: item.value,
    label: t(item.labelKey),
  }));

  return (
    <Select
      size="small"
      value={value || control.defaultValue || undefined}
      onChange={onChange}
      options={options}
      styles={{ popup: { root: { minWidth: 160 } } }}
      placeholder={t('ai_chat.input.thinking_intensity.placeholder')}
      className="gn-v2-ai-thinking-select"
      suffixIcon={<DownOutlined />}
    />
  );
};

export default AIChatThinkingIntensitySelect;
