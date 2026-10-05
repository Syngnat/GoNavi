import { Button, Input, Alert, Spin } from 'antd';
import { FolderOpenOutlined } from '@ant-design/icons';
import {
  DataDirectoryPage,
  DirectorySectionHeading,
  DirectoryPathDisplay,
  DirectoryMetaGrid,
  DirectoryChoice,
  DirectoryNote,
} from '../../components/settings/DataDirectorySettings';
import AgentDataSettingsPanel from '../../components/ai/AgentDataSettingsPanel';
import type { AppCoreStateApi } from './useAppCoreState';
import type { AppProxySettingsApi } from './useAppProxySettings';
import type { AppSettingsNavigationApi } from './useAppSettingsNavigation';

export interface UseAppDirectorySettingsRenderInput {
  t: AppCoreStateApi['t'];
  dataRootInfo: AppProxySettingsApi['dataRootInfo'];
  selectedSavedQueryDirectoryPath: AppProxySettingsApi['selectedSavedQueryDirectoryPath'];
  handleOpenSavedQueryDirectory: AppSettingsNavigationApi['handleOpenSavedQueryDirectory'];
  directorySettingsApplying: AppProxySettingsApi['directorySettingsApplying'];
  handleSelectSavedQueryDirectory: AppSettingsNavigationApi['handleSelectSavedQueryDirectory'];
  savedQueryDirectoryApplying: AppProxySettingsApi['savedQueryDirectoryApplying'];
  handleApplySavedQueryDirectory: AppSettingsNavigationApi['handleApplySavedQueryDirectory'];
  handleOpenLogDirectory: AppSettingsNavigationApi['handleOpenLogDirectory'];
  selectedLogDirectoryPath: AppProxySettingsApi['selectedLogDirectoryPath'];
  handleSelectLogDirectory: AppSettingsNavigationApi['handleSelectLogDirectory'];
  logDirectoryApplying: AppProxySettingsApi['logDirectoryApplying'];
  handleApplyLogDirectory: AppSettingsNavigationApi['handleApplyLogDirectory'];
  dataRootLoading: AppProxySettingsApi['dataRootLoading'];
  handleOpenDataRoot: AppSettingsNavigationApi['handleOpenDataRoot'];
  selectedDataRootPath: AppProxySettingsApi['selectedDataRootPath'];
  handleSelectDataRoot: AppSettingsNavigationApi['handleSelectDataRoot'];
  dataRootApplying: AppProxySettingsApi['dataRootApplying'];
  handleApplyDataRoot: AppSettingsNavigationApi['handleApplyDataRoot'];
}

export const useAppDirectorySettingsRender = ({
  t, dataRootInfo, selectedSavedQueryDirectoryPath, handleOpenSavedQueryDirectory,
  directorySettingsApplying, handleSelectSavedQueryDirectory, savedQueryDirectoryApplying,
  handleApplySavedQueryDirectory, handleOpenLogDirectory, selectedLogDirectoryPath,
  handleSelectLogDirectory, logDirectoryApplying, handleApplyLogDirectory, dataRootLoading,
  handleOpenDataRoot, selectedDataRootPath, handleSelectDataRoot, dataRootApplying,
  handleApplyDataRoot,
}: UseAppDirectorySettingsRenderInput) => {
  const renderSavedQueryDirectorySettings = (readOnly = false) => (
      <DataDirectoryPage testId="saved-queries">
          <section className="gn-storage-panel gn-storage-panel--current" data-saved-query-directory-settings="true">
              <div className="gn-storage-panel__body">
                  <DirectorySectionHeading
                      title={t('app.data_root.current_location')}
                      description={t('app.data_root.saved_query_directory.current_description')}
                  />
                  <DirectoryPathDisplay
                      label={t('app.data_root.saved_query_directory.current_directory')}
                      path={dataRootInfo?.savedQueryDirectory || selectedSavedQueryDirectoryPath}
                      action={!readOnly ? (
                          <Button onClick={() => void handleOpenSavedQueryDirectory()}>
                              {t('app.data_root.action.open_current')}
                          </Button>
                      ) : undefined}
                  />
                  <DirectoryMetaGrid items={[{
                      label: t('app.data_root.saved_query_directory.default_directory'),
                      value: dataRootInfo?.defaultSavedQueryDirectory || '-',
                  }]} />
              </div>
          </section>

          {!readOnly && (
              <section className="gn-storage-panel">
                  <div className="gn-storage-panel__body">
                      <DirectorySectionHeading
                          title={t('app.data_root.change_location')}
                          description={t('app.data_root.saved_query_directory.change_description')}
                      />
                      <div className="gn-storage-path-editor">
                          <Input
                              readOnly
                              value={selectedSavedQueryDirectoryPath}
                              placeholder={t('app.data_root.saved_query_directory.placeholder')}
                              aria-label={t('app.data_root.saved_query_directory.title')}
                          />
                          <div className="gn-storage-path-editor__actions">
                              <Button
                                  icon={<FolderOpenOutlined />}
                                  disabled={directorySettingsApplying}
                                  onClick={() => void handleSelectSavedQueryDirectory()}
                              >
                                  {t('app.data_root.action.select')}
                              </Button>
                              <Button
                                  disabled={directorySettingsApplying}
                                  loading={savedQueryDirectoryApplying}
                                  onClick={() => void handleApplySavedQueryDirectory(true)}
                              >
                                  {t('app.data_root.action.restore_default_directory')}
                              </Button>
                          </div>
                      </div>
                      <DirectoryChoice
                          recommended
                          badge={t('app.data_root.recommended')}
                          title={t('app.data_root.saved_query_directory.apply_title')}
                          description={t('app.data_root.saved_query_directory.apply_description')}
                          action={(
                              <Button
                                  type="primary"
                                  disabled={directorySettingsApplying}
                                  loading={savedQueryDirectoryApplying}
                                  onClick={() => void handleApplySavedQueryDirectory(false)}
                              >
                                  {t('app.data_root.action.use_selected_directory')}
                              </Button>
                          )}
                      />
                  </div>
              </section>
          )}
      </DataDirectoryPage>
  );

  const renderLogDirectorySettings = (readOnly = false) => {
      const editable = dataRootInfo?.logDirectoryEditable !== false;
      const managedByEnvironment = dataRootInfo?.logDirectorySource === 'environment';
      const restartRequired = dataRootInfo?.logDirectoryRestartRequired === true;
      return (
          <section className="gn-storage-panel" data-log-directory-settings="true">
              <div className="gn-storage-panel__body">
                  <div className="gn-storage-panel__header">
                      <DirectorySectionHeading
                          title={t('app.data_root.log_directory.title')}
                          description={t('app.data_root.log_directory.description')}
                      />
                      {!readOnly && (
                          <Button onClick={() => void handleOpenLogDirectory()}>
                              {t('app.data_root.action.open_current')}
                          </Button>
                      )}
                  </div>
                  <div className="gn-storage-path-editor">
                      <Input
                          readOnly
                          disabled={!editable}
                          value={selectedLogDirectoryPath}
                          placeholder={t('app.data_root.log_directory.placeholder')}
                          aria-label={t('app.data_root.log_directory.title')}
                      />
                      {!readOnly && (
                          <div className="gn-storage-path-editor__actions">
                              <Button
                                  icon={<FolderOpenOutlined />}
                                  disabled={!editable || directorySettingsApplying}
                                  onClick={() => void handleSelectLogDirectory()}
                              >
                                  {t('app.data_root.action.select')}
                              </Button>
                              <Button
                                  disabled={!editable || directorySettingsApplying}
                                  loading={logDirectoryApplying}
                                  onClick={() => void handleApplyLogDirectory(true)}
                              >
                                  {t('app.data_root.action.restore_default_directory')}
                              </Button>
                              <Button
                                  type="primary"
                                  disabled={!editable || directorySettingsApplying}
                                  loading={logDirectoryApplying}
                                  onClick={() => void handleApplyLogDirectory(false)}
                              >
                                  {t('app.data_root.log_directory.action.save')}
                              </Button>
                          </div>
                      )}
                  </div>
                  <DirectoryMetaGrid items={[
                      { label: t('app.data_root.log_directory.current_file'), value: dataRootInfo?.logFilePath || '-' },
                      { label: t('app.data_root.log_directory.default_directory'), value: dataRootInfo?.defaultLogDirectory || '-' },
                  ]} />
                  {managedByEnvironment ? (
                      <Alert type="warning" showIcon message={t('app.data_root.log_directory.environment_hint')} />
                  ) : restartRequired ? (
                      <Alert type="info" showIcon message={t('app.data_root.log_directory.pending_restart')} />
                  ) : (
                      <DirectoryNote>{t('app.data_root.log_directory.restart_hint')}</DirectoryNote>
                  )}
              </div>
          </section>
      );
  };

  const renderDataDirectorySettings = (
      section: 'all' | 'application' | 'agent' | 'saved-queries' = 'all',
      readOnly = false,
  ) => {
      if (dataRootLoading) {
          return (
              <div style={{ padding: '28px 0', textAlign: 'center' }}>
                  <Spin />
              </div>
          );
      }
      return (
          <div
              style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: '12px 0' }}
              data-data-directory-layout="true"
          >
              {(section === 'all' || section === 'application') && (
              <DataDirectoryPage testId="application">
                  <section
                      className="gn-storage-panel gn-storage-panel--current"
                      data-data-directory-section="application"
                  >
                      <div className="gn-storage-panel__body">
                          <DirectorySectionHeading
                              title={t('app.data_root.current_location')}
                              description={t('app.data_root.application.current_description')}
                          />
                          <DirectoryPathDisplay
                              label={t('app.data_root.current_directory')}
                              path={dataRootInfo?.path || ''}
                              action={!readOnly ? (
                                  <Button onClick={() => void handleOpenDataRoot()}>
                                      {t('app.data_root.action.open_current')}
                                  </Button>
                              ) : undefined}
                          />
                          <div>
                              <div className="gn-storage-field-label">{t('app.data_root.application.stores')}</div>
                              <div className="gn-storage-tags">
                                  <span className="gn-storage-tag">{t('app.data_root.application.content.connections')}</span>
                                  <span className="gn-storage-tag">{t('app.data_root.application.content.ai_config')}</span>
                                  <span className="gn-storage-tag">{t('app.data_root.application.content.drivers')}</span>
                              </div>
                          </div>
                          <DirectoryMetaGrid items={[
                              { label: t('app.data_root.default_directory'), value: dataRootInfo?.defaultPath || '-' },
                              { label: t('app.data_root.driver_directory'), value: dataRootInfo?.driverPath || '-' },
                          ]} />
                      </div>
                  </section>

                  {!readOnly && (
                      <section className="gn-storage-panel">
                          <div className="gn-storage-panel__body">
                              <DirectorySectionHeading
                                  title={t('app.data_root.change_location')}
                                  description={t('app.data_root.change_location_description')}
                              />
                              <div className="gn-storage-path-editor">
                                  <Input
                                      readOnly
                                      value={selectedDataRootPath}
                                      placeholder={t('app.data_root.placeholder.select_new_directory')}
                                      aria-label={t('app.data_root.switch_target')}
                                  />
                                  <div className="gn-storage-path-editor__actions">
                                      <Button
                                          icon={<FolderOpenOutlined />}
                                          disabled={directorySettingsApplying}
                                          onClick={() => void handleSelectDataRoot()}
                                      >
                                          {t('app.data_root.action.select')}
                                      </Button>
                                      <Button
                                          disabled={directorySettingsApplying}
                                          loading={dataRootApplying}
                                          onClick={() => void handleApplyDataRoot(false, true)}
                                      >
                                          {t('app.data_root.action.restore_default_directory')}
                                      </Button>
                                  </div>
                              </div>
                              <div className="gn-storage-choice-grid">
                                  <DirectoryChoice
                                      title={t('app.data_root.action.switch_now')}
                                      description={t('app.data_root.switch_only_hint')}
                                      action={(
                                          <Button
                                              disabled={directorySettingsApplying}
                                              loading={dataRootApplying}
                                              onClick={() => void handleApplyDataRoot(false)}
                                          >
                                              {t('app.data_root.action.switch_now')}
                                          </Button>
                                      )}
                                  />
                                  <DirectoryChoice
                                      recommended
                                      badge={t('app.data_root.recommended')}
                                      title={t('app.data_root.action.migrate_now')}
                                      description={t('app.data_root.migrate_hint')}
                                      action={(
                                          <Button
                                              type="primary"
                                              disabled={directorySettingsApplying}
                                              loading={dataRootApplying}
                                              onClick={() => void handleApplyDataRoot(true)}
                                          >
                                              {t('app.data_root.action.migrate_now')}
                                          </Button>
                                      )}
                                  />
                              </div>
                              <DirectoryNote>{t('app.data_root.restart_hint')}</DirectoryNote>
                          </div>
                      </section>
                  )}

                  {renderLogDirectorySettings(readOnly)}
              </DataDirectoryPage>
              )}

              {(section === 'all' || section === 'agent') && <AgentDataSettingsPanel
                  readOnly={readOnly}
              />}

              {(section === 'all' || section === 'saved-queries') && renderSavedQueryDirectorySettings(readOnly)}
          </div>
      );
  };
  return { renderDataDirectorySettings };
};

export type AppDirectorySettingsRenderApi = ReturnType<typeof useAppDirectorySettingsRender>;
