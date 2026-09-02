import React from 'react';
import { Button, Select } from 'antd';
import {
  getProviderEndpointTypes,
  PROVIDER_ENDPOINT_TYPES,
  type ProviderEndpointPreset,
  type ProviderEndpointType,
} from '../../utils/aiProviderEndpoints';
import type { OverlayWorkbenchTheme } from '../../utils/overlayWorkbenchTheme';

interface Props {
  presets: (ProviderEndpointPreset & { label: string })[];
  selectablePresetKeys: ReadonlySet<string>;
  configuredPresetKeys: ReadonlySet<string>;
  endpointType?: ProviderEndpointType;
  selectedPresetKey?: string;
  isEditing: boolean;
  disabled: boolean;
  copy: (key: string, params?: Record<string, string | number>) => string;
  theme: OverlayWorkbenchTheme;
  onEndpointChange: (endpointType: ProviderEndpointType) => void;
  onProviderChange: (presetKey: string) => void;
  onRestore?: () => void;
}

const AIProviderConnectionGuide: React.FC<Props> = ({
  presets, selectablePresetKeys, configuredPresetKeys, endpointType, selectedPresetKey,
  isEditing, disabled, copy, theme, onEndpointChange, onProviderChange, onRestore,
}) => {
  const id = React.useId();
  const endpointLabel = (type: ProviderEndpointType) => copy(`ai_settings.endpoint.${type}.label`);
  const usesClaudeProxy = (preset: ProviderEndpointPreset) => preset.key === 'custom'
    || (preset.fixedApiFormat === 'claude-cli' && preset.authMode !== 'local-cli');
  const candidates = endpointType
    ? presets.filter((preset) => selectablePresetKeys.has(preset.key) && getProviderEndpointTypes(preset).includes(endpointType))
    : [];
  const endpointOptions = PROVIDER_ENDPOINT_TYPES.map((type) => ({ value: type, label: endpointLabel(type) }));

  return (
    <div className="gonavi-ai-provider-guide" style={{ color: theme.titleText }}>
      <div className="gonavi-ai-provider-field-grid">
        <div>
          <label htmlFor={`${id}-endpoint`} className="gonavi-ai-provider-guide-label">{copy('ai_settings.endpoint.step_endpoint')}</label>
          <Select
            id={`${id}-endpoint`}
            className="gonavi-ai-provider-endpoint-select"
            aria-label={copy('ai_settings.endpoint.step_endpoint')}
            aria-describedby={`${id}-hint`}
            size="middle"
            placeholder={copy('ai_settings.endpoint.choose_endpoint')}
            value={endpointType}
            options={[
              { label: copy('ai_settings.endpoint.api_group'), options: endpointOptions.slice(0, 3) },
              { label: copy('ai_settings.endpoint.other_group'), options: endpointOptions.slice(3) },
            ]}
            onChange={onEndpointChange}
            disabled={disabled}
            style={{ width: '100%' }}
          />
        </div>
        <div>
          <label htmlFor={`${id}-provider`} className="gonavi-ai-provider-guide-label">{copy('ai_settings.endpoint.step_provider')}</label>
          <Select
            id={`${id}-provider`}
            className={isEditing ? 'gonavi-ai-provider-preset-select' : 'gonavi-ai-provider-add-select'}
            aria-label={copy('ai_settings.endpoint.step_provider')}
            aria-describedby={`${id}-hint`}
            size="middle"
            showSearch
            optionFilterProp="label"
            placeholder={copy(endpointType ? 'ai_settings.endpoint.choose_provider' : 'ai_settings.endpoint.choose_endpoint_first')}
            value={selectedPresetKey}
            options={candidates.map((preset) => ({
              value: preset.key,
              label: [preset.label, endpointType === 'cli' && usesClaudeProxy(preset) ? copy('ai_settings.endpoint.claude_proxy') : '', configuredPresetKeys.has(preset.key) ? copy('ai_settings.provider.configured') : ''].filter(Boolean).join(' · '),
            }))}
            onChange={(key) => { if (candidates.some((preset) => preset.key === key)) onProviderChange(key); }}
            disabled={disabled || !endpointType || candidates.length === 0}
            style={{ width: '100%' }}
          />
        </div>
      </div>
      <div id={`${id}-hint`} role="status" className="gonavi-ai-provider-guide-hint" style={{ color: theme.mutedText }}>
        {copy(endpointType ? `ai_settings.endpoint.${endpointType}.hint` : 'ai_settings.endpoint.intro')}
        {endpointType && <span> {copy(candidates.length ? 'ai_settings.endpoint.provider_count' : 'ai_settings.endpoint.no_candidates', { count: candidates.length })}</span>}
      </div>
      {onRestore && <div className="gonavi-ai-provider-guide-restore" role="note" style={{ color: theme.mutedText }}>
        <span>{copy('ai_settings.endpoint.pending_hint')}</span>
        <Button type="link" size="small" onClick={onRestore}>{copy('ai_settings.endpoint.restore')}</Button>
      </div>}
      <details className="gonavi-ai-provider-support" style={{ color: theme.mutedText }}>
        <summary>{copy('ai_settings.endpoint.view_support')}</summary>
        <p>{copy('ai_settings.endpoint.support_scope')}</p>
        <div className="gonavi-ai-provider-support-table" role="region" aria-label={copy('ai_settings.endpoint.view_support')} tabIndex={0}>
        <table>
          <caption className="sr-only">{copy('ai_settings.endpoint.view_support')}</caption>
          <thead><tr>
            <th scope="col">{copy('ai_settings.endpoint.table_provider')}</th>
            <th scope="col">{copy('ai_settings.endpoint.table_endpoint')}</th>
          </tr></thead>
          <tbody>{presets.map((preset) => <tr key={preset.key}>
            <th scope="row" style={{ color: theme.titleText }}>
              {preset.label}
              {configuredPresetKeys.has(preset.key) && <span className="gonavi-ai-provider-support-configured">{copy('ai_settings.provider.configured')}</span>}
            </th>
            <td>{getProviderEndpointTypes(preset).map((type) => type === 'cli' && usesClaudeProxy(preset) ? copy('ai_settings.endpoint.claude_proxy') : endpointLabel(type)).join(' · ')}</td>
          </tr>)}</tbody>
        </table>
        </div>
      </details>
    </div>
  );
};

export default AIProviderConnectionGuide;
