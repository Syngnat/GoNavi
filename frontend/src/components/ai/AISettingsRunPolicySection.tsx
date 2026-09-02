import React from 'react';
import { Alert, Badge, Button, InputNumber, Segmented, Spin } from 'antd';
import { ReloadOutlined, SaveOutlined } from '@ant-design/icons';

import { t as catalogTranslate } from '../../i18n/catalog';
import { useOptionalI18n } from '../../i18n/provider';
import type { OverlayWorkbenchTheme } from '../../utils/overlayWorkbenchTheme';
import {
  BYTES_PER_KIB,
  durationMinutes,
  durationSeconds,
  NANOSECONDS_PER_MILLISECOND,
  NANOSECONDS_PER_SECOND,
  type AIRunPolicy,
  type AIRunRuntimeConfig,
} from './aiRunPolicy';
import type { AgentLedgerState } from './aiRunHarnessClient';

interface AISettingsRunPolicySectionProps {
  policy: AIRunPolicy;
  runtime: AIRunRuntimeConfig;
  loading: boolean;
  saving: boolean;
  error: string;
  ledgerState: AgentLedgerState;
  overlayTheme: OverlayWorkbenchTheme;
  inputBg: string;
  onChange: (policy: AIRunPolicy) => void;
  onRuntimeChange: (runtime: AIRunRuntimeConfig) => void;
  onReload: () => void;
  onSave: () => void;
}

type NumericPolicyKey = Exclude<keyof AIRunPolicy, 'defaultDispatchMode'>;

const AISettingsRunPolicySection: React.FC<AISettingsRunPolicySectionProps> = ({
  policy,
  runtime,
  loading,
  saving,
  error,
  ledgerState,
  overlayTheme,
  inputBg,
  onChange,
  onRuntimeChange,
  onReload,
  onSave,
}) => {
  const i18n = useOptionalI18n();
  const copy = (key: string) => (i18n?.t ?? ((catalogKey) => catalogTranslate('en-US', catalogKey)))(key);
  const updateNumber = (key: NumericPolicyKey, value: number | null, scale = 1) => {
    if (value === null || !Number.isFinite(value)) return;
    onChange({ ...policy, [key]: Math.max(0, Math.round(value * scale)) });
  };
  const updateRuntimeMilliseconds = (
    key: keyof AIRunRuntimeConfig,
    value: number | null,
  ) => {
    if (value === null || !Number.isFinite(value)) return;
    onRuntimeChange({
      ...runtime,
      [key]: Math.max(1, Math.round(value * NANOSECONDS_PER_MILLISECOND)),
    });
  };
  const inputStyle = { width: '100%', background: inputBg };
  const ledgerPresentation = {
    ready: { badge: 'success' as const, label: copy('ai_settings.run_policy.ledger.ready') },
    locked: { badge: 'warning' as const, label: copy('ai_settings.run_policy.ledger.locked') },
    unavailable: { badge: 'default' as const, label: copy('ai_settings.run_policy.ledger.unavailable') },
  }[ledgerState];
  const fields: Array<{
    key: NumericPolicyKey;
    label: string;
    hint: string;
    value: number;
    min: number;
    max?: number;
    suffix?: string;
    scale?: number;
  }> = [
    { key: 'softToolRoundLimit', label: copy('ai_settings.run_policy.soft_tool_round_limit.label'), hint: copy('ai_settings.run_policy.soft_tool_round_limit.hint'), value: policy.softToolRoundLimit, min: 1, max: 100 },
    { key: 'maxToolRounds', label: copy('ai_settings.run_policy.max_tool_rounds.label'), hint: copy('ai_settings.run_policy.max_tool_rounds.hint'), value: policy.maxToolRounds, min: 1, max: 100 },
    { key: 'maxConsecutiveFailedToolRounds', label: copy('ai_settings.run_policy.max_failed_tool_rounds.label'), hint: copy('ai_settings.run_policy.max_failed_tool_rounds.hint'), value: policy.maxConsecutiveFailedToolRounds, min: 1, max: 100 },
    { key: 'maxToolNudges', label: copy('ai_settings.run_policy.max_tool_nudges.label'), hint: copy('ai_settings.run_policy.max_tool_nudges.hint'), value: policy.maxToolNudges, min: 0, max: 100 },
    { key: 'maxModelRetriesPerTurn', label: copy('ai_settings.run_policy.max_model_retries.label'), hint: copy('ai_settings.run_policy.max_model_retries.hint'), value: policy.maxModelRetriesPerTurn, min: 0, max: 20 },
    { key: 'maxActiveDuration', label: copy('ai_settings.run_policy.max_active_duration.label'), hint: copy('ai_settings.run_policy.max_active_duration.hint'), value: durationMinutes(policy.maxActiveDuration), min: 1, max: 1440, suffix: copy('ai_settings.run_policy.unit.minutes'), scale: 60 * NANOSECONDS_PER_SECOND },
    { key: 'modelTurnTimeout', label: copy('ai_settings.run_policy.model_turn_timeout.label'), hint: copy('ai_settings.run_policy.model_turn_timeout.hint'), value: durationSeconds(policy.modelTurnTimeout), min: 0, max: 86400, suffix: copy('ai_settings.run_policy.unit.seconds'), scale: NANOSECONDS_PER_SECOND },
    { key: 'modelIdleTimeout', label: copy('ai_settings.run_policy.model_idle_timeout.label'), hint: copy('ai_settings.run_policy.model_idle_timeout.hint'), value: durationSeconds(policy.modelIdleTimeout), min: 0, max: 86400, suffix: copy('ai_settings.run_policy.unit.seconds'), scale: NANOSECONDS_PER_SECOND },
    { key: 'defaultToolTimeout', label: copy('ai_settings.run_policy.default_tool_timeout.label'), hint: copy('ai_settings.run_policy.default_tool_timeout.hint'), value: durationSeconds(policy.defaultToolTimeout), min: 0, max: 86400, suffix: copy('ai_settings.run_policy.unit.seconds'), scale: NANOSECONDS_PER_SECOND },
    { key: 'maxTotalTokens', label: copy('ai_settings.run_policy.max_total_tokens.label'), hint: copy('ai_settings.run_policy.max_total_tokens.hint'), value: policy.maxTotalTokens, min: 0, max: 100_000_000 },
    { key: 'maxToolResultBytes', label: copy('ai_settings.run_policy.max_tool_result_bytes.label'), hint: copy('ai_settings.run_policy.max_tool_result_bytes.hint'), value: Math.round(policy.maxToolResultBytes / BYTES_PER_KIB), min: 1, max: 1024 * 1024, suffix: 'KiB', scale: BYTES_PER_KIB },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, fontFamily: 'var(--gn-font-sans)' }}>
      <div>
        <h3 style={{ fontSize: 'var(--gn-font-size, 14px)', lineHeight: '20px', fontWeight: 600, color: overlayTheme.titleText, margin: '0 0 2px' }}>
          {copy('ai_settings.run_policy.ledger.title')}
        </h3>
        <div style={{ color: overlayTheme.mutedText, fontSize: 'var(--gn-font-size-sm, 12px)', lineHeight: '18px', marginBottom: 8 }}>
          {copy('ai_settings.run_policy.ledger.description')}
        </div>
        <Badge
          status={ledgerPresentation.badge}
          text={ledgerPresentation.label}
          aria-label={`${copy('ai_settings.run_policy.ledger.title')}: ${ledgerPresentation.label}`}
        />
      </div>

      <div>
        <h3 style={{ fontSize: 'var(--gn-font-size, 14px)', lineHeight: '20px', fontWeight: 600, color: overlayTheme.titleText, margin: '0 0 2px' }}>
          {copy('ai_settings.run_policy.dispatch.title')}
        </h3>
        <div style={{ color: overlayTheme.mutedText, fontSize: 'var(--gn-font-size-sm, 12px)', lineHeight: '18px', marginBottom: 8 }}>
          {copy('ai_settings.run_policy.dispatch.description')}
        </div>
        <Segmented
          value={policy.defaultDispatchMode}
          onChange={(value) => onChange({ ...policy, defaultDispatchMode: value === 'steer' ? 'steer' : 'queue' })}
          options={[
            { label: copy('ai_settings.run_policy.dispatch.queue'), value: 'queue' },
            { label: copy('ai_settings.run_policy.dispatch.steer'), value: 'steer' },
          ]}
          aria-label={copy('ai_settings.run_policy.dispatch.title')}
        />
      </div>

      <div>
        <h3 style={{ fontSize: 'var(--gn-font-size, 14px)', lineHeight: '20px', fontWeight: 600, color: overlayTheme.titleText, margin: '0 0 2px' }}>
          {copy('ai_settings.run_policy.limits.title')}
        </h3>
        <div style={{ color: overlayTheme.mutedText, fontSize: 'var(--gn-font-size-sm, 12px)', lineHeight: '18px', marginBottom: 10 }}>
          {copy('ai_settings.run_policy.limits.description')}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(196px, 1fr))', gap: '12px 16px' }}>
          {fields.map((field) => (
            <label key={field.key} style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ color: overlayTheme.titleText, fontSize: 'var(--gn-font-size-sm, 12px)', lineHeight: '18px', fontWeight: 600 }}>{field.label}</span>
              <InputNumber
                value={field.value}
                min={field.min}
                max={field.max}
                precision={0}
                addonAfter={field.suffix}
                style={inputStyle}
                onChange={(value) => updateNumber(field.key, value, field.scale)}
                aria-label={field.label}
              />
              <span style={{ color: overlayTheme.mutedText, fontSize: 11, lineHeight: '15px', minHeight: 30 }}>{field.hint}</span>
            </label>
          ))}
        </div>
      </div>

      <div>
        <h3 style={{ fontSize: 'var(--gn-font-size, 14px)', lineHeight: '20px', fontWeight: 600, color: overlayTheme.titleText, margin: '0 0 2px' }}>
          {copy('ai_settings.run_policy.runtime.title')}
        </h3>
        <div style={{ color: overlayTheme.mutedText, fontSize: 'var(--gn-font-size-sm, 12px)', lineHeight: '18px', marginBottom: 10 }}>
          {copy('ai_settings.run_policy.runtime.description')}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(196px, 1fr))', gap: '12px 16px' }}>
          <label style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ color: overlayTheme.titleText, fontSize: 'var(--gn-font-size-sm, 12px)', lineHeight: '18px', fontWeight: 600 }}>{copy('ai_settings.run_policy.runtime.control_poll_interval.label')}</span>
            <InputNumber
              value={Math.max(1, Math.round(runtime.controlPollInterval / NANOSECONDS_PER_MILLISECOND))}
              min={1}
              max={60_000}
              precision={0}
              addonAfter={copy('ai_settings.run_policy.unit.milliseconds')}
              style={inputStyle}
              onChange={(value) => updateRuntimeMilliseconds('controlPollInterval', value)}
              aria-label={copy('ai_settings.run_policy.runtime.control_poll_interval.label')}
            />
            <span style={{ color: overlayTheme.mutedText, fontSize: 11, lineHeight: '15px', minHeight: 30 }}>{copy('ai_settings.run_policy.runtime.control_poll_interval.hint')}</span>
          </label>
          <label style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ color: overlayTheme.titleText, fontSize: 'var(--gn-font-size-sm, 12px)', lineHeight: '18px', fontWeight: 600 }}>{copy('ai_settings.run_policy.runtime.policy_watch_interval.label')}</span>
            <InputNumber
              value={Math.max(1, Math.round(runtime.policyWatchInterval / NANOSECONDS_PER_MILLISECOND))}
              min={1}
              max={60_000}
              precision={0}
              addonAfter={copy('ai_settings.run_policy.unit.milliseconds')}
              style={inputStyle}
              onChange={(value) => updateRuntimeMilliseconds('policyWatchInterval', value)}
              aria-label={copy('ai_settings.run_policy.runtime.policy_watch_interval.label')}
            />
            <span style={{ color: overlayTheme.mutedText, fontSize: 11, lineHeight: '15px', minHeight: 30 }}>{copy('ai_settings.run_policy.runtime.policy_watch_interval.hint')}</span>
          </label>
          <label style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ color: overlayTheme.titleText, fontSize: 'var(--gn-font-size-sm, 12px)', lineHeight: '18px', fontWeight: 600 }}>{copy('ai_settings.run_policy.runtime.workspace_renew_interval.label')}</span>
            <InputNumber
              value={Math.max(1, Math.round(runtime.workspaceSnapshotRenewInterval / NANOSECONDS_PER_MILLISECOND))}
              min={1}
              max={86_400_000}
              precision={0}
              addonAfter={copy('ai_settings.run_policy.unit.milliseconds')}
              style={inputStyle}
              onChange={(value) => updateRuntimeMilliseconds('workspaceSnapshotRenewInterval', value)}
              aria-label={copy('ai_settings.run_policy.runtime.workspace_renew_interval.label')}
            />
            <span style={{ color: overlayTheme.mutedText, fontSize: 11, lineHeight: '15px', minHeight: 30 }}>{copy('ai_settings.run_policy.runtime.workspace_renew_interval.hint')}</span>
          </label>
          <label style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ color: overlayTheme.titleText, fontSize: 'var(--gn-font-size-sm, 12px)', lineHeight: '18px', fontWeight: 600 }}>{copy('ai_settings.run_policy.runtime.workspace_lease_duration.label')}</span>
            <InputNumber
              value={Math.max(1, Math.round(runtime.workspaceSnapshotLeaseDuration / NANOSECONDS_PER_MILLISECOND))}
              min={1}
              max={86_400_000}
              precision={0}
              addonAfter={copy('ai_settings.run_policy.unit.milliseconds')}
              style={inputStyle}
              onChange={(value) => updateRuntimeMilliseconds('workspaceSnapshotLeaseDuration', value)}
              aria-label={copy('ai_settings.run_policy.runtime.workspace_lease_duration.label')}
            />
            <span style={{ color: overlayTheme.mutedText, fontSize: 11, lineHeight: '15px', minHeight: 30 }}>{copy('ai_settings.run_policy.runtime.workspace_lease_duration.hint')}</span>
          </label>
        </div>
      </div>

      {error && <Alert type="error" showIcon message={error} />}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 32 }}>
        <Button icon={<ReloadOutlined />} onClick={onReload} disabled={loading || saving} aria-label={copy('ai_settings.run_policy.reload')} />
        <Button type="primary" icon={<SaveOutlined />} onClick={onSave} loading={saving} disabled={loading}>
          {copy('ai_settings.run_policy.save')}
        </Button>
        {loading && <Spin size="small" />}
      </div>
    </div>
  );
};

export default AISettingsRunPolicySection;
