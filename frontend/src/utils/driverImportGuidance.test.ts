import { describe, expect, it } from 'vitest';

import { t as catalogT } from '../i18n/catalog';
import { t } from '../i18n';
import {
  getCustomConnectionDriverHelp,
  getDriverLocalImportButtonLabel,
  getDriverLocalImportDirectoryHelp,
  getDriverLocalImportSingleFileHelp,
} from './driverImportGuidance';

describe('driver import guidance', () => {
  it.each([
    {
      name: 'version list',
      rawMessage: '加载 MariaDB 版本列表失败：connect timed out',
      fallbackMessage: t('driver.modal.error.versionList', { name: 'MariaDB' }),
      detailKey: 'driver.modal.error.versionListLoad',
      detailParams: { name: 'MariaDB' },
      expected: t('driver.modal.error.versionListLoad', { name: 'MariaDB', detail: 'connect timed out' }),
    },
    {
      name: 'install driver',
      rawMessage: catalogT('zh-CN', 'driver_manager.backend.message.download_failed_detail', { detail: 'connect timed out' }),
      fallbackMessage: t('driver.modal.error.installDriver', { name: 'MariaDB' }),
      detailParams: { name: 'MariaDB' },
      backendWrapperKeys: [
        'driver_manager.backend.message.download_failed_detail',
        'driver_manager.backend.message.metadata_write_failed_detail',
      ],
      expected: `${t('driver.modal.error.installDriver', { name: 'MariaDB' })}: connect timed out`,
    },
    {
      name: 'local import driver',
      rawMessage: catalogT('zh-CN', 'driver_manager.backend.message.metadata_write_failed_detail', { detail: 'connect timed out' }),
      fallbackMessage: t('driver.modal.error.localImportDriver', { name: 'MariaDB' }),
      detailParams: { name: 'MariaDB' },
      backendWrapperKeys: [
        'driver_manager.backend.message.local_import_failed_detail',
        'driver_manager.backend.message.metadata_write_failed_detail',
      ],
      expected: `${t('driver.modal.error.localImportDriver', { name: 'MariaDB' })}: connect timed out`,
    },
    {
      name: 'open driver directory',
      rawMessage: catalogT('zh-CN', 'driver_manager.backend.error.create_directory_failed', { detail: 'connect timed out' }),
      fallbackMessage: t('driver.modal.error.openDirectory'),
      detailKey: 'driver.modal.error.openDirectoryWithDetail',
      backendWrapperKeys: [
        'driver_manager.backend.error.create_directory_failed',
        'driver_manager.backend.error.open_directory_failed',
      ],
      expected: t('driver.modal.error.openDirectoryWithDetail', { detail: 'connect timed out' }),
    },
    {
      name: 'remove driver',
      rawMessage: catalogT('zh-CN', 'driver_manager.backend.error.remove_package_failed', { detail: 'connect timed out' }),
      fallbackMessage: t('driver.modal.error.removeDriver', { name: 'MariaDB' }),
      detailParams: { name: 'MariaDB' },
      backendWrapperKeys: ['driver_manager.backend.error.remove_package_failed'],
      expected: `${t('driver.modal.error.removeDriver', { name: 'MariaDB' })}: connect timed out`,
    },
  ])('rewraps placeholder-based backend wrappers while preserving raw detail for $name', async ({
    rawMessage,
    fallbackMessage,
    detailKey,
    detailParams,
    backendWrapperKeys,
    expected,
  }) => {
    const { resolveDriverErrorMessageText } = await import('../components/DriverManagerModal');

    expect(resolveDriverErrorMessageText(
      rawMessage,
      fallbackMessage,
      detailKey,
      detailParams,
      backendWrapperKeys,
    )).toBe(expected);
  }, 15000);

  it('exposes only functional guidance APIs to avoid freezing the current language', async () => {
    const guidance = await import('./driverImportGuidance');

    expect(guidance).not.toHaveProperty('DRIVER_LOCAL_IMPORT_BUTTON_LABEL');
    expect(guidance).not.toHaveProperty('DRIVER_LOCAL_IMPORT_DIRECTORY_HELP');
    expect(guidance).not.toHaveProperty('DRIVER_LOCAL_IMPORT_SINGLE_FILE_HELP');
    expect(guidance).not.toHaveProperty('CUSTOM_CONNECTION_DRIVER_HELP');
  });

  it.each(['zh-CN', 'en-US'] as const)('reuses driver_manager action label for local import button in %s', (language) => {
    expect(getDriverLocalImportButtonLabel(language)).toBe(t('driver_manager.action.import_package', undefined, language));
  });

  it.each(['zh-CN', 'en-US'] as const)('keeps driver_manager import guidance helpers in %s', (language) => {
    expect(getDriverLocalImportDirectoryHelp(language)).toBe(t('driver_manager.import.directory_help', undefined, language));
    expect(getDriverLocalImportSingleFileHelp(language)).toBe(t('driver_manager.import.single_file_help', undefined, language));
    expect(getDriverLocalImportSingleFileHelp(language)).toContain('JDBC Jar');
  });

  it.each(['zh-CN', 'en-US'] as const)('documents custom driver aliases for kingbase and related fallbacks in %s', (language) => {
    const helpText = getCustomConnectionDriverHelp(language);

    expect(helpText).toContain('kingbase8');
    expect(helpText).toContain('pgx');
    expect(helpText).toContain('open_gauss');
    expect(helpText).toContain('oceanbase');
    expect(helpText).toContain('clickhouse');
    expect(helpText).toContain('jdbc:clickhouse://');
    expect(helpText).toContain('Go database/sql');
    expect(helpText).toContain('ODBC/JDBC');
    expect(helpText).toContain('JDBC Jar');
  });
});
