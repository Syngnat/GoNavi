import { defineSettingsCenterPageEntries as page, type SettingsCenterSearchEntry } from '../settingsCenterSearchEntries';

/** Settings inside the 服务配置 pages except AI (see ai.ts). */
export const SERVICES_SEARCH_ENTRIES: ReadonlyArray<SettingsCenterSearchEntry> = [
  ...page('services', 'proxy', [
    'app.proxy.type',
    'app.proxy.host',
    'app.proxy.port',
    'app.proxy.username_optional',
    'app.proxy.password_optional',
    'app.proxy.clear_saved_password',
    'app.proxy.test.target_label',
    'app.proxy.test.action',
    'app.proxy.apply',
    'app.proxy.reset',
  ]).map((entry) => (
    entry.labelKey === 'app.proxy.type'
      ? { ...entry, aliasKeys: ['app.proxy.type_socks5', 'app.proxy.type_http'] }
      : entry
  )),

  ...page('services', 'download-source', [
    'app.download_source.option.cst',
    'app.download_source.option.bero',
    'app.download_source.option.github',
  ]),

  ...page('services', 'web-auth', [
    'app.settings.web_auth.password.title',
    'app.settings.web_auth.password.current_label',
    'app.settings.web_auth.password.code_label',
    'app.settings.web_auth.password.new_label',
    'app.settings.web_auth.password.confirm_label',
    'app.settings.web_auth.password.submit',
    'app.settings.web_auth.status.auth_required',
    'app.settings.web_auth.status.two_factor',
    'app.settings.web_auth.status.recovery_codes',
    'app.settings.web_auth.status.idle_timeout',
    'app.settings.web_auth.status.absolute_timeout',
    'app.settings.web_auth.status.remember_days',
  ]),

  ...page('services', 'cloud-backup', [
    'app.cloud_backup.enabled',
    'app.cloud_backup.provider',
    'app.cloud_backup.webdav.endpoint',
    'app.cloud_backup.webdav.file_path',
    'app.cloud_backup.webdav.username',
    'app.cloud_backup.webdav.password',
    'app.cloud_backup.s3.endpoint',
    'app.cloud_backup.s3.object_key',
    'app.cloud_backup.s3.bucket',
    'app.cloud_backup.s3.region',
    'app.cloud_backup.s3.access_key',
    'app.cloud_backup.s3.secret_key',
    'app.cloud_backup.encryption_password',
    'app.cloud_backup.schedule',
    'app.cloud_backup.backup_scope',
    'app.cloud_backup.action.sync',
    'app.cloud_backup.action.check',
    'app.cloud_backup.action.restore',
  ]),
];
