import React from 'react';
import { Slider, InputNumber } from 'antd';

type ThemeSettingsSliderUnit = 'percent' | 'px' | 'none';

type ThemeSettingsSliderProps = {
  min: number;
  max: number;
  step?: number;
  value: number;
  onChange: (value: number) => void;
  disabled?: boolean;
  marks?: Record<number, string>;
  /** percent：右侧按百分比输入（内部仍用 0~1 / 0.8~1.25 比例） */
  unit?: ThemeSettingsSliderUnit;
};

const clampThemeSliderValue = (value: number, min: number, max: number, step?: number): number => {
  let next = Math.min(max, Math.max(min, value));
  if (step && step > 0) {
    const steps = Math.round((next - min) / step);
    next = min + steps * step;
    // 消除浮点误差
    const decimals = String(step).includes('.') ? (String(step).split('.')[1]?.length ?? 0) : 0;
    if (decimals > 0) {
      next = Number(next.toFixed(decimals));
    }
    next = Math.min(max, Math.max(min, next));
  }
  return next;
};

/** 主题设置页：滑条 + 底部预设 + 可编辑数值 */
export const ThemeSettingsSlider: React.FC<ThemeSettingsSliderProps> = ({
  min,
  max,
  step,
  value,
  onChange,
  disabled,
  marks,
  unit = 'none',
}) => {
  const isPercent = unit === 'percent';
  const minN = Number(min);
  const maxN = Number(max);
  const span = maxN - minN || 1;
  const stepN = step === undefined || step === null ? undefined : Number(step);
  const current = Number(value);
  const displayMin = isPercent ? minN * 100 : minN;
  const displayMax = isPercent ? maxN * 100 : maxN;
  const displayStep = isPercent
    ? (stepN !== undefined ? stepN * 100 : 1)
    : (stepN !== undefined ? stepN : 1);
  const displayValue = Number.isFinite(current)
    ? (isPercent ? Number((current * 100).toFixed(4)) : current)
    : displayMin;

  const commitDisplayValue = (raw: number | string | null) => {
    if (raw === null || raw === undefined || raw === '') {
      return;
    }
    const parsed = typeof raw === 'number' ? raw : Number(String(raw).trim().replace(/%/g, ''));
    if (!Number.isFinite(parsed)) {
      return;
    }
    const modelValue = isPercent ? parsed / 100 : parsed;
    onChange(clampThemeSliderValue(modelValue, minN, maxN, stepN));
  };

  const markEntries = marks
    ? Object.entries(marks).map(([raw, label]) => ({
        value: Number(raw),
        label,
      }))
    : [];

  return (
    <div className={`gonavi-settings-slider-row${marks ? ' has-marks' : ''}`}>
      <div className="gonavi-settings-slider-main">
        <div className="gonavi-settings-slider-track-wrap">
          <Slider
            min={minN}
            max={maxN}
            step={stepN}
            value={current}
            onChange={(next) => {
              const n = Array.isArray(next) ? next[0] : next;
              if (typeof n === 'number' && Number.isFinite(n)) {
                onChange(clampThemeSliderValue(n, minN, maxN, stepN));
              }
            }}
            disabled={disabled}
            tooltip={{ open: false }}
          />
        </div>
        {markEntries.length > 0 ? (
          <div className="gonavi-settings-slider-presets" role="group">
            {markEntries.map((mark) => {
              const pct = ((mark.value - minN) / span) * 100;
              const active = Number.isFinite(current)
                ? (stepN && stepN > 0
                  ? Math.abs(current - mark.value) <= stepN / 2 + 1e-9
                  : Math.abs(current - mark.value) < 1e-6)
                : false;
              return (
                <button
                  key={String(mark.value)}
                  type="button"
                  className={`gonavi-settings-slider-preset${active ? ' is-active' : ''}`}
                  style={{ left: `${pct}%` }}
                  disabled={Boolean(disabled)}
                  onClick={() => {
                    if (disabled) return;
                    onChange(clampThemeSliderValue(mark.value, minN, maxN, stepN));
                  }}
                >
                  {mark.label}
                </button>
              );
            })}
          </div>
        ) : null}
      </div>
      <InputNumber
        className="gonavi-settings-slider-value-input"
        size="small"
        min={displayMin}
        max={displayMax}
        step={displayStep}
        value={displayValue}
        disabled={disabled}
        controls={false}
        keyboard
        stringMode={false}
        style={{ width: unit === 'none' ? 48 : 62 }}
        addonAfter={unit === 'percent' ? '%' : unit === 'px' ? 'px' : undefined}
        onChange={(next) => {
          if (typeof next === 'number') {
            commitDisplayValue(next);
          }
        }}
        onBlur={(event) => {
          commitDisplayValue(event.target.value);
        }}
        onPressEnter={(event) => {
          commitDisplayValue((event.target as HTMLInputElement).value);
          (event.target as HTMLInputElement).blur();
        }}
      />
    </div>
  );
};
