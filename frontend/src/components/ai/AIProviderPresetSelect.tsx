import React from 'react';
import { Select } from 'antd';

import AIProviderLogo from './AIProviderLogo';

interface PresetOption {
  key: string;
  label: string;
}

interface PartnerOption {
  key: string;
  label: string;
  logoSrc: string;
  url: string;
  baseUrl: string;
  benefit: string;
  promoCode: string;
}

interface AIProviderPresetSelectProps {
  value?: string | null;
  presets: PresetOption[];
  canSelect: (preset: PresetOption) => boolean;
  className?: string;
  placeholder?: React.ReactNode;
  disabled?: boolean;
  dark?: boolean;
  builtinLabel: string;
  partnerLabel: string;
  partnerPromoLabel: string;
  partnerPromoCopyingLabel: string;
  partnerPromoCopyFailedLabel: string;
  partnerPromoCopyActionLabel: string;
  partnerApplyBaseUrlActionLabel: string;
  partnerVisitActionLabel: string;
  partners?: PartnerOption[];
  ariaLabel: string;
  onChange: (presetKey: string) => void;
  onOpenPartner?: (url: string) => void;
  onCopyPartnerCode?: (code: string) => Promise<void>;
  onApplyPartnerBaseUrl?: (baseUrl: string, label: string) => void | Promise<void>;
}

const AIProviderPresetSelect: React.FC<AIProviderPresetSelectProps> = ({
  value, presets, canSelect, className, placeholder, disabled, dark, builtinLabel, partnerLabel,
  partnerPromoLabel, partnerPromoCopyingLabel, partnerPromoCopyFailedLabel,
  partnerPromoCopyActionLabel, partnerApplyBaseUrlActionLabel, partnerVisitActionLabel, partners = [], ariaLabel, onChange,
  onOpenPartner, onCopyPartnerCode, onApplyPartnerBaseUrl,
}) => {
  const [open, setOpen] = React.useState(false);
  const [activePartnerKey, setActivePartnerKey] = React.useState('');
  const [partnerCopyState, setPartnerCopyState] = React.useState<'idle' | 'copying' | 'error'>('idle');
  const choosePreset = (preset: PresetOption) => {
    if (!canSelect(preset) && preset.key !== value) return;
    onChange(preset.key);
    setOpen(false);
  };
  const copyPartnerCode = async (partner: PartnerOption) => {
    setActivePartnerKey(partner.key);
    setPartnerCopyState('copying');
    try {
      if (!onCopyPartnerCode) throw new Error('Partner code copying is unavailable');
      await onCopyPartnerCode(partner.promoCode);
      setPartnerCopyState('idle');
    } catch {
      setPartnerCopyState('error');
    }
  };
  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) {
      setActivePartnerKey('');
      setPartnerCopyState('idle');
    }
  };

  return <Select
    className={`gonavi-ai-provider-preset-select${className ? ` ${className}` : ''}`}
    aria-label={ariaLabel}
    size="middle"
    value={value}
    placeholder={placeholder}
    showSearch
    optionFilterProp="label"
    disabled={disabled}
    open={open}
    onOpenChange={handleOpenChange}
    popupMatchSelectWidth={false}
    classNames={{ popup: { root: 'gonavi-ai-provider-preset-dropdown' } }}
    optionLabelProp="label"
    options={presets.map((preset) => ({
      value: preset.key,
      label: preset.label,
      disabled: !canSelect(preset) && preset.key !== value,
    }))}
    optionRender={(option) => (
      <span className="gonavi-ai-provider-preset-option">
        <AIProviderLogo presetKey={String(option.value)} label={String(option.label)} dark={dark} />
        <span>{option.label}</span>
      </span>
    )}
    labelRender={(props) => (
      <span className="gonavi-ai-provider-preset-option">
        <AIProviderLogo presetKey={String(props.value)} label={String(props.label)} dark={dark} />
        <span>{props.label}</span>
      </span>
    )}
    popupRender={(menu) => (
      <div className="gonavi-ai-provider-preset-dropdown-grid">
        <div className="gonavi-ai-provider-preset-col">
          <div className="gonavi-ai-provider-preset-col-title">{builtinLabel}</div>
          {menu}
        </div>
        <div className="gonavi-ai-provider-preset-col is-partner">
          <div className="gonavi-ai-provider-preset-col-title">{partnerLabel}</div>
          <div className="gonavi-ai-provider-partner-list">
            {partners.map((partner) => (
              <React.Fragment key={partner.key}>
                <button
                  type="button"
                  className={`gonavi-ai-provider-partner-option${activePartnerKey === partner.key ? ' is-active' : ''}`}
                  aria-expanded={activePartnerKey === partner.key}
                  aria-controls={`gonavi-ai-provider-partner-${partner.key}`}
                  aria-label={`${partner.label} · ${partner.benefit}`}
                  title={partner.url}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => copyPartnerCode(partner)}
                >
                  <span className="gonavi-ai-provider-partner-logo-frame" aria-hidden="true">
                    <img className="gonavi-ai-provider-logo gonavi-ai-provider-partner-logo" src={partner.logoSrc} alt="" />
                  </span>
                  <span className="gonavi-ai-provider-partner-main">
                    <span className="gonavi-ai-provider-partner-name">{partner.label}</span>
                    <span className="gonavi-ai-provider-partner-benefit">
                      <span className="gonavi-ai-provider-partner-benefit-text">{partner.benefit}</span>
                    </span>
                  </span>
                </button>
                {activePartnerKey === partner.key && <div id={`gonavi-ai-provider-partner-${partner.key}`}
                  className="gonavi-ai-provider-partner-offer" role="group" aria-label={`${partner.label} · ${partner.benefit}`}>
                  <span className="gonavi-ai-provider-partner-code-label">{partnerPromoLabel}</span>
                  <button type="button" className="gonavi-ai-provider-partner-code"
                    onMouseDown={(event) => event.preventDefault()} onClick={() => copyPartnerCode(partner)}>
                    <code>{partner.promoCode}</code>
                    <span>{partnerPromoCopyActionLabel}</span>
                  </button>
                  {partnerCopyState !== 'idle' && <span className={`gonavi-ai-provider-partner-copy-state is-${partnerCopyState}`} role="status">
                    {partnerCopyState === 'copying' ? partnerPromoCopyingLabel : partnerPromoCopyFailedLabel}
                  </span>}
                  <button type="button" className="gonavi-ai-provider-partner-apply"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => {
                      void onApplyPartnerBaseUrl?.(partner.baseUrl, partner.label);
                      handleOpenChange(false);
                    }}>
                    {partnerApplyBaseUrlActionLabel}
                  </button>
                  <button type="button" className="gonavi-ai-provider-partner-visit"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => { onOpenPartner?.(partner.url); handleOpenChange(false); }}>
                    {partnerVisitActionLabel}
                  </button>
                </div>}
              </React.Fragment>
            ))}
          </div>
        </div>
      </div>
    )}
    onChange={(key) => {
      const preset = presets.find((item) => item.key === key);
      if (preset) choosePreset(preset);
    }}
  />
};

export default AIProviderPresetSelect;
