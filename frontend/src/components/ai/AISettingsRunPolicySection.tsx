import React, { useState } from 'react';
import { Alert, Badge, Button, InputNumber, Segmented, Spin } from 'antd';
import { DownOutlined, ReloadOutlined, RightOutlined, SaveOutlined } from '@ant-design/icons';

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

interface NumericFieldSpec {
  key: NumericPolicyKey;
  labelKey: string;
  hintKey: string;
  value: number;
  min: number;
  max?: number;
  suffix?: string;
  scale?: number;
}

interface RuntimeFieldSpec {
  key: keyof AIRunRuntimeConfig;
  labelKey: string;
  hintKey: string;
  value: number;
  min: number;
  max: number;
  suffixKey: string;
}

const CONTENT_MAX_WIDTH = 560;
const INPUT_WIDTH = 128;

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
  const [advancedOpen, setAdvancedOpen] = useState(false);

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

  const ledgerPresentation = {
    ready: { badge: 'success' as const, label: copy('ai_settings.run_policy.ledger.ready') },
    locked: { badge: 'warning' as const, label: copy('ai_settings.run_policy.ledger.locked') },
    unavailable: { badge: 'default' as const, label: copy('ai_settings.run_policy.ledger.unavailable') },
  }[ledgerState];

  // 常用：调度方式 + 轮次上限 + 关键超时，一眼能看懂、经常需要调
  const primaryFields: NumericFieldSpec[] = [
    { key: 'maxToolRounds', labelKey: 'ai_settings.run_policy.max_tool_rounds.label', hintKey: 'ai_settings.run_policy.max_tool_rounds.hint', value: policy.maxToolRounds, min: 1, max: 100 },
    { key: 'maxActiveDuration', labelKey: 'ai_settings.run_policy.max_active_duration.label', hintKey: 'ai_settings.run_policy.max_active_duration.hint', value: durationMinutes(policy.maxActiveDuration), min: 1, max: 1440, suffix: copy('ai_settings.run_policy.unit.minutes'), scale: 60 * NANOSECONDS_PER_SECOND },
    { key: 'modelTurnTimeout', labelKey: 'ai_settings.run_policy.model_turn_timeout.label', hintKey: 'ai_settings.run_policy.model_turn_timeout.hint', value: durationSeconds(policy.modelTurnTimeout), min: 0, max: 86400, suffix: copy('ai_settings.run_policy.unit.seconds'), scale: NANOSECONDS_PER_SECOND },
    { key: 'maxTotalTokens', labelKey: 'ai_settings.run_policy.max_total_tokens.label', hintKey: 'ai_settings.run_policy.max_total_tokens.hint', value: policy.maxTotalTokens, min: 0, max: 100_000_000 },
    { key: 'maxToolResultBytes', labelKey: 'ai_settings.run_policy.max_tool_result_bytes.label', hintKey: 'ai_settings.run_policy.max_tool_result_bytes.hint', value: Math.round(policy.maxToolResultBytes / BYTES_PER_KIB), min: 1, max: 1024 * 1024, suffix: 'KiB', scale: BYTES_PER_KIB },
  ];

  // 高级：调优参数，默认值对大多数人够用
  const advancedFields: NumericFieldSpec[] = [
    { key: 'softToolRoundLimit', labelKey: 'ai_settings.run_policy.soft_tool_round_limit.label', hintKey: 'ai_settings.run_policy.soft_tool_round_limit.hint', value: policy.softToolRoundLimit, min: 1, max: 100 },
    { key: 'maxConsecutiveFailedToolRounds', labelKey: 'ai_settings.run_policy.max_failed_tool_rounds.label', hintKey: 'ai_settings.run_policy.max_failed_tool_rounds.hint', value: policy.maxConsecutiveFailedToolRounds, min: 1, max: 100 },
    { key: 'maxToolNudges', labelKey: 'ai_settings.run_policy.max_tool_nudges.label', hintKey: 'ai_settings.run_policy.max_tool_nudges.hint', value: policy.maxToolNudges, min: 0, max: 100 },
    { key: 'maxModelRetriesPerTurn', labelKey: 'ai_settings.run_policy.max_model_retries.label', hintKey: 'ai_settings.run_policy.max_model_retries.hint', value: policy.maxModelRetriesPerTurn, min: 0, max: 20 },
    { key: 'modelIdleTimeout', labelKey: 'ai_settings.run_policy.model_idle_timeout.label', hintKey: 'ai_settings.run_policy.model_idle_timeout.hint', value: durationSeconds(policy.modelIdleTimeout), min: 0, max: 86400, suffix: copy('ai_settings.run_policy.unit.seconds'), scale: NANOSECONDS_PER_SECOND },
    { key: 'defaultToolTimeout', labelKey: 'ai_settings.run_policy.default_tool_timeout.label', hintKey: 'ai_settings.run_policy.default_tool_timeout.hint', value: durationSeconds(policy.defaultToolTimeout), min: 0, max: 86400, suffix: copy('ai_settings.run_policy.unit.seconds'), scale: NANOSECONDS_PER_SECOND },
  ];

  const runtimeFields: RuntimeFieldSpec[] = [
    { key: 'controlPollInterval', labelKey: 'ai_settings.run_policy.runtime.control_poll_interval.label', hintKey: 'ai_settings.run_policy.runtime.control_poll_interval.hint', value: Math.max(1, Math.round(runtime.controlPollInterval / NANOSECONDS_PER_MILLISECOND)), min: 1, max: 60_000, suffixKey: 'ai_settings.run_policy.unit.milliseconds' },
    { key: 'policyWatchInterval', labelKey: 'ai_settings.run_policy.runtime.policy_watch_interval.label', hintKey: 'ai_settings.run_policy.runtime.policy_watch_interval.hint', value: Math.max(1, Math.round(runtime.policyWatchInterval / NANOSECONDS_PER_MILLISECOND)), min: 1, max: 60_000, suffixKey: 'ai_settings.run_policy.unit.milliseconds' },
    { key: 'workspaceSnapshotRenewInterval', labelKey: 'ai_settings.run_policy.runtime.workspace_renew_interval.label', hintKey: 'ai_settings.run_policy.runtime.workspace_renew_interval.hint', value: Math.max(1, Math.round(runtime.workspaceSnapshotRenewInterval / NANOSECONDS_PER_MILLISECOND)), min: 1, max: 86_400_000, suffixKey: 'ai_settings.run_policy.unit.milliseconds' },
    { key: 'workspaceSnapshotLeaseDuration', labelKey: 'ai_settings.run_policy.runtime.workspace_lease_duration.label', hintKey: 'ai_settings.run_policy.runtime.workspace_lease_duration.hint', value: Math.max(1, Math.round(runtime.workspaceSnapshotLeaseDuration / NANOSECONDS_PER_MILLISECOND)), min: 1, max: 86_400_000, suffixKey: 'ai_settings.run_policy.unit.milliseconds' },
  ];

  const styles: Record<string, React.CSSProperties> = {
    section: {
      display: 'flex',
      flexDirection: 'column',
      gap: 32,
      fontFamily: 'var(--gn-font-sans)',
      maxWidth: CONTENT_MAX_WIDTH,
      margin: '0 auto',
      width: '100%',
    },
    group: {
      display: 'flex',
      flexDirection: 'column',
      gap: 12,
    },
    groupTitle: {
      fontSize: 'var(--gn-font-size, 13px)',
      lineHeight: 1.4,
      fontWeight: 600,
      color: overlayTheme.titleText,
      margin: 0,
    },
    items: {
      display: 'flex',
      flexDirection: 'column',
      gap: 2,
    },
    item: {
      display: 'flex',
      alignItems: 'flex-start',
      justifyContent: 'space-between',
      gap: 24,
      padding: '10px 0',
      minHeight: 44,
    },
    itemText: {
      display: 'flex',
      flexDirection: 'column',
      gap: 2,
      minWidth: 0,
      flex: 1,
    },
    itemLabel: {
      fontSize: 'var(--gn-font-size-sm, 13px)',
      lineHeight: 1.4,
      fontWeight: 500,
      color: overlayTheme.titleText,
    },
    itemHint: {
      fontSize: 'var(--gn-font-size-sm, 12px)',
      lineHeight: 1.35,
      color: overlayTheme.mutedText,
    },
    itemControl: {
      flexShrink: 0,
      display: 'flex',
      alignItems: 'center',
      paddingTop: 1,
    },
    inputNumber: {
      width: INPUT_WIDTH,
      background: inputBg,
    },
    advancedToggle: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      padding: '6px 0',
      border: 0,
      background: 'transparent',
      color: overlayTheme.mutedText,
      fontSize: 'var(--gn-font-size-sm, 12px)',
      cursor: 'pointer',
      fontFamily: 'inherit',
      transition: 'color 0.12s ease',
    },
    advancedToggleIcon: {
      fontSize: '0.85em',
      transition: 'transform 0.15s ease',
    },
    footer: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      paddingTop: 8,
    },
    footerSpacer: { flex: 1 },
  };

  const renderNumericItem = (field: NumericFieldSpec) => {
    const label = copy(field.labelKey);
    const hint = copy(field.hintKey);
    return (
      <div key={field.key} style={styles.item}>
        <div style={styles.itemText}>
          <span style={styles.itemLabel}>{label}</span>
          <span style={styles.itemHint}>{hint}</span>
        </div>
        <span style={styles.itemControl}>
          <InputNumber
            value={field.value}
            min={field.min}
            max={field.max}
            precision={0}
            addonAfter={field.suffix}
            style={styles.inputNumber}
            onChange={(value) => updateNumber(field.key, value, field.scale)}
            aria-label={label}
          />
        </span>
      </div>
    );
  };

  const renderRuntimeItem = (field: RuntimeFieldSpec) => {
    const label = copy(field.labelKey);
    const hint = copy(field.hintKey);
    const suffix = copy(field.suffixKey);
    return (
      <div key={field.key} style={styles.item}>
        <div style={styles.itemText}>
          <span style={styles.itemLabel}>{label}</span>
          <span style={styles.itemHint}>{hint}</span>
        </div>
        <span style={styles.itemControl}>
          <InputNumber
            value={field.value}
            min={field.min}
            max={field.max}
            precision={0}
            addonAfter={suffix}
            style={styles.inputNumber}
            onChange={(value) => updateRuntimeMilliseconds(field.key, value)}
            aria-label={label}
          />
        </span>
      </div>
    );
  };

  return (
    <div style={styles.section}>
      {/* 状态 + 调度：两个一行的事，合并成一组 */}
      <div style={styles.group}>
        <h3 style={styles.groupTitle}>{copy('ai_settings.run_policy.dispatch.title')}</h3>
        <div style={styles.items}>
          <div style={styles.item}>
            <div style={styles.itemText}>
              <span style={styles.itemLabel}>{copy('ai_settings.run_policy.dispatch.title')}</span>
              <span style={styles.itemHint}>{copy('ai_settings.run_policy.dispatch.description')}</span>
            </div>
            <span style={styles.itemControl}>
              <Segmented
                value={policy.defaultDispatchMode}
                onChange={(value) => onChange({ ...policy, defaultDispatchMode: value === 'steer' ? 'steer' : 'queue' })}
                options={[
                  { label: copy('ai_settings.run_policy.dispatch.queue'), value: 'queue' },
                  { label: copy('ai_settings.run_policy.dispatch.steer'), value: 'steer' },
                ]}
                aria-label={copy('ai_settings.run_policy.dispatch.title')}
              />
            </span>
          </div>
          <div style={styles.item}>
            <div style={styles.itemText}>
              <span style={styles.itemLabel}>{copy('ai_settings.run_policy.ledger.title')}</span>
              <span style={styles.itemHint}>{copy('ai_settings.run_policy.ledger.description')}</span>
            </div>
            <span style={styles.itemControl}>
              <Badge
                status={ledgerPresentation.badge}
                text={ledgerPresentation.label}
                aria-label={`${copy('ai_settings.run_policy.ledger.title')}: ${ledgerPresentation.label}`}
              />
            </span>
          </div>
        </div>
      </div>

      {/* 预算与超时：常用字段直接平铺 */}
      <div style={styles.group}>
        <h3 style={styles.groupTitle}>{copy('ai_settings.run_policy.limits.title')}</h3>
        <div style={styles.items}>
          {primaryFields.map(renderNumericItem)}
        </div>

        {/* 高级字段折叠 */}
        <button
          type="button"
          style={styles.advancedToggle}
          onClick={() => setAdvancedOpen((open) => !open)}
          aria-expanded={advancedOpen}
          onMouseEnter={(e) => { e.currentTarget.style.color = overlayTheme.titleText; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = overlayTheme.mutedText; }}
        >
          {advancedOpen ? (
            <DownOutlined style={styles.advancedToggleIcon} />
          ) : (
            <RightOutlined style={styles.advancedToggleIcon} />
          )}
          <span>{advancedOpen
            ? copy('ai_settings.run_policy.advanced.collapse').replace('{count}', String(advancedFields.length + runtimeFields.length))
            : copy('ai_settings.run_policy.advanced.expand').replace('{count}', String(advancedFields.length + runtimeFields.length))}
          </span>
        </button>

        {advancedOpen && (
          <div style={styles.items}>
            {advancedFields.map(renderNumericItem)}
            {runtimeFields.map(renderRuntimeItem)}
          </div>
        )}
      </div>

      {error && <Alert type="error" showIcon message={error} />}

      <div style={styles.footer}>
        <Button
          icon={<ReloadOutlined />}
          onClick={onReload}
          disabled={loading || saving}
          aria-label={copy('ai_settings.run_policy.reload')}
        />
        <Button
          type="primary"
          icon={<SaveOutlined />}
          onClick={onSave}
          loading={saving}
          disabled={loading}
        >
          {copy('ai_settings.run_policy.save')}
        </Button>
        <span style={styles.footerSpacer} />
        {loading && <Spin size="small" />}
      </div>
    </div>
  );
};

export default AISettingsRunPolicySection;
