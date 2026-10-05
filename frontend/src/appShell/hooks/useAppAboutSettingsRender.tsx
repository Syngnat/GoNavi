import { Button, Spin, Select, message, Segmented, Switch } from 'antd';
import {
  DownloadOutlined,
  CloudDownloadOutlined,
  SyncOutlined,
  GithubOutlined,
  BugOutlined,
  CopyOutlined,
  RightOutlined,
  UserOutlined,
  MessageOutlined,
  FileTextOutlined,
  WechatOutlined,
  SkinOutlined,
  BgColorsOutlined,
  AppstoreOutlined,
} from '@ant-design/icons';
import React from 'react';
import { BrowserOpenURL } from '../../../wailsjs/runtime';
import { formatAboutReleaseTime } from '../aboutSettingsFormat';
import { AUTO_CHECK_FOR_UPDATES_INTERVAL_OPTIONS } from '../../store';
import DownloadSourceSelect from '../../components/DownloadSourceSelect';
import type { AppUpdateAndDiagnosticsApi } from './useAppUpdateAndDiagnostics';
import type { AppCoreStateApi } from './useAppCoreState';
import type { AppSettingsPanesRenderApi } from './useAppSettingsPanesRender';
import type { AppQuitAndUpdateApi } from './useAppQuitAndUpdate';
import type { AppSecurityUpdateApi } from './useAppSecurityUpdate';
import type { AppShellStateApi } from './useAppShellState';
import type { AppBootstrapEffectsApi } from './useAppBootstrapEffects';

export interface UseAppAboutSettingsRenderInput {
  isBackgroundProgressForLatestUpdate: AppUpdateAndDiagnosticsApi['isBackgroundProgressForLatestUpdate'];
  isLatestUpdateDownloaded: AppUpdateAndDiagnosticsApi['isLatestUpdateDownloaded'];
  showUpdateDownloadProgress: AppUpdateAndDiagnosticsApi['showUpdateDownloadProgress'];
  lastUpdateInfo: AppUpdateAndDiagnosticsApi['lastUpdateInfo'];
  muteLatestUpdate: AppUpdateAndDiagnosticsApi['muteLatestUpdate'];
  isCheckingForUpdates: AppUpdateAndDiagnosticsApi['isCheckingForUpdates'];
  checkForUpdates: AppUpdateAndDiagnosticsApi['checkForUpdates'];
  openDownloadedUpdateDirectory: AppUpdateAndDiagnosticsApi['openDownloadedUpdateDirectory'];
  t: AppCoreStateApi['t'];
  handleDownloadUpdateWithNotes: AppUpdateAndDiagnosticsApi['handleDownloadUpdateWithNotes'];
  updateDownloadActionLabel: AppSettingsPanesRenderApi['updateDownloadActionLabel'];
  handleInstallUpdateRequest: AppQuitAndUpdateApi['handleInstallUpdateRequest'];
  updateInstallActionLabel: AppSettingsPanesRenderApi['updateInstallActionLabel'];
  aboutLoading: AppUpdateAndDiagnosticsApi['aboutLoading'];
  aboutDisplayVersion: AppUpdateAndDiagnosticsApi['aboutDisplayVersion'];
  aboutInfo: AppUpdateAndDiagnosticsApi['aboutInfo'];
  aboutUpdateStatus: AppUpdateAndDiagnosticsApi['aboutUpdateStatus'];
  updateChannel: AppUpdateAndDiagnosticsApi['updateChannel'];
  changeUpdateChannel: AppUpdateAndDiagnosticsApi['changeUpdateChannel'];
  isUpdateChannelLoading: AppUpdateAndDiagnosticsApi['isUpdateChannelLoading'];
  isUpdateChannelSaving: AppUpdateAndDiagnosticsApi['isUpdateChannelSaving'];
  updateDownloadProgress: AppUpdateAndDiagnosticsApi['updateDownloadProgress'];
  utilityPanelStyle: AppSecurityUpdateApi['utilityPanelStyle'];
  utilityMutedTextStyle: AppSecurityUpdateApi['utilityMutedTextStyle'];
  darkMode: AppCoreStateApi['darkMode'];
  overlayTheme: AppSecurityUpdateApi['overlayTheme'];
  installMode: AppUpdateAndDiagnosticsApi['installMode'];
  openReleaseNotesModal: AppUpdateAndDiagnosticsApi['openReleaseNotesModal'];
  hasUnreadReleaseNotes: AppUpdateAndDiagnosticsApi['hasUnreadReleaseNotes'];
  autoCheckForUpdates: AppCoreStateApi['autoCheckForUpdates'];
  setAutoCheckForUpdates: AppCoreStateApi['setAutoCheckForUpdates'];
  autoCheckForUpdatesIntervalMinutes: AppCoreStateApi['autoCheckForUpdatesIntervalMinutes'];
  setAutoCheckForUpdatesIntervalMinutes: AppCoreStateApi['setAutoCheckForUpdatesIntervalMinutes'];
  downloadSource: AppShellStateApi['downloadSource'];
  downloadSourceSaving: AppShellStateApi['downloadSourceSaving'];
  handleDownloadSourceChange: AppBootstrapEffectsApi['handleDownloadSourceChange'];
}

export const useAppAboutSettingsRender = ({
  isBackgroundProgressForLatestUpdate, isLatestUpdateDownloaded, showUpdateDownloadProgress,
  lastUpdateInfo, muteLatestUpdate, isCheckingForUpdates, checkForUpdates,
  openDownloadedUpdateDirectory, t, handleDownloadUpdateWithNotes, updateDownloadActionLabel,
  handleInstallUpdateRequest, updateInstallActionLabel, aboutLoading, aboutDisplayVersion,
  aboutInfo, aboutUpdateStatus, updateChannel, changeUpdateChannel, isUpdateChannelLoading,
  isUpdateChannelSaving, updateDownloadProgress, utilityPanelStyle, utilityMutedTextStyle, darkMode,
  overlayTheme, installMode, openReleaseNotesModal, hasUnreadReleaseNotes, autoCheckForUpdates,
  setAutoCheckForUpdates, autoCheckForUpdatesIntervalMinutes, setAutoCheckForUpdatesIntervalMinutes,
  downloadSource, downloadSourceSaving, handleDownloadSourceChange,
}: UseAppAboutSettingsRenderInput) => {
  const renderAboutUpdateActions = () => [
      isBackgroundProgressForLatestUpdate && !isLatestUpdateDownloaded ? (
          <Button key="progress" icon={<DownloadOutlined />} onClick={showUpdateDownloadProgress}>{t('app.about.action.download_progress')}</Button>
      ) : null,
      lastUpdateInfo?.hasUpdate && !isLatestUpdateDownloaded && !isBackgroundProgressForLatestUpdate ? (
          <Button key="mute" onClick={muteLatestUpdate}>{t('app.about.action.mute_this_version')}</Button>
      ) : null,
      <Button
          key="check"
          icon={<CloudDownloadOutlined />}
          loading={isCheckingForUpdates}
          onClick={() => checkForUpdates(false, true)}
      >
          {t('app.about.action.check_updates')}
      </Button>,
      lastUpdateInfo?.hasUpdate && !isLatestUpdateDownloaded && !isBackgroundProgressForLatestUpdate ? (
          <Button key="download" type="primary" icon={<DownloadOutlined />} onClick={handleDownloadUpdateWithNotes}>{updateDownloadActionLabel}</Button>
      ) : null,
      isLatestUpdateDownloaded ? (
          <Button key="open-install-directory" onClick={openDownloadedUpdateDirectory}>
              {t('app.about.action.open_install_directory')}
          </Button>
      ) : null,
      isLatestUpdateDownloaded ? (
          <Button
              key="restart-to-update"
              type="primary"
              icon={<SyncOutlined />}
              onClick={() => { void handleInstallUpdateRequest(); }}
          >
              {updateInstallActionLabel}
          </Button>
      ) : null,
  ].filter(Boolean);

  const renderAboutSettingsContent = () => (
      aboutLoading ? (
          <div style={{ padding: '16px 0', textAlign: 'center' }}>
              <Spin />
          </div>
      ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div style={utilityPanelStyle}>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12 }}>
                      <div>
                          <div style={{ marginBottom: 6, fontWeight: 600 }}>{t('app.about.field.version')}</div>
                          <div style={utilityMutedTextStyle}>{aboutDisplayVersion}</div>
                      </div>
                      <div>
                          <div style={{ marginBottom: 6, fontWeight: 600 }}>{t('app.about.field.author')}</div>
                          <div style={utilityMutedTextStyle}>{aboutInfo?.author || t('common.unknown')}</div>
                      </div>
                      <div style={{ gridColumn: '1 / -1' }}>
                          <div style={{ marginBottom: 6, fontWeight: 600 }}>{t('app.about.field.update_status')}</div>
                          <div style={utilityMutedTextStyle}>{aboutUpdateStatus || t('app.about.update_status.not_checked')}</div>
                      </div>
                      <div style={{ gridColumn: '1 / -1' }}>
                          <div style={{ marginBottom: 6, fontWeight: 600 }}>{t('app.about.field.update_channel')}</div>
                          <Select
                              value={updateChannel}
                              options={[
                                  { value: 'latest', label: t('app.about.update_channel.latest') },
                                  { value: 'dev', label: t('app.about.update_channel.dev') },
                              ]}
                              onChange={(value) => {
                                  void changeUpdateChannel(String(value));
                              }}
                              loading={isUpdateChannelLoading}
                              disabled={
                                  isUpdateChannelLoading
                                  || isUpdateChannelSaving
                                  || updateDownloadProgress.status === 'start'
                                  || updateDownloadProgress.status === 'downloading'
                              }
                              style={{ width: 220, maxWidth: '100%' }}
                          />
                      </div>
                      {aboutInfo?.communityUrl ? (
                          <div style={{ gridColumn: '1 / -1' }}>
                              <div style={{ marginBottom: 6, fontWeight: 600 }}>{t('app.about.field.community')}</div>
                              <a onClick={(e) => { e.preventDefault(); if (aboutInfo?.communityUrl) BrowserOpenURL(aboutInfo.communityUrl); }} href={aboutInfo.communityUrl}>{t('app.about.community.ai_book')}</a>
                          </div>
                      ) : null}
                  </div>
              </div>
              <div style={utilityPanelStyle}>
                  <div style={{ marginBottom: 10, fontWeight: 600 }}>{t('app.about.project_links')}</div>
                  <div style={{ display: 'grid', gap: 10 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <GithubOutlined />
                          {aboutInfo?.repoUrl ? (
                              <a onClick={(e) => { e.preventDefault(); if (aboutInfo?.repoUrl) BrowserOpenURL(aboutInfo.repoUrl); }} href={aboutInfo.repoUrl}>{aboutInfo.repoUrl}</a>
                          ) : t('common.unknown')}
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <BugOutlined />
                          {aboutInfo?.issueUrl ? (
                              <a onClick={(e) => { e.preventDefault(); if (aboutInfo?.issueUrl) BrowserOpenURL(aboutInfo.issueUrl); }} href={aboutInfo.issueUrl}>{aboutInfo.issueUrl}</a>
                          ) : t('common.unknown')}
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <CloudDownloadOutlined />
                          {aboutInfo?.releaseUrl ? (
                              <a onClick={(e) => { e.preventDefault(); if (aboutInfo?.releaseUrl) BrowserOpenURL(aboutInfo.releaseUrl); }} href={aboutInfo.releaseUrl}>{aboutInfo.releaseUrl}</a>
                          ) : t('common.unknown')}
                      </div>
                  </div>
              </div>
          </div>
      )
  );

  const renderSettingsCenterAboutProjectEntry = ({
      icon,
      title,
      description,
      url,
      copyText,
  }: {
      icon: React.ReactNode;
      title: string;
      description: string;
      url?: string;
      copyText?: string;
  }) => (
      <button
        className="gonavi-about-project-entry"
        type="button"
        onClick={() => {
            if (copyText) {
                void navigator.clipboard.writeText(copyText).then(() => {
                    void message.success(t('app.about.project.wechat.copied'));
                });
                return;
            }
            if (url) {
                BrowserOpenURL(url);
            }
        }}
        disabled={!url && !copyText}
        style={{
            width: '100%',
            display: 'flex',
            alignItems: 'flex-start',
            gap: 10,
            padding: '10px 12px',
            border: `1px solid ${darkMode ? 'rgba(255,255,255,0.10)' : 'rgba(16,24,40,0.10)'}`,
            borderRadius: 8,
            background: darkMode ? 'rgba(255,255,255,0.03)' : 'rgba(255,255,255,0.72)',
            color: darkMode ? 'rgba(255,255,255,0.90)' : '#101828',
            cursor: url || copyText ? 'pointer' : 'not-allowed',
            opacity: url || copyText ? 1 : 0.58,
            textAlign: 'left',
        }}
      >
          <span style={{ fontSize: 18, display: 'grid', placeItems: 'center', marginTop: 1, color: overlayTheme.iconColor }}>
              {icon}
          </span>
          <span style={{ minWidth: 0, flex: 1 }}>
              <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  <span style={{ fontSize: 13, fontWeight: 700, lineHeight: 1.35 }}>{title}</span>
                  {copyText
                    ? <CopyOutlined style={{ color: overlayTheme.mutedText, fontSize: 12, flexShrink: 0 }} />
                    : <RightOutlined style={{ color: overlayTheme.mutedText, fontSize: 12, flexShrink: 0 }} />}
              </span>
              <span style={{ ...utilityMutedTextStyle, display: 'block', marginTop: 3, lineHeight: 1.4 }}>{description}</span>
          </span>
      </button>
  );

  const renderSettingsCenterAboutPane = () => {
      if (aboutLoading) {
          return (
              <div style={{ padding: '16px 0', textAlign: 'center' }}>
                  <Spin />
              </div>
          );
      }

      const hasUpdate = Boolean(lastUpdateInfo?.hasUpdate);
      const latestVersionText = lastUpdateInfo?.latestVersion || t('common.unknown');
      const currentVersionText = lastUpdateInfo?.currentVersion || aboutDisplayVersion;
      const releaseTimeText = formatAboutReleaseTime(lastUpdateInfo?.releasePublishedAt);
      const canOpenReleaseNotes = Boolean(lastUpdateInfo);
      const packageType = ['portable', 'msi', 'dmg', 'archive'].includes(String(lastUpdateInfo?.packageType || ''))
          ? String(lastUpdateInfo?.packageType)
          : 'unknown';
      const mutedText = utilityMutedTextStyle.color;
      const dividerColor = darkMode ? 'rgba(255,255,255,0.09)' : 'rgba(16,24,40,0.09)';
      const versionRows: Array<[string, React.ReactNode]> = [
          [t('app.about.version.current'), currentVersionText],
          [t('app.about.version.latest'), latestVersionText],
          [t('app.about.version.release_time'), releaseTimeText],
          [
              t('app.about.version.release_notes'),
              (
                  <Button
                      type="link"
                      size="small"
                      disabled={!canOpenReleaseNotes}
                      onClick={openReleaseNotesModal}
                      style={{ padding: 0, height: 'auto', fontWeight: 600 }}
                  >
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                          {t('app.about.release_notes.action.view')}
                          {hasUnreadReleaseNotes ? (
                              <span
                                  aria-label={t('app.about.release_notes.unread_badge')}
                                  style={{
                                      width: 7,
                                      height: 7,
                                      borderRadius: 999,
                                      background: darkMode ? '#4ade80' : '#16a34a',
                                  }}
                              />
                          ) : null}
                      </span>
                  </Button>
              ),
          ],
          ...(installMode === 'msi' || installMode === 'portable'
              ? [[t('app.about.version.install_mode'), t(`app.about.install_mode.${installMode}`)] as [string, React.ReactNode]]
              : []),
          ...(hasUpdate && packageType !== 'unknown'
              ? [[t('app.about.version.package_type'), t(`app.about.package_type.${packageType}`)] as [string, React.ReactNode]]
              : []),
      ];

      return (
          <div className="gonavi-about-pane">
              <section className="gonavi-about-identity" aria-label="GoNavi">
                  <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontSize: 18, lineHeight: 1.15, fontWeight: 800, color: overlayTheme.titleText }}>GoNavi</div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 4, flexWrap: 'wrap', color: mutedText, fontWeight: 600, fontSize: 12 }}>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                              <UserOutlined />
                              {aboutInfo?.author || t('common.unknown')}
                          </span>
                      </div>
                  </div>
              </section>

              <section className="gonavi-about-section" aria-label={t('app.about.version_update.title')}>
                  <div className="gonavi-about-setting">
                      <div className="gonavi-about-field">
                          <div className="gonavi-about-field-label" style={{ color: overlayTheme.titleText }}>{t('app.about.field.update_channel')}</div>
                          <Segmented
                            className="gonavi-about-update-channel"
                            value={updateChannel}
                            options={[
                                { value: 'latest', label: t('app.about.update_channel.latest') },
                                { value: 'dev', label: t('app.about.update_channel.dev') },
                            ]}
                            onChange={(value) => {
                                void changeUpdateChannel(String(value));
                            }}
                            disabled={
                                isUpdateChannelLoading
                                || isUpdateChannelSaving
                                || updateDownloadProgress.status === 'start'
                                || updateDownloadProgress.status === 'downloading'
                            }
                          />
                      </div>
                      <div className="gonavi-about-field-hint" style={utilityMutedTextStyle}>
                          {updateChannel === 'dev'
                              ? t('app.about.version_update.channel_hint.dev')
                              : t('app.about.version_update.channel_hint.latest')}
                      </div>
                  </div>
                  <div className="gonavi-about-setting">
                      <div className="gonavi-about-field">
                          <div className="gonavi-about-field-label" style={{ color: overlayTheme.titleText }}>{t('app.about.field.auto_check_updates')}</div>
                          <span className="gonavi-about-field-control">
                            <Switch
                              checked={autoCheckForUpdates}
                              onChange={(checked) => setAutoCheckForUpdates(checked)}
                            />
                          </span>
                      </div>
                      {autoCheckForUpdates ? (
                          <>
                              <div className="gonavi-about-field">
                                  <div className="gonavi-about-field-label" style={{ color: overlayTheme.titleText }}>{t('app.about.field.auto_check_interval')}</div>
                                  <Select
                                    className="gonavi-about-auto-check-interval"
                                    value={autoCheckForUpdatesIntervalMinutes}
                                    options={AUTO_CHECK_FOR_UPDATES_INTERVAL_OPTIONS.map((minutes) => ({
                                      value: minutes,
                                      label: minutes >= 60 && minutes % 60 === 0
                                        ? t('app.about.auto_check_interval.hours', { hours: minutes / 60 })
                                        : t('app.about.auto_check_interval.minutes', { minutes }),
                                    }))}
                                    onChange={(value) => setAutoCheckForUpdatesIntervalMinutes(Number(value))}
                                  />
                              </div>
                              <div className="gonavi-about-field-hint" style={utilityMutedTextStyle}>{t('app.about.version_update.auto_check_hint')}</div>
                          </>
                      ) : (
                          <div className="gonavi-about-field-hint" style={utilityMutedTextStyle}>{t('app.about.version_update.auto_check_disabled_hint')}</div>
                      )}
                  </div>
                  <div className="gonavi-about-facts" style={{ borderTop: `1px solid ${dividerColor}` }}>
                      {versionRows.map(([label, value]) => (
                          <div key={label} className="gonavi-about-fact">
                              <div className="gonavi-about-field-label" style={{ color: overlayTheme.titleText }}>{label}</div>
                              <div style={{ color: label === t('app.about.version.latest') && hasUpdate ? (darkMode ? '#86efac' : '#16a34a') : mutedText, fontWeight: label === t('app.about.version.latest') && hasUpdate ? 700 : 500, lineHeight: 1.45, minWidth: 0, overflowWrap: 'anywhere' }}>
                                  {value}
                              </div>
                          </div>
                      ))}
                  </div>
                  <div
                    className="gonavi-about-download-source"
                    data-download-source={downloadSource}
                    style={{
                        borderColor: dividerColor,
                        background: darkMode ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.02)',
                    }}
                  >
                    <span className="gonavi-about-download-source-label" style={{ color: mutedText }}>
                        {t('driver_manager.mirror_source.label')}
                    </span>
                    <DownloadSourceSelect
                      value={downloadSource}
                      darkMode={darkMode}
                      saving={downloadSourceSaving}
                      onChange={(source) => void handleDownloadSourceChange(source)}
                      borderless
                      className="gonavi-about-download-source-select"
                    />
                  </div>
              </section>

              <section className="gonavi-about-section" aria-labelledby="gonavi-about-project-heading">
                  <div id="gonavi-about-project-heading" className="gonavi-about-section-title" style={{ color: overlayTheme.titleText }}>
                      {t('app.about.project_links')}
                  </div>
                  <div className="gonavi-about-link-grid">
                      {renderSettingsCenterAboutProjectEntry({
                          icon: <GithubOutlined />,
                          title: t('app.about.project.github.title'),
                          description: t('app.about.project.github.description'),
                          url: aboutInfo?.repoUrl,
                      })}
                      {renderSettingsCenterAboutProjectEntry({
                          icon: <MessageOutlined />,
                          title: t('app.about.project.issues.title'),
                          description: t('app.about.project.issues.description'),
                          url: aboutInfo?.issueUrl,
                      })}
                      {renderSettingsCenterAboutProjectEntry({
                          icon: <FileTextOutlined />,
                          title: t('app.about.project.releases.title'),
                          description: t('app.about.project.releases.description'),
                          url: lastUpdateInfo?.releaseNotesUrl || aboutInfo?.releaseUrl,
                      })}
                      {renderSettingsCenterAboutProjectEntry({
                          icon: <WechatOutlined />,
                          title: t('app.about.project.wechat.title'),
                          description: t('app.about.project.wechat.description'),
                          copyText: t('app.about.project.wechat.id'),
                      })}
                  </div>
              </section>
          </div>
      );
  };

  const renderSettingsCenterAboutFooter = () => (
      <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginLeft: 'auto' }}>
          {renderAboutUpdateActions()}
      </div>
  );

  const renderThemeSettingsSection = (title: React.ReactNode, children: React.ReactNode, hint?: React.ReactNode) => (
      <section className="gonavi-settings-section">
          {title ? <div className="gonavi-settings-section-title">{title}</div> : null}
          {hint ? <div className="gonavi-settings-section-hint">{hint}</div> : null}
          <div>{children}</div>
      </section>
  );

  const renderThemeSettingsRow = ({
      label,
      hint,
      control,
      stacked = false,
      controlOnly = false,
  }: {
      label?: React.ReactNode;
      hint?: React.ReactNode;
      control: React.ReactNode;
      stacked?: boolean;
      /** 分区标题已说明用途时，只渲染控件，避免标题重复 */
      controlOnly?: boolean;
  }) => (
      <div className={`gonavi-settings-row${stacked || controlOnly ? ' is-stacked' : ''}${controlOnly ? ' is-control-only' : ''}`}>
          {!controlOnly ? (
              <div>
                  <div className="gonavi-settings-label">{label}</div>
                  {hint ? <div className="gonavi-settings-label-hint">{hint}</div> : null}
              </div>
          ) : null}
          <div className="gonavi-settings-control">{control}</div>
      </div>
  );

  const renderThemeModePreview = (preview: 'light' | 'dark' | 'system') => (
      <div
        aria-hidden
        className={`gonavi-settings-mode-preview${preview === 'system' ? ' is-system' : ''}`}
      >
          {(preview === 'light' || preview === 'system') ? (
              <div className="gonavi-settings-mode-preview-pane is-light">
                  <span className="gonavi-settings-mode-preview-line" />
                  <span className="gonavi-settings-mode-preview-line" />
                  <span className="gonavi-settings-mode-preview-line" />
              </div>
          ) : null}
          {(preview === 'dark' || preview === 'system') ? (
              <div className="gonavi-settings-mode-preview-pane is-dark">
                  <span className="gonavi-settings-mode-preview-line" />
                  <span className="gonavi-settings-mode-preview-line" />
                  <span className="gonavi-settings-mode-preview-line" />
              </div>
          ) : null}
      </div>
  );

  const themeSettingsSections = [
      { value: 'theme' as const, label: t('app.theme.nav.theme.title'), icon: <SkinOutlined /> },
      { value: 'appearance' as const, label: t('app.theme.nav.appearance.title'), icon: <BgColorsOutlined /> },
      { value: 'workspace' as const, label: t('app.theme.nav.workspace.title'), icon: <AppstoreOutlined /> },
  ];
  return {
    renderSettingsCenterAboutPane, renderSettingsCenterAboutFooter, renderThemeSettingsSection,
    renderThemeSettingsRow, renderThemeModePreview, themeSettingsSections,
  };
};

export type AppAboutSettingsRenderApi = ReturnType<typeof useAppAboutSettingsRender>;
