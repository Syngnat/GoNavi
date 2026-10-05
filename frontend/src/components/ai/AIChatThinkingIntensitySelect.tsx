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
import { aiPx } from './aiScale';

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
  // A model with no thinking levels has nothing to choose.
  if (control.options.length === 0) {
    return null;
  }
  const options = control.options.map((item) => ({
    value: item.value,
    label: t(item.labelKey),
  }));
  // 宽度按最长的档位名称算（中日文字宽约 1em，其余约 0.62em），再加左内边距与箭头位，
  // 这样「不推理 / 特高 / Extra high」都能完整显示，切换档位时宽度也不抖动。
  const longestLabelUnits = options.reduce((longest, option) => {
    const units = Array.from(option.label).reduce(
      (sum, char) => sum + ((char.codePointAt(0) ?? 0) >= 0x2e80 ? 12 : 7.5),
      0,
    );
    return Math.max(longest, units);
  }, 0);
  const widthUnits = Math.max(52, Math.ceil(longestLabelUnits) + 8 + 22 + 4);

  return (
    <Select
      size="small"
      value={value || control.defaultValue || undefined}
      onChange={onChange}
      options={options}
      styles={{ popup: { root: { minWidth: 160 } } }}
      placeholder={t('ai_chat.input.thinking_intensity.placeholder')}
      className="gn-v2-ai-thinking-select"
      style={{ '--gn-ai-thinking-width': aiPx(widthUnits) } as React.CSSProperties}
      suffixIcon={<DownOutlined />}
    />
  );
};

export default AIChatThinkingIntensitySelect;
