import React, { useCallback } from 'react';
import { Switch, Button, Segmented, Input, InputNumber, Alert, Select } from 'antd';
import { InfoCircleOutlined } from '@ant-design/icons';
import { DndContext, closestCenter } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { GlobalProxyConfig } from '../../types';
import { getGlobalProxyDefaultPort } from '../globalProxySettings';
import DownloadSourceSelect from '../../components/DownloadSourceSelect';
import { SidebarMetadataSortableRow } from '../SidebarMetadataSortableRow';
import {
  DEFAULT_SIDEBAR_TABLE_METADATA_FIELDS,
  SIDEBAR_TABLE_METADATA_FIELDS,
} from '../../utils/sidebarTableMetadata';
import {
  type SidebarObjectGroupKey,
  SIDEBAR_OBJECT_GROUP_KEYS,
} from '../../utils/sidebarObjectVisibility';
import { buildSidebarObjectVisibilitySettings } from '../../utils/sidebarObjectVisibilitySettings';
import type { AppCoreStateApi } from './useAppCoreState';
import type { AppShellStateApi } from './useAppShellState';
import type { AppProxySettingsApi } from './useAppProxySettings';
import type { AppSecurityUpdateApi } from './useAppSecurityUpdate';
import type { AppBootstrapEffectsApi } from './useAppBootstrapEffects';
import type { AppAntdThemeApi } from './useAppAntdTheme';
import type { AppUpdateAndDiagnosticsApi } from './useAppUpdateAndDiagnostics';

export interface UseAppSettingsPanesRenderInput {
  darkMode: AppCoreStateApi['darkMode'];
  viewportWidth: AppShellStateApi['viewportWidth'];
  proxyDraft: AppProxySettingsApi['proxyDraft'];
  setProxyDraft: AppProxySettingsApi['setProxyDraft'];
  proxyDraftValid: AppProxySettingsApi['proxyDraftValid'];
  proxyTestResult: AppProxySettingsApi['proxyTestResult'];
  t: AppCoreStateApi['t'];
  overlayTheme: AppSecurityUpdateApi['overlayTheme'];
  utilityMutedTextStyle: AppSecurityUpdateApi['utilityMutedTextStyle'];
  utilityPanelStyle: AppSecurityUpdateApi['utilityPanelStyle'];
  proxyStatusDescription: AppProxySettingsApi['proxyStatusDescription'];
  proxyStatusTitle: AppProxySettingsApi['proxyStatusTitle'];
  proxyDraftDirty: AppProxySettingsApi['proxyDraftDirty'];
  proxyPresetItems: AppProxySettingsApi['proxyPresetItems'];
  applyProxyPreset: AppProxySettingsApi['applyProxyPreset'];
  updateProxyDraftType: AppProxySettingsApi['updateProxyDraftType'];
  proxyDraftHost: AppProxySettingsApi['proxyDraftHost'];
  proxyDraftPortValid: AppProxySettingsApi['proxyDraftPortValid'];
  setProxyDraftClearPassword: AppProxySettingsApi['setProxyDraftClearPassword'];
  proxyDraftClearPassword: AppProxySettingsApi['proxyDraftClearPassword'];
  proxyTestPresetItems: AppProxySettingsApi['proxyTestPresetItems'];
  proxyTestUrlTrimmed: AppProxySettingsApi['proxyTestUrlTrimmed'];
  setProxyTestUrl: AppProxySettingsApi['setProxyTestUrl'];
  proxyTestUrl: AppProxySettingsApi['proxyTestUrl'];
  proxyCanTest: AppProxySettingsApi['proxyCanTest'];
  handleTestGlobalProxyDraft: AppProxySettingsApi['handleTestGlobalProxyDraft'];
  proxyTesting: AppProxySettingsApi['proxyTesting'];
  resetProxyDraftToCurrent: AppProxySettingsApi['resetProxyDraftToCurrent'];
  proxyApplying: AppProxySettingsApi['proxyApplying'];
  handleApplyGlobalProxyDraft: AppProxySettingsApi['handleApplyGlobalProxyDraft'];
  downloadSource: AppShellStateApi['downloadSource'];
  downloadSourceSaving: AppShellStateApi['downloadSourceSaving'];
  handleDownloadSourceChange: AppBootstrapEffectsApi['handleDownloadSourceChange'];
  sidebarMetadataDragSensors: AppCoreStateApi['sidebarMetadataDragSensors'];
  handleSidebarMetadataDragEnd: AppAntdThemeApi['handleSidebarMetadataDragEnd'];
  sidebarMetadataFieldItems: AppAntdThemeApi['sidebarMetadataFieldItems'];
  sidebarTableMetadataFields: AppCoreStateApi['sidebarTableMetadataFields'];
  toggleSidebarMetadataFieldFromSettings: AppAntdThemeApi['toggleSidebarMetadataFieldFromSettings'];
  setQueryOptions: AppCoreStateApi['setQueryOptions'];
  appearance: AppCoreStateApi['appearance'];
  setAppearance: AppCoreStateApi['setAppearance'];
  updateInstallAction: AppUpdateAndDiagnosticsApi['updateInstallAction'];
  lastUpdateInfo: AppUpdateAndDiagnosticsApi['lastUpdateInfo'];
}

export const useAppSettingsPanesRender = ({
  darkMode, viewportWidth, proxyDraft, setProxyDraft, proxyDraftValid, proxyTestResult, t,
  overlayTheme, utilityMutedTextStyle, utilityPanelStyle, proxyStatusDescription, proxyStatusTitle,
  proxyDraftDirty, proxyPresetItems, applyProxyPreset, updateProxyDraftType, proxyDraftHost,
  proxyDraftPortValid, setProxyDraftClearPassword, proxyDraftClearPassword, proxyTestPresetItems,
  proxyTestUrlTrimmed, setProxyTestUrl, proxyTestUrl, proxyCanTest, handleTestGlobalProxyDraft,
  proxyTesting, resetProxyDraftToCurrent, proxyApplying, handleApplyGlobalProxyDraft,
  downloadSource, downloadSourceSaving, handleDownloadSourceChange, sidebarMetadataDragSensors,
  handleSidebarMetadataDragEnd, sidebarMetadataFieldItems, sidebarTableMetadataFields,
  toggleSidebarMetadataFieldFromSettings, setQueryOptions, appearance, setAppearance,
  updateInstallAction, lastUpdateInfo,
}: UseAppSettingsPanesRenderInput) => {
  const renderProxySettingsContent = useCallback(() => {
      const fieldLabelStyle: React.CSSProperties = {
          marginBottom: 4,
          fontSize: 12,
          color: darkMode ? 'rgba(255,255,255,0.55)' : 'rgba(16,24,40,0.58)',
      };
      const narrow = viewportWidth < 760;
      const proxyStatusColor = proxyDraft.enabled
          ? (proxyDraftValid ? (darkMode ? '#4ade80' : '#16a34a') : (darkMode ? '#fbbf24' : '#d97706'))
          : (darkMode ? 'rgba(148,163,184,0.85)' : 'rgba(71,85,105,0.72)');
      const proxyTestAlertType = proxyTestResult
          ? (!proxyTestResult.success ? 'error' : ((proxyTestResult.statusCode || 0) >= 400 ? 'warning' : 'success'))
          : 'info';

      return (
          <div className="gonavi-proxy-settings" style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '8px 0 4px', minHeight: 0 }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 12,
                  flexWrap: 'wrap',
                  padding: '10px 12px',
                  borderRadius: 10,
                  border: `1px solid ${darkMode ? 'rgba(148,163,184,0.18)' : 'rgba(15,23,42,0.08)'}`,
                  background: darkMode ? 'rgba(15,23,42,0.35)' : 'rgba(248,250,252,0.9)',
                }}
              >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, flexWrap: 'wrap' }}>
                      <Switch
                          aria-label={t('app.proxy.section_title')}
                          checked={proxyDraft.enabled}
                          onChange={(checked) => setProxyDraft((current) => ({ ...current, enabled: checked }))}
                      />
                      <span style={{ fontSize: 13, fontWeight: 600, color: overlayTheme.titleText }}>
                          {t(proxyDraft.enabled ? 'app.proxy.switch.enabled' : 'app.proxy.switch.disabled')}
                      </span>
                      <span
                        title={proxyStatusDescription}
                        style={{
                          fontSize: 12,
                          fontWeight: 500,
                          color: proxyStatusColor,
                          padding: '2px 8px',
                          borderRadius: 999,
                          border: `1px solid ${proxyStatusColor}33`,
                          background: `${proxyStatusColor}14`,
                          whiteSpace: 'nowrap',
                        }}
                      >
                          {proxyStatusTitle}
                      </span>
                      {proxyDraftDirty ? (
                          <span style={{ ...utilityMutedTextStyle, fontSize: 12 }}>{t('app.proxy.unsaved_hint')}</span>
                      ) : null}
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      {proxyPresetItems.map((preset) => (
                          <Button key={preset.key} size="small" onClick={() => applyProxyPreset(preset)}>
                              {preset.label}
                          </Button>
                      ))}
                  </div>
              </div>

              <div style={{ ...utilityPanelStyle, display: 'flex', flexDirection: 'column', gap: 14 }}>
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: narrow ? '1fr' : 'minmax(160px, 0.9fr) minmax(180px, 1.6fr) 110px',
                      gap: 10,
                      alignItems: 'end',
                    }}
                  >
                      <div>
                          <div style={fieldLabelStyle}>{t('app.proxy.type')}</div>
                          <Segmented
                              block
                              value={proxyDraft.type}
                              options={[
                                  { label: t('app.proxy.type_socks5'), value: 'socks5' },
                                  { label: t('app.proxy.type_http'), value: 'http' },
                              ]}
                              onChange={(value) => updateProxyDraftType(value as GlobalProxyConfig['type'])}
                          />
                      </div>
                      <div>
                          <div style={fieldLabelStyle}>{t('app.proxy.host')}</div>
                          <Input
                              placeholder={t('app.proxy.host_placeholder')}
                              status={proxyDraft.enabled && proxyDraftHost === '' ? 'error' : undefined}
                              value={proxyDraft.host}
                              onChange={(e) => setProxyDraft((current) => ({ ...current, host: e.target.value }))}
                          />
                      </div>
                      <div>
                          <div style={fieldLabelStyle}>{t('app.proxy.port')}</div>
                          <InputNumber
                              min={1}
                              max={65535}
                              status={proxyDraft.enabled && !proxyDraftPortValid ? 'error' : undefined}
                              style={{ width: '100%' }}
                              value={proxyDraft.port}
                              onChange={(value) => setProxyDraft((current) => ({
                                  ...current,
                                  port: typeof value === 'number' ? value : getGlobalProxyDefaultPort(current.type),
                              }))}
                          />
                      </div>
                  </div>

                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: narrow ? '1fr' : '1fr 1fr',
                      gap: 10,
                      alignItems: 'end',
                    }}
                  >
                      <div>
                          <div style={fieldLabelStyle}>{t('app.proxy.username_optional')}</div>
                          <Input
                              placeholder="proxy-user"
                              value={proxyDraft.user}
                              onChange={(e) => setProxyDraft((current) => ({ ...current, user: e.target.value }))}
                          />
                      </div>
                      <div>
                          <div style={fieldLabelStyle}>{t('app.proxy.password_optional')}</div>
                          <Input.Password
                              placeholder="proxy-password"
                              value={proxyDraft.password}
                              onChange={(e) => {
                                  const nextPassword = e.target.value;
                                  setProxyDraft((current) => ({
                                      ...current,
                                      password: nextPassword,
                                      hasPassword: nextPassword !== '' ? true : current.hasPassword,
                                  }));
                                  setProxyDraftClearPassword(false);
                              }}
                          />
                      </div>
                  </div>

                  {proxyDraftClearPassword ? (
                      <Alert showIcon type="warning" message={t('app.proxy.clear_saved_password_pending')} />
                  ) : proxyDraft.hasPassword && proxyDraft.password === '' ? (
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                          <span style={utilityMutedTextStyle}>{t('app.proxy.password_saved_hint')}</span>
                          <Button
                              size="small"
                              onClick={() => {
                                  setProxyDraft((current) => ({ ...current, password: '', hasPassword: false }));
                                  setProxyDraftClearPassword(true);
                              }}
                          >
                              {t('app.proxy.clear_saved_password')}
                          </Button>
                      </div>
                  ) : null}
              </div>

              <div style={{ ...utilityPanelStyle, display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: narrow ? '1fr' : 'minmax(140px, 0.9fr) minmax(200px, 1.6fr) auto',
                      gap: 10,
                      alignItems: 'end',
                    }}
                  >
                      <div>
                          <div style={fieldLabelStyle}>{t('app.proxy.test.target_label')}</div>
                          <Select
                              value={proxyTestPresetItems.some((item) => item.url === proxyTestUrlTrimmed) ? proxyTestUrlTrimmed : undefined}
                              placeholder={t('app.proxy.test.target_label')}
                              style={{ width: '100%' }}
                              allowClear
                              options={proxyTestPresetItems.map((item) => ({
                                  value: item.url,
                                  label: item.label,
                              }))}
                              onChange={(value) => {
                                  if (typeof value === 'string' && value) {
                                      setProxyTestUrl(value);
                                  }
                              }}
                          />
                      </div>
                      <div>
                          <div style={fieldLabelStyle}>{t('app.proxy.test.title')}</div>
                          <Input
                              value={proxyTestUrl}
                              placeholder={t('app.proxy.test.target_placeholder')}
                              onChange={(event) => setProxyTestUrl(event.target.value)}
                              onPressEnter={() => {
                                  if (proxyCanTest) {
                                      void handleTestGlobalProxyDraft();
                                  }
                              }}
                          />
                      </div>
                      <Button
                          type="primary"
                          loading={proxyTesting}
                          disabled={!proxyCanTest}
                          onClick={handleTestGlobalProxyDraft}
                          style={{ minWidth: 96 }}
                      >
                          {t('app.proxy.test.action')}
                      </Button>
                  </div>
                  {!proxyDraft.enabled ? (
                      <div style={utilityMutedTextStyle}>{t('app.proxy.test.disabled_hint')}</div>
                  ) : null}
                  {proxyTestResult ? (
                      <Alert
                          showIcon
                          type={proxyTestAlertType}
                          message={proxyTestResult.message}
                          description={[
                              proxyTestResult.statusCode ? t('app.proxy.test.result.status', { status: proxyTestResult.statusCode }) : '',
                              typeof proxyTestResult.durationMs === 'number' ? t('app.proxy.test.result.duration', { duration: proxyTestResult.durationMs }) : '',
                              proxyTestResult.finalUrl && proxyTestResult.finalUrl !== proxyTestResult.url ? t('app.proxy.test.result.final_url', { url: proxyTestResult.finalUrl }) : '',
                          ].filter(Boolean).join('  ')}
                      />
                  ) : null}
              </div>

              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', paddingTop: 2 }}>
                  <div style={{ ...utilityMutedTextStyle, flex: '1 1 240px', fontSize: 12 }}>{t('app.proxy.scope_hint')}</div>
                  <div style={{ display: 'flex', gap: 8 }}>
                      <Button onClick={resetProxyDraftToCurrent} disabled={!proxyDraftDirty || proxyApplying}>
                          {t('app.proxy.reset')}
                      </Button>
                      <Button
                          type="primary"
                          loading={proxyApplying}
                          disabled={!proxyDraftDirty && !proxyApplying}
                          onClick={handleApplyGlobalProxyDraft}
                      >
                          {t('app.proxy.apply')}
                      </Button>
                  </div>
              </div>
          </div>
      );

  }, [
      applyProxyPreset,
      darkMode,
      overlayTheme.titleText,
      handleApplyGlobalProxyDraft,
      proxyApplying,
      proxyCanTest,
      proxyDraft.enabled,
      proxyDraft.hasPassword,
      proxyDraft.host,
      proxyDraft.password,
      proxyDraft.port,
      proxyDraft.type,
      proxyDraft.user,
      proxyDraftClearPassword,
      proxyDraftDirty,
      proxyDraftHost,
      proxyDraftPortValid,
      proxyDraftValid,
      proxyTestPresetItems,
      proxyTestResult,
      proxyTesting,
      proxyTestUrl,
      proxyTestUrlTrimmed,
      proxyPresetItems,
      proxyStatusDescription,
      proxyStatusTitle,
      resetProxyDraftToCurrent,
      t,
      handleTestGlobalProxyDraft,
      updateProxyDraftType,
      utilityMutedTextStyle,
      utilityPanelStyle,
      viewportWidth,
  ]);
  const renderDownloadSourceSettingsContent = useCallback(() => {
      return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: '12px 0' }}>
              <div style={utilityPanelStyle}>
                  <div style={{ ...utilityMutedTextStyle, marginBottom: 14, lineHeight: 1.7 }}>
                      {t('app.download_source.description')}
                  </div>
                  <DownloadSourceSelect
                      value={downloadSource}
                      darkMode={darkMode}
                      saving={downloadSourceSaving}
                      onChange={(source) => void handleDownloadSourceChange(source)}
                      style={{ width: '100%', maxWidth: 360 }}
                  />
                  <div
                      style={{
                          marginTop: 14,
                          display: 'flex',
                          alignItems: 'flex-start',
                          gap: 8,
                          padding: '10px 12px',
                          borderRadius: 10,
                          background: darkMode ? 'rgba(255,255,255,0.04)' : 'rgba(22,119,255,0.06)',
                          color: overlayTheme.mutedText,
                          fontSize: 12,
                          lineHeight: 1.7,
                      }}
                  >
                      <InfoCircleOutlined style={{ color: overlayTheme.selectedText, marginTop: 2, flexShrink: 0 }} />
                      <span>{t('app.download_source.fallback_hint')}</span>
                  </div>
              </div>
          </div>
      );
  }, [
      darkMode,
      downloadSource,
      downloadSourceSaving,
      handleDownloadSourceChange,
      overlayTheme.mutedText,
      overlayTheme.selectedText,
      t,
      utilityMutedTextStyle,
      utilityPanelStyle,
  ]);
  const renderSidebarMetadataSettingsPane = useCallback(() => (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '12px 0' }}>
          <div style={utilityPanelStyle}>
              <DndContext
                  sensors={sidebarMetadataDragSensors}
                  collisionDetection={closestCenter}
                  onDragEnd={handleSidebarMetadataDragEnd}
              >
                  <SortableContext
                      items={sidebarMetadataFieldItems.map((item) => item.field)}
                      strategy={verticalListSortingStrategy}
                  >
                      <div style={{ display: 'grid', gap: 0, borderTop: `1px solid ${overlayTheme.divider}` }}>
                          {sidebarMetadataFieldItems.map((item) => {
                              const checked = sidebarTableMetadataFields.includes(item.field);
                              return (
                                  <SidebarMetadataSortableRow
                                      key={item.field}
                                      field={item.field}
                                      label={item.label}
                                      checked={checked}
                                      dividerColor={overlayTheme.divider}
                                      titleColor={overlayTheme.titleText}
                                      mutedColor={utilityMutedTextStyle.color as string}
                                      onToggle={(selected) => toggleSidebarMetadataFieldFromSettings(item.field, selected)}
                                  />
                              );
                          })}
                      </div>
                  </SortableContext>
              </DndContext>
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <Button
                  onClick={() => {
                      setQueryOptions({
                          sidebarTableMetadataFields: DEFAULT_SIDEBAR_TABLE_METADATA_FIELDS,
                          sidebarTableMetadataFieldOrder: [...SIDEBAR_TABLE_METADATA_FIELDS],
                      });
                  }}
              >
                  {t('app.theme.action.restore_defaults')}
              </Button>
          </div>
      </div>
  ), [
      overlayTheme.divider,
      overlayTheme.titleText,
      setQueryOptions,
      sidebarMetadataFieldItems,
      sidebarMetadataDragSensors,
      handleSidebarMetadataDragEnd,
      sidebarTableMetadataFields,
      t,
      toggleSidebarMetadataFieldFromSettings,
      utilityMutedTextStyle,
      utilityPanelStyle,
  ]);
  const renderSidebarObjectVisibilitySettingsPane = useCallback(() => {
      const hiddenObjectGroups = new Set(appearance.sidebarHiddenObjectGroups);
      const objectGroupItems: Array<{ key: SidebarObjectGroupKey; label: string }> = buildSidebarObjectVisibilitySettings(t);
      const setObjectGroupVisible = (key: SidebarObjectGroupKey, visible: boolean) => {
          const nextHiddenObjectGroups = visible
              ? appearance.sidebarHiddenObjectGroups.filter((item) => item !== key)
              : Array.from(new Set([...appearance.sidebarHiddenObjectGroups, key]));
          setAppearance({ sidebarHiddenObjectGroups: nextHiddenObjectGroups });
      };

      return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '12px 0' }}>
              <div style={utilityPanelStyle}>
                  <div style={{ display: 'grid', gap: 0, borderTop: `1px solid ${overlayTheme.divider}` }}>
                      {objectGroupItems.map((item) => (
                          <div
                              key={item.key}
                              data-sidebar-object-group-setting={item.key}
                              style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'space-between',
                                  gap: 12,
                                  minHeight: 36,
                                  padding: '0 2px',
                                  borderBottom: `1px solid ${overlayTheme.divider}`,
                              }}
                          >
                              <span>{item.label}</span>
                              <Switch
                                  checked={!hiddenObjectGroups.has(item.key)}
                                  aria-label={item.label}
                                  onChange={(visible) => setObjectGroupVisible(item.key, visible)}
                              />
                          </div>
                      ))}
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap', marginTop: 14 }}>
                      <Button onClick={() => setAppearance({ sidebarHiddenObjectGroups: [] })}>
                          {t('app.settings.sidebar_objects.action.show_all')}
                      </Button>
                      <Button
                          type="primary"
                          onClick={() => setAppearance({
                              sidebarHiddenObjectGroups: SIDEBAR_OBJECT_GROUP_KEYS.filter((key) => key !== 'tables'),
                          })}
                      >
                          {t('app.settings.sidebar_objects.action.tables_only')}
                      </Button>
                  </div>
              </div>
          </div>
      );
  }, [
      appearance.sidebarHiddenObjectGroups,
      overlayTheme.divider,
      setAppearance,
      t,
      utilityMutedTextStyle,
      utilityPanelStyle,
  ]);
  const updateInstallActionLabel = updateInstallAction === 'install-and-restart'
      ? t('app.about.action.install_and_restart')
      : (updateInstallAction === 'launch-installer'
          ? t('app.about.action.launch_installer')
          : t('app.about.action.restart_to_update'));
  const updateDownloadActionLabel = lastUpdateInfo?.packageType === 'msi'
      ? t('app.about.action.download_msi_update')
      : (lastUpdateInfo?.packageType === 'portable'
          ? t('app.about.action.download_portable_update')
          : t('app.about.action.download_update'));
  return {
    renderProxySettingsContent, renderDownloadSourceSettingsContent,
    renderSidebarMetadataSettingsPane, renderSidebarObjectVisibilitySettingsPane,
    updateInstallActionLabel, updateDownloadActionLabel,
  };
};

export type AppSettingsPanesRenderApi = ReturnType<typeof useAppSettingsPanesRender>;
