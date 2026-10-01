import React from 'react';
import { Input, Select, Tooltip } from 'antd';
import { HINT_TOOLTIP_OVERLAY_CLASS, passThroughHintTooltip } from '../common/tooltipTiming';

// How long a row keeps its "enabled / disabled / blocked" popover after a click.
export const MODEL_ROW_FLASH_MS = 1600;

// Upper bound for the management body. Short lists size to their content; longer
// ones scroll inside this height so the popup never outgrows its trigger area.
// This module is the single source: the stylesheet reads it through
// MODEL_MANAGEMENT_BODY_HEIGHT_VAR rather than repeating the number.
export const MODEL_MANAGEMENT_BODY_HEIGHT = 280;
export const MODEL_MANAGEMENT_BODY_HEIGHT_VAR = '--gn-model-management-body-height';
export const modelManagementBodyStyle = {
  [MODEL_MANAGEMENT_BODY_HEIGHT_VAR]: `${MODEL_MANAGEMENT_BODY_HEIGHT}px`,
} as React.CSSProperties;

interface ModelManagementRowProps {
  value: string;
  label: string;
  enabled: boolean;
  isDefault: boolean;
  badge: string;
  /** Empty when the switch is actionable; otherwise the localized blocking reason. */
  reason: string;
  /** Transient confirmation for this row only ("disabled", "enabled", blocked reason); shown as a popover beside the switch. */
  flash: string;
  stateLabel: string;
  toggleLabel: string;
  setDefaultLabel: string;
  showSetDefault: boolean;
  removeLabel: string;
  /** 空字符串表示可以删除；否则是本地化的阻止原因（默认模型 / 自动补全模型不允许删除）。 */
  removeReason: string;
  onSetDefault: (value: string) => void;
  onToggle: (value: string, enabled: boolean, reason: string, label: string) => void;
  onRemove: (value: string, reason: string, label: string) => void;
}

// Memoized so toggling one model re-renders that row alone. Without it every
// switch click re-rendered the whole popup, which is what made the enable and
// set-default buttons feel like they lagged the click on large model lists.
export const ModelManagementRow = React.memo<ModelManagementRowProps>(({
  value, label, enabled, isDefault, badge, reason, flash, stateLabel, toggleLabel, setDefaultLabel, showSetDefault,
  removeLabel, removeReason, onSetDefault, onToggle, onRemove,
}) => <div className={`gonavi-ai-model-management-row${enabled ? '' : ' is-disabled'}${isDefault ? ' is-default' : ''}`}>
  <div className="gonavi-ai-model-management-name">
    <Tooltip title={label} {...passThroughHintTooltip}><span>{label}</span></Tooltip>
    {badge && <small>{badge}</small>}
  </div>
  <div className="gonavi-ai-model-management-actions">
    {showSetDefault && <button type="button" aria-label={`${setDefaultLabel}: ${label}`}
      onClick={(event) => { event?.stopPropagation(); onSetDefault(value); }}>{setDefaultLabel}</button>}
    <Tooltip title={removeReason || undefined} {...passThroughHintTooltip}>
      <button type="button" className="gonavi-ai-model-remove" aria-label={`${removeLabel}: ${label}`}
        disabled={Boolean(removeReason)}
        onClick={() => onRemove(value, removeReason, label)}>{removeLabel}</button>
    </Tooltip>
    <Tooltip title={flash || reason || undefined} {...passThroughHintTooltip}
      // While the flash is up the popover is forced open beside the row it
      // belongs to; afterwards the same tooltip goes back to hover-only reasons.
      open={flash ? true : undefined} placement={flash ? 'left' : undefined}
      overlayClassName={flash ? `${HINT_TOOLTIP_OVERLAY_CLASS} gonavi-ai-model-flash` : HINT_TOOLTIP_OVERLAY_CLASS}>
      <button type="button" role="switch" aria-checked={enabled} aria-disabled={Boolean(reason)}
        aria-label={toggleLabel}
        onClick={() => onToggle(value, enabled, reason, label)}>
        <span className="gonavi-ai-model-switch" aria-hidden="true" />{stateLabel}
      </button>
    </Tooltip>
  </div>
</div>);
ModelManagementRow.displayName = 'ModelManagementRow';

export interface ModelSelectionManagement {
  disabledModels: string[];
  defaultModel: string;
  completionModel: string;
  allowDefaultFallback: boolean;
  source: string;
  copy: (key: string, params?: Record<string, string | number>) => string;
  onToggle: (model: string, enabled: boolean) => void;
  onAdd: (model: string) => void;
  onRemove: (model: string) => void;
}

interface AIProviderModelSelectProps extends React.AriaAttributes {
  id?: string;
  value?: string;
  onChange?: (value: string) => void;
  options: Array<{ value: string; label: string }>;
  label: string;
  placeholder: string;
  customLabel: string;
  loading?: boolean;
  management?: ModelSelectionManagement;
  managementRequest?: number;
  disabledModels?: string[];
}

// A searchable single-choice dropdown with an explicit custom-model option.
// Search is separate from value, so opening a configured model shows all options.
const AIProviderModelSelect: React.FC<AIProviderModelSelectProps> = ({
  value, onChange, options, label, placeholder, customLabel, loading, id, management,
  managementRequest = 0, disabledModels = [], ...ariaProps
}) => {
  const [search, setSearch] = React.useState('');
  const [open, setOpen] = React.useState(false);
  const [mode, setMode] = React.useState<'select' | 'manage'>('select');
  // Feedback is anchored to the row it concerns instead of a shared footer line,
  // so "disabled" is never ambiguous; it clears itself after MODEL_ROW_FLASH_MS.
  const [flash, setFlash] = React.useState<{ model: string; text: string } | null>(null);
  // 已停用 / 已移除的模型默认折叠，避免列表被不可用项淹没。
  const [inactiveExpanded, setInactiveExpanded] = React.useState(false);
  const flashTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const announce = (model: string, text: string) => {
    if (flashTimer.current) clearTimeout(flashTimer.current);
    setFlash({ model, text });
    flashTimer.current = setTimeout(() => { flashTimer.current = null; setFlash(null); }, MODEL_ROW_FLASH_MS);
  };
  React.useEffect(() => () => { if (flashTimer.current) clearTimeout(flashTimer.current); }, []);
  const selectRef = React.useRef<React.ElementRef<typeof Select>>(null);
  const managementRef = React.useRef<HTMLDivElement>(null);
  const disabled = new Set(management?.disabledModels || disabledModels);
  const allCandidates = [...options];
  if (value && !allCandidates.some((option) => option.value === value)) allCandidates.unshift({ value, label: value });
  const candidates = allCandidates.filter((option) => !disabled.has(option.value));
  if (management?.allowDefaultFallback) candidates.unshift({ value: '', label: placeholder });
  const customValue = search.trim();
  const customExists = allCandidates.some((option) => option.value.toLowerCase() === customValue.toLowerCase());
  if (customValue && !customExists) {
    candidates.push({ value: customValue, label: `${customLabel} ${customValue}` });
  }
  React.useEffect(() => {
    if (managementRequest > 0) {
      setMode('manage'); setSearch(''); setFlash(null); setOpen(true);
    }
  }, [managementRequest]);
  const close = () => { setOpen(false); setSearch(''); setMode('select'); };
  React.useEffect(() => {
    // The plain option menu is dismissed by Select itself; only the management
    // dialog owns its own outside-click handling.
    if (!open || !management || mode !== 'manage' || typeof document === 'undefined') return;
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!managementRef.current?.contains(target) && !selectRef.current?.nativeElement?.contains(target)) close();
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open, mode, Boolean(management)]);
  const choose = (next?: string) => {
    if (disabled.has(next || '')) return;
    onChange?.(next || '');
    if (mode !== 'manage') close();
  };
  const toggleModel = (model: string, enabled: boolean, reason: string, label: string) => {
    if (reason) { announce(model, reason); return; }
    management?.onToggle(model, !enabled);
    announce(model, management?.copy(enabled ? 'ai_settings.models.disabled' : 'ai_settings.models.enabled', { model: label }) || '');
  };
  const removeModel = (model: string, reason: string, label: string) => {
    if (reason) { announce(model, reason); return; }
    management?.onRemove(model);
    announce(model, management?.copy('ai_settings.models.removed', { model: label }) || '');
  };
  // Row callbacks must keep a stable identity or React.memo on the row can never
  // bail out. The ref carries the latest closure without changing that identity.
  const rowHandlersRef = React.useRef({ choose, toggleModel, removeModel });
  rowHandlersRef.current = { choose, toggleModel, removeModel };
  const stableRemove = React.useCallback((model: string, reason: string, label: string) =>
    rowHandlersRef.current.removeModel(model, reason, label), []);
  const stableSetDefault = React.useCallback((model: string) => rowHandlersRef.current.choose(model), []);
  const stableToggle = React.useCallback((model: string, enabled: boolean, reason: string, label: string) =>
    rowHandlersRef.current.toggleModel(model, enabled, reason, label), []);
  const renderManagement = (menu: React.ReactElement) => {
    const matches = (option: { value: string; label: string }) =>
      option.label.toLowerCase().includes(search.trim().toLowerCase());
    const renderRow = (option: { value: string; label: string }) => {
      const enabled = !disabled.has(option.value);
      const isDefault = option.value === management!.defaultModel;
      const isCompletion = option.value === management!.completionModel;
      const reason = isDefault ? 'ai_settings.models.default_required' : isCompletion ? 'ai_settings.models.completion_required'
        : enabledCount <= 1 && enabled && !management!.allowDefaultFallback ? 'ai_settings.models.one_required' : '';
      // 默认模型与自动补全模型是必填项，不允许删除（与停用的拦截语义一致）。
      const removeReason = isDefault ? 'ai_settings.models.remove_default_blocked'
        : isCompletion ? 'ai_settings.models.remove_completion_blocked' : '';
      return <ModelManagementRow
        key={option.value}
        value={option.value}
        label={option.label}
        enabled={enabled}
        isDefault={isDefault}
        badge={isDefault ? copy('ai_settings.provider.default') : isCompletion ? copy('ai_settings.form.section.inline_completion') : ''}
        reason={reason ? copy(reason) : ''}
        removeLabel={copy('ai_settings.models.remove')}
        removeReason={removeReason ? copy(removeReason) : ''}
        flash={flash?.model === option.value ? flash.text : ''}
        stateLabel={copy(enabled ? 'ai_settings.models.on' : 'ai_settings.models.off')}
        toggleLabel={copy('ai_settings.models.enable', { model: option.label })}
        setDefaultLabel={copy('ai_settings.models.set_default')}
        showSetDefault={enabled && !isDefault}
        onSetDefault={stableSetDefault}
        onToggle={stableToggle}
        onRemove={stableRemove}
      />;
    };
    // 刚被停用 / 删除的那一行在提示消失前保持原位可见：否则行会立刻缩进折叠分组，
    // 用户看不到「已停用」的确认，列表还会跳一下。
    const flashing = (option: { value: string }) => flash?.model === option.value;
    const visibleCandidates = allCandidates.filter((option) => (!disabled.has(option.value) || flashing(option)) && matches(option));
    const inactiveCandidates = allCandidates.filter((option) => disabled.has(option.value) && !flashing(option) && matches(option));
    // Opening the selector itself shows the plain option menu; the management
    // chrome (heading, search, switches) only appears from the enabled-count button.
    if (!management || mode !== 'manage') return menu;
    const { copy } = management;
    const enabledCount = allCandidates.filter((option) => !disabled.has(option.value)).length;
    const canAdd = Boolean(customValue && !customExists);
    const add = () => {
      if (!canAdd) return;
      management.onAdd(customValue);
      announce(customValue, copy('ai_settings.models.added', { model: customValue }));
      setSearch('');
    };
    return <div ref={managementRef} role="dialog" aria-label={copy('ai_settings.models.actions')} className="gonavi-ai-model-management" style={modelManagementBodyStyle} onMouseDown={(event) => {
      // A switch is an in-place edit. Prevent Select's blur from closing the
      // popup between toggles, while still allowing the search input to focus.
      if ((event.target as HTMLElement).closest('button')) event.preventDefault();
      event.stopPropagation();
    }} onKeyDown={(event) => {
      if (event.key === 'Escape') { event.stopPropagation(); close(); selectRef.current?.focus(); }
    }}>
      <div className="gonavi-ai-model-management-head">
        <span>{copy('ai_settings.models.manage')}</span>
        <span>{copy('ai_settings.models.enabled_count', { enabled: enabledCount, total: allCandidates.length })}</span>
        <button type="button" aria-label={copy('common.close')} onClick={() => { close(); selectRef.current?.focus(); }}>×</button>
      </div>
      <div className={`gonavi-ai-model-management-body${allCandidates.length <= 4 ? ' is-short' : ''}`}>
        <Input aria-label={copy('ai_settings.models.search')} placeholder={copy('ai_settings.models.search')}
          value={search} maxLength={150} onChange={(event) => setSearch(event.target.value)}
          onKeyDown={(event) => { event.stopPropagation(); if (event.key === 'Enter') { event.preventDefault(); add(); } else if (event.key === 'Escape') { close(); selectRef.current?.focus(); } }} />
        <div className="gonavi-ai-model-management-list" role="group" aria-label={copy('ai_settings.models.manage')}>
          {visibleCandidates.map(renderRow)}
          {canAdd && <button type="button" className="gonavi-ai-model-add" onClick={add}>{copy('ai_settings.models.add', { model: customValue })}</button>}
          {/* 已停用 / 已移除的模型折叠起来：默认只显示可用模型，列表本身保持清爽。 */}
          {inactiveCandidates.length > 0 && (
            <button type="button" className="gonavi-ai-model-inactive-toggle" aria-expanded={inactiveExpanded}
              onClick={() => setInactiveExpanded((value) => !value)}>
              {copy('ai_settings.models.inactive_group', { count: inactiveCandidates.length })}
            </button>
          )}
          {inactiveExpanded && inactiveCandidates.map(renderRow)}
        </div>
      </div>
      {/* Screen readers still get the confirmation; sighted users read it off the row popover. */}
      <div className="gonavi-ai-model-management-live" role="status" aria-live="polite">{flash?.text || ''}</div>
    </div>;
  };
  return (
    <Select
      {...ariaProps}
      ref={selectRef}
      id={id}
      className="gonavi-ai-model-select"
      aria-label={label}
      allowClear
      showSearch={mode === 'select'}
      optionFilterProp="label"
      optionLabelProp="value"
      size="middle"
      value={value || undefined}
      searchValue={search}
      onSearch={setSearch}
      open={open}
      onOpenChange={(next) => {
        // Select schedules a blur-close when focus moves into the management
        // input. Management owns dismissal (outside click, Escape or close), so
        // this delayed event must not dismiss an in-place model edit.
        if (!next && mode === 'manage') return;
        setOpen(next); if (!next) { setSearch(''); setMode('select'); }
      }}
      onBlur={(event) => { if (!managementRef.current?.contains(event?.relatedTarget as Node)) setSearch(''); }}
      onChange={choose}
      options={candidates}
      dropdownRender={management ? renderManagement : undefined}
      popupMatchSelectWidth={management ? 380 : false}
      classNames={{ popup: { root: management ? 'gonavi-ai-model-management-popup' : 'gonavi-ai-provider-form-popup' } }}
      listHeight={management ? MODEL_MANAGEMENT_BODY_HEIGHT : 240}
      placeholder={placeholder}
      loading={loading}
      style={{ width: '100%' }}
    />
  );
};

export default AIProviderModelSelect;
