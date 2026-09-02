import { Button, ColorPicker, Segmented } from 'antd';
import { useEffect, useMemo, useState } from 'react';

import { useCustomThemeStore } from '../../customThemeStore';
import { useI18n } from '../../i18n/provider';
import { useStore } from '../../store';
import {
  TOOLBAR_BUTTON_COLOR_TARGETS,
  applyToolbarButtonColorOverride,
  clearToolbarButtonColorOverrides,
  getToolbarButtonColorToken,
  getToolbarButtonCssVariableName,
  type ToolbarButtonColorOverrides,
  type ToolbarButtonColorScope,
  type ToolbarButtonColorTarget,
  type ToolbarButtonColorToken,
  type ToolbarButtonKind,
  type ToolbarButtonState,
} from '../../utils/toolbarAppearance';
import './ToolbarButtonAppearanceSettings.css';

type ToolbarButtonColorRole = 'fg' | 'bg' | 'border';
type OverrideStatus = 'theme' | 'custom' | 'mixed';

const COLOR_ROLES: readonly ToolbarButtonColorRole[] = ['fg', 'bg', 'border'];

const targetsForScope = (
  scope: ToolbarButtonColorScope,
): readonly ToolbarButtonColorTarget[] => (
  scope === 'all' ? TOOLBAR_BUTTON_COLOR_TARGETS : [scope]
);

export const resolveToolbarButtonOverrideStatus = (
  overrides: ToolbarButtonColorOverrides,
  scope: ToolbarButtonColorScope,
  token: ToolbarButtonColorToken,
): OverrideStatus => {
  const values = targetsForScope(scope).map((target) => overrides[target]?.[token]);
  if (values.every((value) => value === undefined)) return 'theme';
  return new Set(values).size === 1 ? 'custom' : 'mixed';
};

export const canResetToolbarButtonColor = (status: OverrideStatus): boolean => status !== 'theme';

const hasOverridesForSelection = (
  overrides: ToolbarButtonColorOverrides,
  scope: ToolbarButtonColorScope,
  kind: ToolbarButtonKind,
  state: ToolbarButtonState,
): boolean => COLOR_ROLES.some((role) => (
  resolveToolbarButtonOverrideStatus(
    overrides,
    scope,
    getToolbarButtonColorToken(kind, state, role),
  ) !== 'theme'
));

const clearSelectionOverrides = (
  overrides: ToolbarButtonColorOverrides,
  scope: ToolbarButtonColorScope,
  kind: ToolbarButtonKind,
  state: ToolbarButtonState,
): ToolbarButtonColorOverrides => COLOR_ROLES.reduce(
  (next, role) => applyToolbarButtonColorOverride(
    next,
    scope,
    getToolbarButtonColorToken(kind, state, role),
    null,
  ),
  overrides,
);

export const resolveToolbarButtonFallbackColor = (
  kind: ToolbarButtonKind,
  state: ToolbarButtonState,
  role: ToolbarButtonColorRole,
  darkMode: boolean,
): string => {
  if (state === 'disabled') {
    if (kind === 'primary') {
      if (role === 'fg') return darkMode
        ? 'rgba(255, 255, 255, 0.48)'
        : 'rgba(255, 255, 255, 0.78)';
      if (role === 'bg') return darkMode
        ? 'rgba(34, 197, 94, 0.26)'
        : 'rgba(22, 163, 74, 0.32)';
      return darkMode
        ? 'rgba(34, 197, 94, 0.20)'
        : 'rgba(22, 163, 74, 0.24)';
    }
    if (role === 'fg') return darkMode
      ? 'rgba(229, 231, 235, 0.42)'
      : 'rgba(39, 48, 63, 0.42)';
    if (role === 'bg') return darkMode
      ? 'rgba(255, 255, 255, 0.04)'
      : 'rgba(15, 23, 42, 0.04)';
    return darkMode
      ? 'rgba(255, 255, 255, 0.10)'
      : 'rgba(15, 23, 42, 0.10)';
  }
  if (kind === 'primary') {
    if (role === 'fg') return '#ffffff';
    if (state === 'hover') return darkMode ? '#4ade80' : '#15803d';
    if (state === 'active') return darkMode ? '#16a34a' : '#166534';
    return darkMode ? '#22c55e' : '#16a34a';
  }
  if (role === 'fg') return darkMode ? '#e5e7eb' : '#27303f';
  if (role === 'bg') {
    if (state === 'hover') return darkMode ? 'rgba(255, 255, 255, 0.08)' : 'rgba(15, 23, 42, 0.06)';
    if (state === 'active') return darkMode ? 'rgba(255, 255, 255, 0.12)' : 'rgba(15, 23, 42, 0.10)';
    return darkMode ? '#1d202b' : '#ffffff';
  }
  return darkMode ? 'rgba(255, 255, 255, 0.18)' : 'rgba(15, 23, 42, 0.18)';
};

const resolveComputedColor = (
  target: ToolbarButtonColorTarget,
  token: ToolbarButtonColorToken,
  fallback: string,
): string => {
  if (typeof document === 'undefined' || !document.body) return fallback;
  const probe = document.createElement('span');
  const scopedVariable = getToolbarButtonCssVariableName(target, token);
  const commonVariable = `--gn-toolbar-${token}`;
  probe.setAttribute('aria-hidden', 'true');
  probe.style.cssText = 'position:fixed;left:-10000px;top:-10000px;visibility:hidden;pointer-events:none;';
  probe.style.color = `var(${scopedVariable}, var(${commonVariable}, ${fallback}))`;
  document.body.appendChild(probe);
  const resolved = document.defaultView?.getComputedStyle(probe).color.trim() || fallback;
  probe.remove();
  return resolved;
};

const selectedOverrideValue = (
  overrides: ToolbarButtonColorOverrides,
  scope: ToolbarButtonColorScope,
  token: ToolbarButtonColorToken,
): string | undefined => {
  const target = scope === 'result' ? 'result' : 'query';
  return overrides[target]?.[token];
};

const toHexByte = (value: number): string => Math.round(
  Math.min(255, Math.max(0, value)),
).toString(16).padStart(2, '0').toUpperCase();

export const formatToolbarButtonColorText = (value: string): string => {
  const normalized = value.trim();
  if (/^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(normalized)) {
    return normalized.toUpperCase();
  }
  const rgbMatch = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/i.exec(
    normalized,
  );
  if (!rgbMatch) return normalized;
  const alpha = rgbMatch[4] === undefined ? 1 : Number(rgbMatch[4]);
  if (![1, 2, 3].every((index) => Number.isFinite(Number(rgbMatch[index]))) || !Number.isFinite(alpha)) {
    return normalized;
  }
  const opaqueHex = `#${toHexByte(Number(rgbMatch[1]))}${toHexByte(Number(rgbMatch[2]))}${toHexByte(Number(rgbMatch[3]))}`;
  return alpha >= 1 ? opaqueHex : `${opaqueHex}${toHexByte(alpha * 255)}`;
};

export default function ToolbarButtonAppearanceSettings() {
  const { t } = useI18n();
  const overrides = useStore((state) => state.appearance.toolbarButtonColorOverrides);
  const setAppearance = useStore((state) => state.setAppearance);
  const themeMode = useStore((state) => state.theme);
  const activeCustomThemeRevision = useCustomThemeStore((state) => {
    const activeTheme = state.themes.find((theme) => theme.id === state.activeThemeId);
    if (!activeTheme) return state.activeThemeId ?? '';
    return [
      activeTheme.id,
      activeTheme.updatedAt,
      activeTheme.baseMode,
      activeTheme.css,
    ].join(':');
  });
  const [scope, setScope] = useState<ToolbarButtonColorScope>('all');
  const [kind, setKind] = useState<ToolbarButtonKind>('button');
  const [buttonState, setButtonState] = useState<ToolbarButtonState>('default');
  const [resolvedColors, setResolvedColors] = useState<Record<ToolbarButtonColorRole, string>>({
    fg: '#27303f',
    bg: '#ffffff',
    border: 'rgba(15, 23, 42, 0.18)',
  });

  const darkMode = themeMode === 'dark';
  const selectedTarget: ToolbarButtonColorTarget = scope === 'result' ? 'result' : 'query';
  const currentTokens = useMemo(() => Object.fromEntries(
    COLOR_ROLES.map((role) => [
      role,
      getToolbarButtonColorToken(kind, buttonState, role),
    ]),
  ) as Record<ToolbarButtonColorRole, ToolbarButtonColorToken>, [buttonState, kind]);

  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      setResolvedColors(Object.fromEntries(COLOR_ROLES.map((role) => {
        const token = currentTokens[role];
        const explicit = selectedOverrideValue(overrides, scope, token);
        return [
          role,
          explicit || resolveComputedColor(
            selectedTarget,
            token,
            resolveToolbarButtonFallbackColor(kind, buttonState, role, darkMode),
          ),
        ];
      })) as Record<ToolbarButtonColorRole, string>);
    };
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      frame = window.requestAnimationFrame(update);
    } else {
      update();
    }
    return () => {
      if (frame && typeof window !== 'undefined') window.cancelAnimationFrame(frame);
    };
  }, [activeCustomThemeRevision, buttonState, currentTokens, darkMode, kind, overrides, scope, selectedTarget]);

  const setColor = (role: ToolbarButtonColorRole, color: string | null) => {
    setAppearance({
      toolbarButtonColorOverrides: applyToolbarButtonColorOverride(
        overrides,
        scope,
        currentTokens[role],
        color,
      ),
    });
  };

  const resetCurrent = () => {
    setAppearance({
      toolbarButtonColorOverrides: clearSelectionOverrides(
        overrides,
        scope,
        kind,
        buttonState,
      ),
    });
  };

  const resetAll = () => {
    setAppearance({
      toolbarButtonColorOverrides: clearToolbarButtonColorOverrides(overrides, 'all'),
    });
  };

  const overrideCount = TOOLBAR_BUTTON_COLOR_TARGETS.reduce(
    (count, target) => count + Object.keys(overrides[target] ?? {}).length,
    0,
  );

  return (
    <div className="gn-toolbar-button-settings" data-toolbar-appearance-settings="true">
      <div className="gn-toolbar-button-settings-selectors">
        <div className="gn-toolbar-button-settings-selector">
          <span>{t('app.theme.toolbar_buttons.scope.label')}</span>
          <Segmented
            aria-label={t('app.theme.toolbar_buttons.scope.label')}
            block
            size="small"
            value={scope}
            options={[
              { value: 'all', label: t('app.theme.toolbar_buttons.scope.all') },
              { value: 'query', label: t('app.theme.toolbar_buttons.scope.query') },
              { value: 'result', label: t('app.theme.toolbar_buttons.scope.result') },
            ]}
            onChange={(value) => setScope(value as ToolbarButtonColorScope)}
          />
        </div>
        <div className="gn-toolbar-button-settings-selector">
          <span>{t('app.theme.toolbar_buttons.kind.label')}</span>
          <Segmented
            aria-label={t('app.theme.toolbar_buttons.kind.label')}
            block
            size="small"
            value={kind}
            options={[
              { value: 'button', label: t('app.theme.toolbar_buttons.kind.button') },
              { value: 'primary', label: t('app.theme.toolbar_buttons.kind.primary') },
            ]}
            onChange={(value) => setKind(value as ToolbarButtonKind)}
          />
        </div>
        <div className="gn-toolbar-button-settings-selector">
          <span>{t('app.theme.toolbar_buttons.state.label')}</span>
          <Segmented
            aria-label={t('app.theme.toolbar_buttons.state.label')}
            block
            size="small"
            value={buttonState}
            options={[
              { value: 'default', label: t('app.theme.toolbar_buttons.state.default') },
              { value: 'hover', label: t('app.theme.toolbar_buttons.state.hover') },
              { value: 'active', label: t('app.theme.toolbar_buttons.state.active') },
              { value: 'disabled', label: t('app.theme.toolbar_buttons.state.disabled') },
            ]}
            onChange={(value) => setButtonState(value as ToolbarButtonState)}
          />
        </div>
      </div>

      <div className="gn-toolbar-button-settings-preview">
        <div>
          <div className="gn-toolbar-button-settings-preview-title">
            {t('app.theme.toolbar_buttons.preview')}
          </div>
          <div className="gn-toolbar-button-settings-preview-hint">
            {t('app.theme.toolbar_buttons.preview.hint')}
          </div>
        </div>
        <span
          aria-disabled={buttonState === 'disabled'}
          className="gn-toolbar-button-settings-preview-button"
          style={{
            color: resolvedColors.fg,
            background: resolvedColors.bg,
            borderColor: resolvedColors.border,
          }}
        >
          <span aria-hidden>▣</span>
          {kind === 'primary'
            ? t('app.theme.toolbar_buttons.kind.primary')
            : t('app.theme.toolbar_buttons.kind.button')}
        </span>
      </div>

      <div className="gn-toolbar-button-settings-colors">
        {COLOR_ROLES.map((role) => {
          const token = currentTokens[role];
          const status = resolveToolbarButtonOverrideStatus(overrides, scope, token);
          const colorText = formatToolbarButtonColorText(resolvedColors[role]);
          const colorLabel = t(`app.theme.toolbar_buttons.token.${role}`);
          const resetColorLabel = t('app.theme.toolbar_buttons.reset_color');
          return (
            <div className="gn-toolbar-button-settings-color" key={role}>
              <div className="gn-toolbar-button-settings-color-copy">
                <span>{colorLabel}</span>
                <small data-color-status={status}>
                  {t(`app.theme.toolbar_buttons.value.${status === 'theme' ? 'follow_theme' : status}`)}
                </small>
              </div>
              <div className="gn-toolbar-button-settings-color-controls">
                <ColorPicker
                  allowClear={false}
                  format="rgb"
                  value={resolvedColors[role]}
                  onChange={(color) => setColor(role, color.toRgbString())}
                >
                  <button
                    type="button"
                    className="gn-toolbar-button-settings-picker-trigger"
                    aria-label={`${colorLabel}: ${colorText}`}
                    title={`${colorLabel}: ${colorText}`}
                  >
                    <span
                      aria-hidden
                      className="gn-toolbar-button-settings-picker-swatch"
                      style={{ background: resolvedColors[role] }}
                    />
                    <span className="gn-toolbar-button-settings-picker-value">{colorText}</span>
                  </button>
                </ColorPicker>
                <Button
                  aria-label={`${colorLabel}: ${resetColorLabel}`}
                  className="gn-toolbar-button-settings-color-reset"
                  data-toolbar-color-reset={role}
                  disabled={!canResetToolbarButtonColor(status)}
                  htmlType="button"
                  size="small"
                  title={`${colorLabel}: ${resetColorLabel}`}
                  onClick={() => setColor(role, null)}
                >
                  {resetColorLabel}
                </Button>
              </div>
            </div>
          );
        })}
      </div>

      <div className="gn-toolbar-button-settings-footer">
        <span>{t('app.theme.toolbar_buttons.precedence_hint')}</span>
        <div className="gn-toolbar-button-settings-actions">
          <Button
            size="small"
            disabled={!hasOverridesForSelection(overrides, scope, kind, buttonState)}
            onClick={resetCurrent}
          >
            {t('app.theme.toolbar_buttons.reset_current')}
          </Button>
          <Button size="small" disabled={overrideCount === 0} onClick={resetAll}>
            {t('app.theme.toolbar_buttons.reset_all')}
          </Button>
        </div>
      </div>
    </div>
  );
}
