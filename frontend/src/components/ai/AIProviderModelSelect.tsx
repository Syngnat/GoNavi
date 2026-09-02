import React from 'react';
import { Input, Select, Tooltip } from 'antd';
import { passThroughHintTooltip } from '../common/tooltipTiming';

// The management popup reserves this much room for its switchable body from the
// first open. Both tabs then render inside a box of the same height, so choosing a
// default or flipping to the manage tab can no longer resize the popup and make it
// jump against its trigger. This module is the single source: the stylesheet reads
// it through MODEL_MANAGEMENT_BODY_HEIGHT_VAR rather than repeating the number.
export const MODEL_MANAGEMENT_BODY_HEIGHT = 280;
export const MODEL_MANAGEMENT_BODY_HEIGHT_VAR = '--gn-model-management-body-height';
export const modelManagementBodyStyle = {
  [MODEL_MANAGEMENT_BODY_HEIGHT_VAR]: `${MODEL_MANAGEMENT_BODY_HEIGHT}px`,
} as React.CSSProperties;

interface ModelManagementRowProps {
  value: string;
  label: string;
  enabled: boolean;
  badge: string;
  /** Empty when the switch is actionable; otherwise the localized blocking reason. */
  reason: string;
  stateLabel: string;
  toggleLabel: string;
  setDefaultLabel: string;
  showSetDefault: boolean;
  onSetDefault: (value: string) => void;
  onToggle: (value: string, enabled: boolean, reason: string, label: string) => void;
}

// Memoized so toggling one model re-renders that row alone. Without it every
// switch click re-rendered the whole popup, which is what made the enable and
// set-default buttons feel like they lagged the click on large model lists.
export const ModelManagementRow = React.memo<ModelManagementRowProps>(({
  value, label, enabled, badge, reason, stateLabel, toggleLabel, setDefaultLabel, showSetDefault, onSetDefault, onToggle,
}) => <div className={`gonavi-ai-model-management-row${enabled ? '' : ' is-disabled'}`}>
  <div className="gonavi-ai-model-management-name">
    <Tooltip title={label} {...passThroughHintTooltip}><span>{label}</span></Tooltip>
    {badge && <small>{badge}</small>}
  </div>
  <div className="gonavi-ai-model-management-actions">
    {showSetDefault && <button type="button" aria-label={`${setDefaultLabel}: ${label}`}
      onClick={() => onSetDefault(value)}>{setDefaultLabel}</button>}
    <Tooltip title={reason || undefined} {...passThroughHintTooltip}>
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
  const [feedback, setFeedback] = React.useState('');
  const selectRef = React.useRef<React.ElementRef<typeof Select>>(null);
  const managementRef = React.useRef<HTMLDivElement>(null);
  const focusCleanupRef = React.useRef<(() => void) | null>(null);
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
      setMode('manage'); setSearch(''); setFeedback(''); setOpen(true);
    }
  }, [managementRequest]);
  const close = () => { setOpen(false); setSearch(''); setMode('select'); };
  const focusManagementInput = React.useMemo(() => {
    let focused = false;
    return (input: React.ElementRef<typeof Input> | null) => {
      focusCleanupRef.current?.();
      focusCleanupRef.current = null;
      if (focused || !open || mode !== 'manage' || !input?.input) return;
      const focusOnce = () => { focused = true; input.focus(); };
      if (input.input.offsetWidth) { focusOnce(); return; }
      // Select retains a hidden portal, and Input renews its imperative ref on
      // every render. Wait for visibility, then focus only once per opening so
      // changing a switch does not steal keyboard focus back from that switch.
      if (typeof ResizeObserver === 'undefined') return;
      const observer = new ResizeObserver(() => {
        if (!input.input?.offsetWidth) return;
        observer.disconnect(); focusCleanupRef.current = null; focusOnce();
      });
      focusCleanupRef.current = () => observer.disconnect();
      observer.observe(input.input);
    };
  }, [open, mode]);
  React.useEffect(() => {
    if (!open || !management || typeof document === 'undefined') return;
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!managementRef.current?.contains(target) && !selectRef.current?.nativeElement?.contains(target)) close();
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open, Boolean(management)]);
  const choose = (next?: string) => {
    if (disabled.has(next || '')) return;
    onChange?.(next || '');
    if (mode !== 'manage') close();
  };
  const toggleModel = (model: string, enabled: boolean, reason: string, label: string) => {
    if (reason) { setFeedback(reason); return; }
    management?.onToggle(model, !enabled);
    setFeedback(management?.copy(enabled ? 'ai_settings.models.disabled' : 'ai_settings.models.enabled', { model: label }) || '');
  };
  // Row callbacks must keep a stable identity or React.memo on the row can never
  // bail out. The ref carries the latest closure without changing that identity.
  const rowHandlersRef = React.useRef({ choose, toggleModel });
  rowHandlersRef.current = { choose, toggleModel };
  const stableSetDefault = React.useCallback((model: string) => rowHandlersRef.current.choose(model), []);
  const stableToggle = React.useCallback((model: string, enabled: boolean, reason: string, label: string) =>
    rowHandlersRef.current.toggleModel(model, enabled, reason, label), []);
  const renderManagement = (menu: React.ReactElement) => {
    if (!management) return menu;
    const { copy } = management;
    const enabledCount = allCandidates.filter((option) => !disabled.has(option.value)).length;
    const canAdd = Boolean(customValue && !customExists);
    const add = () => {
      if (!canAdd) return;
      management.onAdd(customValue);
      setFeedback(copy('ai_settings.models.added', { model: customValue }));
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
        <div role="group" aria-label={copy('ai_settings.models.actions')}>
          {(['select', 'manage'] as const).map((next) => <button type="button" key={next} aria-pressed={mode === next}
            onClick={() => { setMode(next); setFeedback(''); }}>{copy(`ai_settings.models.${next}`)}</button>)}
        </div>
        <span>{copy('ai_settings.models.enabled_count', { enabled: enabledCount, total: allCandidates.length })}</span>
        <button type="button" aria-label={copy('common.close')} onClick={() => { close(); selectRef.current?.focus(); }}>×</button>
      </div>
      <div className="gonavi-ai-model-management-body">{mode === 'select' ? menu : <>
        <Input ref={focusManagementInput} aria-label={copy('ai_settings.models.search')} placeholder={copy('ai_settings.models.search')}
          value={search} maxLength={150} onChange={(event) => setSearch(event.target.value)}
          onKeyDown={(event) => { event.stopPropagation(); if (event.key === 'Enter') { event.preventDefault(); add(); } else if (event.key === 'Escape') { close(); selectRef.current?.focus(); } }} />
        <div className="gonavi-ai-model-management-list" role="group" aria-label={copy('ai_settings.models.manage')}>
          {management.allowDefaultFallback && !search && <div className="gonavi-ai-model-management-row">
            <span>{placeholder}</span><button type="button" onClick={() => choose('')}>{copy(management.defaultModel ? 'ai_settings.models.set_default' : 'ai_settings.provider.default')}</button>
          </div>}
          {allCandidates.filter((option) => option.label.toLowerCase().includes(search.trim().toLowerCase())).map((option) => {
            const enabled = !disabled.has(option.value);
            const isDefault = option.value === management.defaultModel;
            const isCompletion = option.value === management.completionModel;
            const reason = isDefault ? 'ai_settings.models.default_required' : isCompletion ? 'ai_settings.models.completion_required'
              : enabledCount <= 1 && enabled && !management.allowDefaultFallback ? 'ai_settings.models.one_required' : '';
            return <ModelManagementRow
              key={option.value}
              value={option.value}
              label={option.label}
              enabled={enabled}
              badge={isDefault || isCompletion ? copy(isDefault ? 'ai_settings.provider.default' : 'ai_settings.form.section.inline_completion') : ''}
              reason={reason ? copy(reason) : ''}
              stateLabel={copy(enabled ? 'ai_settings.models.on' : 'ai_settings.models.off')}
              toggleLabel={copy('ai_settings.models.enable', { model: option.label })}
              setDefaultLabel={copy('ai_settings.models.set_default')}
              showSetDefault={enabled && !isDefault}
              onSetDefault={stableSetDefault}
              onToggle={stableToggle}
            />;
          })}
          {canAdd && <button type="button" className="gonavi-ai-model-add" onClick={add}>{copy('ai_settings.models.add', { model: customValue })}</button>}
        </div>
      </>}</div>
      <div className="gonavi-ai-model-management-foot"><div>{management.source}</div><div>{copy('ai_settings.models.scope')}</div>
        <div role="status" aria-live="polite">{feedback}</div>
      </div>
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
      popupMatchSelectWidth={management ? 380 : true}
      popupClassName={management ? 'gonavi-ai-model-management-popup' : undefined}
      listHeight={management ? MODEL_MANAGEMENT_BODY_HEIGHT : 240}
      placeholder={placeholder}
      loading={loading}
      style={{ width: '100%' }}
    />
  );
};

export default AIProviderModelSelect;
