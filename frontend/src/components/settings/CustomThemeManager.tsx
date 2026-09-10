import {
  CheckOutlined,
  CloseOutlined,
  DeleteOutlined,
  DownloadOutlined,
  EditOutlined,
  FileSyncOutlined,
  SaveOutlined,
  StopOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import { Button, Empty, Input, Popconfirm, Select, Tag, Tooltip, message } from 'antd';
import type { ChangeEvent, CSSProperties, FormEvent } from 'react';
import { useId, useMemo, useRef, useState } from 'react';
import { useCustomThemeStore, type CustomThemeStoreResult } from '../../customThemeStore';
import { useI18n } from '../../i18n/provider';
import { isMacLikePlatform } from '../../utils/appearance';
import {
  CUSTOM_THEME_MAX_BYTES,
  CUSTOM_THEME_MAX_COUNT,
  CUSTOM_THEME_TEMPLATE,
  deriveCustomThemeName,
  extractCustomThemeAntTokens,
  type CustomThemeBaseMode,
  type CustomThemeDefinition,
} from '../../utils/customTheme';
import {
  BUILTIN_CUSTOM_THEME_PRESETS,
  resolveAvailableCustomTheme,
  resolveBuiltinCustomThemePreset,
} from '../../utils/customThemePresets';
import { useStore } from '../../store';
import './CustomThemeManager.css';

type FileAction =
  | { kind: 'import' }
  | { kind: 'replace'; themeId: string };

const STORE_ERROR_I18N_KEYS: Record<string, string> = {
  empty: 'app.theme.custom.error.empty',
  'too-large': 'app.theme.custom.error.too_large',
  'invalid-syntax': 'app.theme.custom.error.invalid_syntax',
  'unsafe-import': 'app.theme.custom.error.unsafe_import',
  'unsafe-url': 'app.theme.custom.error.unsafe_url',
  'unsafe-font-face': 'app.theme.custom.error.unsafe_font_face',
  'unsafe-legacy-script': 'app.theme.custom.error.unsafe_script',
  'max-count': 'app.theme.custom.error.max_count',
  'max-total-size': 'app.theme.custom.error.max_total_size',
  'not-found': 'app.theme.custom.error.not_found',
  'storage-failed': 'app.theme.custom.error.storage_failed',
};

const readFileAsText = async (file: File): Promise<string> => {
  if (typeof file.text === 'function') return file.text();
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error('Failed to read file'));
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.readAsText(file, 'utf-8');
  });
};

const triggerTextDownload = (fileName: string, content: string): boolean => {
  if (
    typeof document === 'undefined'
    || typeof URL === 'undefined'
    || typeof URL.createObjectURL !== 'function'
  ) {
    return false;
  }
  const blob = new Blob([content], { type: 'text/css;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
  return true;
};

const resolveThemeAccent = (theme: CustomThemeDefinition): string => (
  extractCustomThemeAntTokens(theme.css).primary || '#16a34a'
);

export default function CustomThemeManager() {
  const { language, t } = useI18n();
  const builtinThemeTitleId = useId();
  const themes = useCustomThemeStore((state) => state.themes);
  const activeThemeId = useCustomThemeStore((state) => state.activeThemeId);
  const importCustomTheme = useCustomThemeStore((state) => state.importCustomTheme);
  const updateCustomTheme = useCustomThemeStore((state) => state.updateCustomTheme);
  const selectCustomTheme = useCustomThemeStore((state) => state.selectCustomTheme);
  const removeCustomTheme = useCustomThemeStore((state) => state.removeCustomTheme);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const fileActionRef = useRef<FileAction>({ kind: 'import' });
  const [fileBusy, setFileBusy] = useState(false);
  const [editingThemeId, setEditingThemeId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');
  const activeTheme = useMemo(
    () => resolveAvailableCustomTheme(themes, activeThemeId),
    [activeThemeId, themes],
  );
  const activePreset = useMemo(
    () => {
      const preset = resolveBuiltinCustomThemePreset(activeThemeId);
      return preset === activeTheme ? preset : null;
    },
    [activeTheme, activeThemeId],
  );
  const activeThemeDisplayName = activePreset
    ? t(activePreset.nameKey)
    : activeTheme?.name ?? '';
  const themeMode = useStore((state) => state.theme);
  const visibleBuiltinPresets = useMemo(
    () => BUILTIN_CUSTOM_THEME_PRESETS.filter((preset) => preset.baseMode === themeMode),
    [themeMode],
  );
  const numberFormatter = useMemo(() => new Intl.NumberFormat(language), [language]);
  const recoveryShortcut = useMemo(
    () => isMacLikePlatform() ? 'Cmd+Shift+D' : 'Ctrl+Shift+D',
    [],
  );

  const showStoreError = (result: CustomThemeStoreResult) => {
    if (result.ok) return;
    const key = STORE_ERROR_I18N_KEYS[result.reason] || 'app.theme.custom.error.operation_failed';
    message.error(t(key, {
      count: CUSTOM_THEME_MAX_COUNT,
      size: Math.round(CUSTOM_THEME_MAX_BYTES / 1024),
    }));
  };

  const requestFile = (action: FileAction) => {
    if (fileBusy) return;
    fileActionRef.current = action;
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
      fileInputRef.current.click();
    }
  };

  const handleFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.css')) {
      message.error(t('app.theme.custom.error.invalid_extension'));
      return;
    }
    if (file.size > CUSTOM_THEME_MAX_BYTES) {
      message.error(t('app.theme.custom.error.too_large', {
        size: Math.round(CUSTOM_THEME_MAX_BYTES / 1024),
      }));
      return;
    }

    setFileBusy(true);
    try {
      const css = await readFileAsText(file);
      const action = fileActionRef.current;
      if (action.kind === 'replace') {
        const result = updateCustomTheme(action.themeId, {
          css,
          sourceFileName: file.name,
        });
        if (!result.ok) {
          showStoreError(result);
          return;
        }
        message.success(t('app.theme.custom.message.css_replaced'));
        return;
      }
      const result = importCustomTheme({
        name: deriveCustomThemeName(file.name),
        sourceFileName: file.name,
        baseMode: 'system',
        css,
      });
      if (!result.ok) {
        showStoreError(result);
        return;
      }
      message.success(t('app.theme.custom.message.imported', { name: result.theme?.name || file.name }));
    } catch {
      message.error(t('app.theme.custom.error.read_failed'));
    } finally {
      setFileBusy(false);
    }
  };

  const handleSelect = (theme: CustomThemeDefinition, displayName = theme.name) => {
    const result = selectCustomTheme(theme.id);
    if (!result.ok) {
      showStoreError(result);
      return;
    }
    message.success(t('app.theme.custom.message.selected', { name: displayName }));
  };

  const handleDeactivate = () => {
    const result = selectCustomTheme(null);
    if (!result.ok) {
      showStoreError(result);
      return;
    }
    message.success(t('app.theme.custom.message.deactivated'));
  };

  const handleBaseModeChange = (theme: CustomThemeDefinition, baseMode: CustomThemeBaseMode) => {
    const result = updateCustomTheme(theme.id, { baseMode });
    if (!result.ok) showStoreError(result);
  };

  const beginRename = (theme: CustomThemeDefinition) => {
    setEditingThemeId(theme.id);
    setDraftName(theme.name);
  };

  const cancelRename = () => {
    setEditingThemeId(null);
    setDraftName('');
  };

  const submitRename = (event: FormEvent, theme: CustomThemeDefinition) => {
    event.preventDefault();
    const nextName = draftName.trim();
    if (!nextName) {
      message.error(t('app.theme.custom.error.name_required'));
      return;
    }
    const result = updateCustomTheme(theme.id, { name: nextName });
    if (!result.ok) {
      showStoreError(result);
      return;
    }
    cancelRename();
    message.success(t('app.theme.custom.message.renamed'));
  };

  const handleRemove = (theme: CustomThemeDefinition) => {
    const result = removeCustomTheme(theme.id);
    if (!result.ok) {
      showStoreError(result);
      return;
    }
    if (editingThemeId === theme.id) cancelRename();
    message.success(t('app.theme.custom.message.deleted', { name: theme.name }));
  };

  const handleDownloadTemplate = () => {
    if (!triggerTextDownload('gonavi-custom-theme-template.css', CUSTOM_THEME_TEMPLATE)) {
      message.error(t('app.theme.custom.error.download_failed'));
    }
  };

  return (
    <div className="gonavi-custom-theme-manager">
      <input
        ref={fileInputRef}
        type="file"
        accept=".css,text/css"
        tabIndex={-1}
        aria-hidden="true"
        className="gonavi-custom-theme-file-input"
        onChange={(event) => { void handleFileChange(event); }}
      />

      <fieldset className="gonavi-custom-theme-library">
        <legend className="gonavi-custom-theme-sr-only">
          {t('app.theme.custom.list_label')}
        </legend>

        <section className="gonavi-custom-theme-preset-section" aria-labelledby={builtinThemeTitleId}>
          <div className="gonavi-custom-theme-section-heading">
            <div>
              <strong id={builtinThemeTitleId}>{t('app.theme.custom.preset.title')}</strong>
              <span>{t('app.theme.custom.preset.description')}</span>
            </div>
            <Tag>{t('app.theme.custom.preset.count', { count: visibleBuiltinPresets.length })}</Tag>
          </div>
          <div className="gonavi-custom-theme-preset-grid">
            {visibleBuiltinPresets.map((preset) => {
              const displayName = t(preset.nameKey);
              const active = preset === activePreset;
              const descriptionId = `${builtinThemeTitleId}-${preset.id}-description`;
              const modeId = `${builtinThemeTitleId}-${preset.id}-mode`;
              const previewStyle = {
                '--gonavi-preset-app': preset.preview.app,
                '--gonavi-preset-chrome': preset.preview.chrome,
                '--gonavi-preset-panel': preset.preview.panel,
                '--gonavi-preset-text': preset.preview.text,
                '--gonavi-preset-muted': preset.preview.muted,
                '--gonavi-preset-accent': preset.preview.accent,
              } as CSSProperties;
              return (
                <label
                  key={preset.id}
                  className={`gonavi-custom-theme-preset-option${active ? ' is-active' : ''}`}
                  style={previewStyle}
                >
                  <input
                    type="radio"
                    name="gonavi-custom-theme-selection"
                    value={preset.id}
                    checked={active}
                    aria-label={t('app.theme.custom.action.use_named', { name: displayName })}
                    aria-describedby={`${descriptionId} ${modeId}`}
                    className="gonavi-custom-theme-radio"
                    onChange={() => handleSelect(preset, displayName)}
                  />
                  <span className="gonavi-custom-theme-preset-preview" aria-hidden="true">
                    <span className="gonavi-custom-theme-preset-preview-chrome" />
                    <span className="gonavi-custom-theme-preset-preview-sidebar" />
                    <span className="gonavi-custom-theme-preset-preview-content">
                      <i />
                      <i />
                      <i />
                    </span>
                  </span>
                  <span className="gonavi-custom-theme-preset-copy">
                    <span className="gonavi-custom-theme-preset-name-row">
                      <strong>{displayName}</strong>
                      {preset.badgeKey ? (
                        <Tag className="gonavi-custom-theme-preset-badge is-recommended">
                          {t(preset.badgeKey)}
                        </Tag>
                      ) : null}
                      {active ? (
                        <Tag
                          className="gonavi-custom-theme-preset-badge is-active"
                          icon={<CheckOutlined aria-hidden="true" />}
                        >
                          {t('app.theme.custom.badge.active')}
                        </Tag>
                      ) : null}
                    </span>
                    <span id={descriptionId} className="gonavi-custom-theme-preset-description">
                      {t(preset.descriptionKey)}
                    </span>
                    <span id={modeId} className="gonavi-custom-theme-preset-mode">
                      {t(`app.theme.mode.${preset.baseMode}.label`)}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
        </section>

      <div className="gonavi-custom-theme-toolbar">
        <div className="gonavi-custom-theme-intro">
          <strong className="gonavi-custom-theme-my-title">
            {t('app.theme.custom.my_themes_title')}
          </strong>
          <div className="gonavi-custom-theme-description">
            {t('app.theme.custom.description')}
          </div>
          <div className="gonavi-custom-theme-count">
            {t('app.theme.custom.count', {
              count: numberFormatter.format(themes.length),
              max: numberFormatter.format(CUSTOM_THEME_MAX_COUNT),
            })}
          </div>
        </div>
        <div className="gonavi-custom-theme-toolbar-actions">
          <Button
            icon={<DownloadOutlined aria-hidden="true" />}
            onClick={handleDownloadTemplate}
          >
            {t('app.theme.custom.action.download_template')}
          </Button>
          <Tooltip
            title={themes.length >= CUSTOM_THEME_MAX_COUNT ? t('app.theme.custom.error.max_count', { count: CUSTOM_THEME_MAX_COUNT }) : undefined}
          >
            <Button
              type="primary"
              icon={<UploadOutlined aria-hidden="true" />}
              loading={fileBusy}
              disabled={themes.length >= CUSTOM_THEME_MAX_COUNT}
              onClick={() => requestFile({ kind: 'import' })}
            >
              {t('app.theme.custom.action.upload')}
            </Button>
          </Tooltip>
        </div>
      </div>

      <div className="gonavi-custom-theme-safety-note" role="note">
        {t('app.theme.custom.safety_hint', { shortcut: recoveryShortcut })}
      </div>

      <div className="gonavi-custom-theme-active" role="status" aria-live="polite">
        <span className="gonavi-custom-theme-active-icon" aria-hidden="true">
          {activeTheme ? <CheckOutlined /> : <StopOutlined />}
        </span>
        <span className="gonavi-custom-theme-active-copy">
          <strong>
            {activeTheme
              ? t('app.theme.custom.active_theme', { name: activeThemeDisplayName })
              : t('app.theme.custom.inactive')}
          </strong>
          <span>
            {activeTheme
              ? t('app.theme.custom.active_hint')
              : t('app.theme.custom.inactive_hint')}
          </span>
        </span>
        {activeTheme ? (
          <Button icon={<StopOutlined aria-hidden="true" />} onClick={handleDeactivate}>
            {t('app.theme.custom.action.deactivate')}
          </Button>
        ) : null}
      </div>

      {themes.length === 0 ? (
        <div className="gonavi-custom-theme-empty">
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={t('app.theme.custom.empty')}
          >
            <Button
              type="primary"
              icon={<UploadOutlined aria-hidden="true" />}
              loading={fileBusy}
              onClick={() => requestFile({ kind: 'import' })}
            >
              {t('app.theme.custom.action.upload_first')}
            </Button>
          </Empty>
        </div>
      ) : (
        <div
          className="gonavi-custom-theme-grid"
        >
          {themes.map((theme) => {
            const active = theme === activeTheme;
            const editing = theme.id === editingThemeId;
            const accent = resolveThemeAccent(theme);
            const previewStyle = { '--gonavi-custom-theme-preview-accent': accent } as CSSProperties;
            return (
              <article
                key={theme.id}
                className={`gonavi-custom-theme-card${active ? ' is-active' : ''}`}
                style={previewStyle}
              >
                <label className="gonavi-custom-theme-select">
                  <input
                    type="radio"
                    name="gonavi-custom-theme-selection"
                    value={theme.id}
                    checked={active}
                    aria-label={t('app.theme.custom.action.use_named', { name: theme.name })}
                    className="gonavi-custom-theme-radio"
                    onChange={() => handleSelect(theme)}
                  />
                  <span className="gonavi-custom-theme-preview" aria-hidden="true">
                    <span />
                    <span />
                    <span />
                  </span>
                  <span className="gonavi-custom-theme-card-heading">
                    <span className="gonavi-custom-theme-name" title={theme.name}>{theme.name}</span>
                    {active ? (
                      <Tag color="success" icon={<CheckOutlined aria-hidden="true" />}>
                        {t('app.theme.custom.badge.active')}
                      </Tag>
                    ) : null}
                  </span>
                  <span className="gonavi-custom-theme-file-name" title={theme.sourceFileName}>
                    {theme.sourceFileName || t('app.theme.custom.unknown_file')}
                  </span>
                </label>

                {editing ? (
                  <form className="gonavi-custom-theme-rename" onSubmit={(event) => submitRename(event, theme)}>
                    <Input
                      value={draftName}
                      maxLength={80}
                      name={`custom-theme-name-${theme.id}`}
                      autoComplete="off"
                      aria-label={t('app.theme.custom.rename_input_label', { name: theme.name })}
                      onChange={(event) => setDraftName(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Escape') {
                          event.preventDefault();
                          event.stopPropagation();
                          cancelRename();
                        }
                      }}
                    />
                    <Tooltip title={t('common.save')}>
                      <Button
                        htmlType="submit"
                        type="primary"
                        size="small"
                        icon={<SaveOutlined aria-hidden="true" />}
                        aria-label={t('common.save')}
                      />
                    </Tooltip>
                    <Tooltip title={t('common.cancel')}>
                      <Button
                        htmlType="button"
                        size="small"
                        icon={<CloseOutlined aria-hidden="true" />}
                        aria-label={t('common.cancel')}
                        onClick={cancelRename}
                      />
                    </Tooltip>
                  </form>
                ) : (
                  <div className="gonavi-custom-theme-card-controls">
                    <label className="gonavi-custom-theme-base-mode-label" htmlFor={`custom-theme-base-mode-${theme.id}`}>
                      {t('app.theme.custom.base_mode')}
                    </label>
                    <Select<CustomThemeBaseMode>
                      id={`custom-theme-base-mode-${theme.id}`}
                      value={theme.baseMode}
                      className="gonavi-custom-theme-base-mode"
                      aria-label={t('app.theme.custom.base_mode_for', { name: theme.name })}
                      options={[
                        { value: 'system', label: t('app.theme.mode.system.label') },
                        { value: 'light', label: t('app.theme.mode.light.label') },
                        { value: 'dark', label: t('app.theme.mode.dark.label') },
                      ]}
                      onChange={(value) => handleBaseModeChange(theme, value)}
                    />
                  </div>
                )}

                <div className="gonavi-custom-theme-card-actions">
                  <Tooltip title={t('app.theme.custom.action.rename')}>
                    <Button
                      type="text"
                      size="small"
                      icon={<EditOutlined aria-hidden="true" />}
                      aria-label={t('app.theme.custom.action.rename_named', { name: theme.name })}
                      disabled={editing}
                      onClick={() => beginRename(theme)}
                    />
                  </Tooltip>
                  <Tooltip title={t('app.theme.custom.action.replace_css')}>
                    <Button
                      type="text"
                      size="small"
                      icon={<FileSyncOutlined aria-hidden="true" />}
                      aria-label={t('app.theme.custom.action.replace_named', { name: theme.name })}
                      loading={fileBusy && fileActionRef.current.kind === 'replace' && fileActionRef.current.themeId === theme.id}
                      disabled={fileBusy}
                      onClick={() => requestFile({ kind: 'replace', themeId: theme.id })}
                    />
                  </Tooltip>
                  <Popconfirm
                    title={t('app.theme.custom.delete_confirm.title')}
                    description={t('app.theme.custom.delete_confirm.description', { name: theme.name })}
                    okText={t('common.delete')}
                    cancelText={t('common.cancel')}
                    okButtonProps={{ danger: true }}
                    onConfirm={() => handleRemove(theme)}
                  >
                    <Tooltip title={t('common.delete')}>
                      <Button
                        type="text"
                        size="small"
                        danger
                        icon={<DeleteOutlined aria-hidden="true" />}
                        aria-label={t('app.theme.custom.action.delete_named', { name: theme.name })}
                      />
                    </Tooltip>
                  </Popconfirm>
                </div>
              </article>
            );
          })}
        </div>
      )}
      </fieldset>
    </div>
  );
}
