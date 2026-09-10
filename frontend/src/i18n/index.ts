import {
  t as catalogTranslate,
  type I18nKey,
} from "./catalog";
import {
  DEFAULT_LANGUAGE,
  LANGUAGE_PREFERENCES,
  SUPPORTED_LANGUAGES,
  normalizeLanguage,
  resolveLanguage as resolveLanguageWithSystem,
} from "./resolveLanguage";
import type {
  I18nParams,
  LanguagePreference,
  SupportedLanguage,
} from "./types";
import { translate as legacyTranslate } from "../../../shared/i18n/translate";

let currentLanguage: SupportedLanguage = DEFAULT_LANGUAGE;

type CatalogAlias = {
  aliasKey: string;
  mapParams?: (params?: I18nParams) => I18nParams | undefined;
};

const NON_LEGACY_ALIAS_LANGUAGES = new Set<SupportedLanguage>([
  "zh-TW",
  "ja-JP",
  "de-DE",
  "ru-RU",
]);

const withRenamedParam = (
  params: I18nParams | undefined,
  from: string,
  to: string,
): I18nParams | undefined => {
  if (!params || !(from in params)) return params;
  const { [from]: value, ...rest } = params;
  return { ...rest, [to]: value };
};

const driverModalCatalogAliases: Record<string, CatalogAlias> = {
  "driver.modal.batch.action.default": { aliasKey: "driver_manager.batch.action.default" },
  "driver.modal.batch.action.installAll": { aliasKey: "driver_manager.batch.action.install_all" },
  "driver.modal.batch.action.reinstallUpdates": { aliasKey: "driver_manager.batch.action.reinstall_updates" },
  "driver.modal.batch.action.removeAll": { aliasKey: "driver_manager.batch.action.remove_all" },
  "driver.modal.batch.actionResult.failed": { aliasKey: "driver_manager.batch.result.failed" },
  "driver.modal.batch.actionResult.partial": { aliasKey: "driver_manager.batch.result.partial" },
  "driver.modal.batch.actionResult.success": { aliasKey: "driver_manager.batch.result.success" },
  "driver.modal.batch.current": { aliasKey: "driver_manager.batch.current" },
  "driver.modal.batch.directoryImport.failed": {
    aliasKey: "driver_manager.message.directory_import_failed",
    mapParams: (params) => withRenamedParam(params, "force", "mode"),
  },
  "driver.modal.batch.directoryImport.partial": {
    aliasKey: "driver_manager.message.directory_import_completed_with_failure",
    mapParams: (params) => withRenamedParam(params, "force", "mode"),
  },
  "driver.modal.batch.directoryImport.success": {
    aliasKey: "driver_manager.message.directory_import_completed",
    mapParams: (params) => withRenamedParam(params, "force", "mode"),
  },
  "driver.modal.batch.driverCompleted": { aliasKey: "driver_manager.batch.driver.completed" },
  "driver.modal.batch.driverFailed": { aliasKey: "driver_manager.batch.driver.failed" },
  "driver.modal.batch.driverRemoveFailed": { aliasKey: "driver_manager.batch.driver.remove_failed" },
  "driver.modal.batch.driverRemoving": { aliasKey: "driver_manager.batch.driver.removing" },
  "driver.modal.batch.driverRunning": { aliasKey: "driver_manager.batch.driver.running" },
  "driver.modal.batch.driverSkipped": { aliasKey: "driver_manager.batch.driver.skipped" },
  "driver.modal.batch.failed": { aliasKey: "driver_manager.batch.failed" },
  "driver.modal.batch.forceOverwriteTip": { aliasKey: "driver_manager.message.overwrite_suffix" },
  "driver.modal.batch.prepare": { aliasKey: "driver_manager.batch.prepare" },
  "driver.modal.batch.prepareRemoveAll": { aliasKey: "driver_manager.batch.prepare_remove_all" },
  "driver.modal.batch.processed": { aliasKey: "driver_manager.batch.processed" },
  "driver.modal.batch.removeAll.failed": { aliasKey: "driver_manager.batch.remove_all.failed" },
  "driver.modal.batch.removeAll.partial": { aliasKey: "driver_manager.batch.remove_all.partial" },
  "driver.modal.batch.removeAll.success": { aliasKey: "driver_manager.batch.remove_all.success" },
  "driver.modal.batch.running": { aliasKey: "driver_manager.batch.running" },
  "driver.modal.batch.skip.dedupe": { aliasKey: "driver_manager.message.skip.dedupe" },
  "driver.modal.batch.skip.slim": { aliasKey: "driver_manager.message.skip.slim" },
  "driver.modal.batch.skip.summary": {
    aliasKey: "driver_manager.message.skip_suffix",
    mapParams: (params) => withRenamedParam(params, "summary", "items"),
  },
  "driver.modal.batch.skipped": { aliasKey: "driver_manager.batch.skipped" },
  "driver.modal.batch.success": { aliasKey: "driver_manager.batch.success" },
  "driver.modal.card.action.install": { aliasKey: "driver_manager.action.install_enable" },
  "driver.modal.card.action.reinstall": { aliasKey: "driver_manager.action.reinstall" },
  "driver.modal.card.action.remove": { aliasKey: "driver_manager.action.remove" },
  "driver.modal.card.affectedConnections": { aliasKey: "driver_manager.backend.status.affected_connections" },
  "driver.modal.card.builtInUsable": { aliasKey: "driver_manager.package_size.built_in" },
  "driver.modal.card.enabled": { aliasKey: "driver_manager.status.enabled" },
  "driver.modal.card.expand": { aliasKey: "driver_manager.action.expand" },
  "driver.modal.card.expandReason": { aliasKey: "driver_manager.action.expand_reason" },
  "driver.modal.card.fullOnly": { aliasKey: "driver_manager.status.full_required" },
  "driver.modal.card.installed": { aliasKey: "driver_manager.status.installed" },
  "driver.modal.card.installing": { aliasKey: "driver_manager.status.installing_percent" },
  "driver.modal.card.mongodbVersionHint": { aliasKey: "driver_manager.version.mongodb_hint" },
  "driver.modal.card.noInstallNeeded": { aliasKey: "driver_manager.status.no_install_needed" },
  "driver.modal.card.notEnabled": { aliasKey: "driver_manager.backend.status.optional_disabled_generic" },
  "driver.modal.card.packageSize": { aliasKey: "driver_manager.label.package_size" },
  "driver.modal.card.progressLabel": { aliasKey: "driver_manager.column.progress" },
  "driver.modal.card.status.builtIn": { aliasKey: "driver_manager.backend.status.built_in_available" },
  "driver.modal.card.status.expectedRevision": { aliasKey: "driver_manager.backend.status.expected_revision" },
  "driver.modal.card.status.installedPending": { aliasKey: "driver_manager.backend.status.installed_pending" },
  "driver.modal.card.status.installedPendingVersion": { aliasKey: "driver_manager.backend.status.installed_pending_with_version" },
  "driver.modal.card.status.installedRevision": { aliasKey: "driver_manager.backend.status.installed_revision" },
  "driver.modal.card.status.needsUpdate": { aliasKey: "driver_manager.backend.status.needs_update" },
  "driver.modal.card.status.notEnabled": { aliasKey: "driver_manager.backend.status.optional_disabled_generic" },
  "driver.modal.card.status.notEnabledVersion": { aliasKey: "driver_manager.backend.status.optional_disabled_with_version" },
  "driver.modal.card.status.runtimeAvailable": { aliasKey: "driver_manager.backend.status.optional_enabled" },
  "driver.modal.card.version": { aliasKey: "driver_manager.label.version" },
  "driver.modal.card.versionLabel": { aliasKey: "driver_manager.column.version" },
  "driver.modal.card.versionPlaceholder.load": { aliasKey: "driver_manager.version.placeholder.load_on_expand" },
  "driver.modal.card.versionPlaceholder.select": { aliasKey: "driver_manager.version.placeholder.select" },
  "driver.modal.card.versionSizeCalculating": { aliasKey: "driver_manager.status.calculating" },
  "driver.modal.confirm.removeAll.content": { aliasKey: "driver_manager.confirm.remove_all.content" },
  "driver.modal.confirm.removeAll.ok": { aliasKey: "driver_manager.confirm.remove_all.ok" },
  "driver.modal.confirm.removeAll.title": { aliasKey: "driver_manager.confirm.remove_all.title" },
  "driver.modal.confirm.reinstallInUse.content": { aliasKey: "driver_manager.confirm.reinstall_in_use.content" },
  "driver.modal.confirm.reinstallInUse.ok": { aliasKey: "driver_manager.confirm.reinstall_in_use.ok" },
  "driver.modal.confirm.reinstallInUse.title": { aliasKey: "driver_manager.confirm.reinstall_in_use.title" },
  "driver.modal.empty.noData": { aliasKey: "driver_manager.empty.default" },
  "driver.modal.empty.noMatch": { aliasKey: "driver_manager.empty.search" },
  "driver.modal.error.installDriver": { aliasKey: "driver_manager.message.install_failed" },
  "driver.modal.error.invalidLocalImport": { aliasKey: "driver_manager.message.local_path_required" },
  "driver.modal.error.invalidPackageDirectory": { aliasKey: "driver_manager.message.local_directory_required" },
  "driver.modal.error.invalidPackageFile": { aliasKey: "driver_manager.message.local_file_required" },
  "driver.modal.error.localImportDriver": { aliasKey: "driver_manager.message.local_import_failed" },
  "driver.modal.error.networkCheck": { aliasKey: "driver_manager.message.network_check_failed" },
  "driver.modal.error.networkCheckWithDetail": { aliasKey: "driver_manager.message.network_check_failed_detail" },
  "driver.modal.error.openDirectory": { aliasKey: "driver_manager.message.open_directory_failed" },
  "driver.modal.error.openDirectoryWithDetail": { aliasKey: "driver_manager.message.open_directory_failed_detail" },
  "driver.modal.error.removeDriver": { aliasKey: "driver_manager.message.remove_failed" },
  "driver.modal.error.selectPackageDirectory": { aliasKey: "driver_manager.message.select_local_directory_failed" },
  "driver.modal.error.selectPackageFile": { aliasKey: "driver_manager.message.select_local_file_failed" },
  "driver.modal.error.statusFetch": { aliasKey: "driver_manager.message.load_status_failed" },
  "driver.modal.error.statusFetchWithDetail": { aliasKey: "driver_manager.message.load_status_failed_detail" },
  "driver.modal.error.unknown": { aliasKey: "common.unknown" },
  "driver.modal.error.versionList": { aliasKey: "driver_manager.message.load_version_failed" },
  "driver.modal.error.versionListLoad": { aliasKey: "driver_manager.message.load_version_failed_detail" },
  "driver.modal.footer.background": { aliasKey: "app.about.action.hide_to_background" },
  "driver.modal.footer.close": { aliasKey: "driver_manager.action.close" },
  "driver.modal.footer.networkCheck": { aliasKey: "driver_manager.action.network_check" },
  "driver.modal.footer.refresh": { aliasKey: "driver_manager.action.refresh" },
  "driver.modal.header.description.agent": { aliasKey: "driver_manager.description.agent_reinstall" },
  "driver.modal.header.description.install": { aliasKey: "driver_manager.description.install_required" },
  "driver.modal.info.noImportableDrivers": { aliasKey: "driver_manager.message.no_external_drivers_to_import" },
  "driver.modal.info.noInstallableDrivers": { aliasKey: "driver_manager.message.no_external_drivers_to_install" },
  "driver.modal.info.noReinstallableDrivers": { aliasKey: "driver_manager.message.no_external_drivers_to_reinstall" },
  "driver.modal.info.noRemovableDrivers": { aliasKey: "driver_manager.message.no_external_drivers_to_remove" },
  "driver.modal.localSource.directory": { aliasKey: "driver_manager.local_source.directory" },
  "driver.modal.localSource.file": { aliasKey: "driver_manager.local_source.file" },
  "driver.modal.operationLog.autoInstall.done": { aliasKey: "driver_manager.log.done_auto_install" },
  "driver.modal.operationLog.autoInstall.slimSkipped": { aliasKey: "driver_manager.log.skip_slim_build" },
  "driver.modal.operationLog.autoInstall.start": { aliasKey: "driver_manager.log.start_auto_install" },
  "driver.modal.operationLog.directoryImport.forceOverwrite": { aliasKey: "driver_manager.log.force_overwrite_reinstall" },
  "driver.modal.operationLog.directoryImport.skipInstalled": { aliasKey: "driver_manager.log.skip_installed_dedupe" },
  "driver.modal.operationLog.directoryImport.slimSkipped": { aliasKey: "driver_manager.log.skip_slim_build" },
  "driver.modal.operationLog.localImport.done": { aliasKey: "driver_manager.log.done_local_import" },
  "driver.modal.operationLog.localImport.start": { aliasKey: "driver_manager.log.start_local_import" },
  "driver.modal.operationLog.remove.done": { aliasKey: "driver_manager.log.done_remove" },
  "driver.modal.operationLog.remove.start": { aliasKey: "driver_manager.log.start_remove" },
  "driver.modal.operationLog.versionTip": { aliasKey: "driver_manager.version.inline_suffix" },
  "driver.modal.progress.install.start": { aliasKey: "driver_manager.message.install_start" },
  "driver.modal.progress.localImport.start": { aliasKey: "driver_manager.message.local_import_start" },
  "driver.modal.punctuation.comma": { aliasKey: "driver_manager.punctuation.list_separator" },
  "driver.modal.search.builtIn": { aliasKey: "driver_manager.search.built_in" },
  "driver.modal.search.external": { aliasKey: "driver_manager.search.external" },
  "driver.modal.search.reinstallRecommended": { aliasKey: "driver_manager.search.reinstall_recommended" },
  "driver.modal.stats.enabled": { aliasKey: "driver_manager.status.enabled" },
  "driver.modal.stats.needsUpdate": { aliasKey: "driver_manager.status.reinstall_needed" },
  "driver.modal.stats.notEnabled": { aliasKey: "driver_manager.backend.status.optional_disabled_generic" },
  "driver.modal.stats.total": { aliasKey: "security_update.settings.summary.total" },
  "driver.modal.status.refreshing": { aliasKey: "driver_manager.status.refreshing" },
  "driver.modal.success.installDriver": { aliasKey: "driver_manager.message.install_success" },
  "driver.modal.success.localImportDriver": { aliasKey: "driver_manager.message.local_import_success" },
  "driver.modal.success.removeDriver": { aliasKey: "driver_manager.message.remove_success" },
  "driver.modal.summary.match": {
    aliasKey: "driver_manager.filter_summary.match",
    mapParams: (params) => withRenamedParam(params, "matched", "filtered"),
  },
  "driver.modal.summary.total": {
    aliasKey: "driver_manager.filter_summary.total",
    mapParams: (params) => withRenamedParam(params, "count", "total"),
  },
  "driver.modal.title": { aliasKey: "driver_manager.title" },
  "driver.modal.toolbar.importDirectory": { aliasKey: "driver_manager.action.import_directory" },
  "driver.modal.toolbar.importDirectoryOverwrite": { aliasKey: "driver_manager.action.import_directory_overwrite" },
  "driver.modal.toolbar.installAll": { aliasKey: "driver_manager.batch.action.install_all" },
  "driver.modal.toolbar.openDirectory": { aliasKey: "driver_manager.action.open_directory" },
  "driver.modal.toolbar.reinstallUpdates": { aliasKey: "driver_manager.batch.action.reinstall_updates" },
  "driver.modal.toolbar.removeAll": { aliasKey: "driver_manager.batch.action.remove_all" },
  "driver.modal.toolbar.searchPlaceholder": { aliasKey: "driver_manager.search.placeholder" },
  "driver.modal.version.default": { aliasKey: "driver_manager.version.default" },
  "driver.modal.version.group.other": { aliasKey: "driver_manager.version.group.other" },
  "driver.modal.version.group.year": { aliasKey: "driver_manager.version.group.year" },
  "driver.modal.version.tip": { aliasKey: "driver_manager.version.inline_suffix" },
};

const catalogAliases: Record<string, CatalogAlias> = {
  ...driverModalCatalogAliases,
  "connection_modal.title.step1": {
    aliasKey: "connection_modal.title.select_type",
  },
  "connection_modal.description.step1": {
    aliasKey: "connection_modal.title.select_type_description",
  },
  "connection_modal.typeWarning.unavailable": {
    aliasKey: "connection_modal.message.driver_unavailable_title",
  },
  "connection_modal.driver.installAction": {
    aliasKey: "connection_modal.action.open_driver_manager",
  },
  "connection_modal.driver.unavailableTitle": {
    aliasKey: "connection_modal.message.driver_unavailable_title",
  },
  "connection_modal.driver.unavailableFallback": {
    aliasKey: "connection_modal.message.driver_not_enabled_with_name",
  },
  "connection_modal.driver.unavailableAlert": {
    aliasKey: "connection_modal.message.current_driver_not_enabled",
  },
  "connection_modal.field.driver.label": {
    aliasKey: "connection_modal.field.driver_name",
  },
  "connection_modal.field.driver.required": {
    aliasKey: "connection_modal.validation.driver_name_required",
  },
  "connection_modal.field.dsn.label": {
    aliasKey: "connection_modal.field.dsn",
  },
  "connection_modal.field.dsn.clearSaved": {
    aliasKey: "connection_modal.secret.clear_saved_dsn",
  },
  "connection_modal.field.dsn.savedDescription": {
    aliasKey: "connection_modal.secret.saved_dsn_description",
  },
  "connection_modal.uri.feedback.generated": {
    aliasKey: "connection_modal.message.uri_generated",
  },
  "connection_modal.filePicker.databaseFailure": {
    aliasKey: "connection_modal.message.select_database_file_failed",
    mapParams: (params) =>
      params
        ? {
            error: params.detail,
          }
        : params,
  },
  "connection_modal.jvm.jmx.host.label": {
    aliasKey: "connection_modal.jvm.jmx_host_override_optional",
  },
  "connection_modal.jvm.jmx.port.label": {
    aliasKey: "connection_modal.jvm.jmx_port",
  },
  "connection_modal.jvm.jmx.username.label": {
    aliasKey: "connection_modal.jvm.jmx_username_optional",
  },
  "connection_modal.jvm.endpoint.address.label": {
    aliasKey: "connection_modal.jvm.endpoint_url",
  },
  "connection_modal.jvm.agent.address.label": {
    aliasKey: "connection_modal.jvm.agent_url",
  },
  "connection_modal.jvm.diagnostic.transport.label": {
    aliasKey: "connection_modal.jvm.diagnostic_transport",
  },
  "connection_modal.jvm.diagnostic.transport.agentBridge.description": {
    aliasKey: "connection_modal.jvm.diagnostic.agent_bridge_description",
  },
  "connection_modal.jvm.diagnostic.command.observe.label": {
    aliasKey: "connection_modal.jvm.diagnostic.observe_commands",
  },
  "connection_modal.jvm.diagnostic.command.observe.description": {
    aliasKey: "connection_modal.jvm.diagnostic.observe_commands_description",
  },
  "connection_modal.jvm.diagnostic.command.trace.label": {
    aliasKey: "connection_modal.jvm.diagnostic.trace_commands",
  },
  "connection_modal.jvm.diagnostic.command.trace.description": {
    aliasKey: "connection_modal.jvm.diagnostic.trace_commands_description",
  },
  "connection_modal.jvm.diagnostic.command.mutating.label": {
    aliasKey: "connection_modal.jvm.diagnostic.mutating_commands",
  },
  "connection_modal.jvm.diagnostic.command.mutating.description": {
    aliasKey: "connection_modal.jvm.diagnostic.mutating_commands_description",
  },
  "connection_modal.field.defaultDatabase.label": {
    aliasKey: "connection_modal.field.default_database_optional",
  },
  "connection_modal.field.defaultDatabase.help": {
    aliasKey: "connection_modal.help.default_database",
  },
  "connection_modal.field.serviceName.label": {
    aliasKey: "connection_modal.field.service_name",
  },
  "connection_modal.field.serviceName.required": {
    aliasKey: "connection_modal.validation.oracle_service_required",
  },
  "connection_modal.field.serviceName.help": {
    aliasKey: "connection_modal.help.oracle_service_name",
  },
  "connection_modal.field.oracleMode.label": {
    aliasKey: "connection_modal.field.oracle_mode.label",
  },
  "connection_modal.field.oracleMode.service": {
    aliasKey: "connection_modal.field.oracle_mode.service",
  },
  "connection_modal.field.oracleMode.sid": {
    aliasKey: "connection_modal.field.oracle_mode.sid",
  },
  "connection_modal.field.sid.label": {
    aliasKey: "connection_modal.field.sid.label",
  },
  "connection_modal.field.sid.required": {
    aliasKey: "connection_modal.field.sid.required",
  },
  "connection_modal.field.sid.placeholder": {
    aliasKey: "connection_modal.field.sid.placeholder",
  },
};

export const resolveLanguage = (
  preference: LanguagePreference | SupportedLanguage | string | undefined,
  systemLanguages: readonly string[] = [],
): SupportedLanguage => resolveLanguageWithSystem(preference, systemLanguages);

export const setCurrentLanguage = (
  language: LanguagePreference | SupportedLanguage | string | undefined,
  systemLanguages: readonly string[] = [],
): SupportedLanguage => {
  currentLanguage = resolveLanguage(language, systemLanguages);
  return currentLanguage;
};

export const getCurrentLanguage = (): SupportedLanguage => currentLanguage;

const toCatalogKey = (key: string): string => {
  const actionAliases: Record<string, string> = {
    "common.action.cancel": "common.cancel",
    "common.action.close": "common.close",
    "common.action.confirm": "common.confirm",
    "common.action.continue": "common.continue",
    "common.action.delete": "common.delete",
    "common.action.save": "common.save",
  };
  if (actionAliases[key]) {
    return actionAliases[key];
  }
  if (key.startsWith("connection.modal.")) {
    return `connection_modal.${key.slice("connection.modal.".length)}`;
  }
  if (key.startsWith("driver.manager.")) {
    return `driver_manager.${key.slice("driver.manager.".length)}`;
  }
  return key;
};

const translateCatalogAlias = (
  language: SupportedLanguage,
  catalogKey: string,
  params?: I18nParams,
): string | null => {
  if (!NON_LEGACY_ALIAS_LANGUAGES.has(language)) {
    return null;
  }
  const alias = catalogAliases[catalogKey];
  if (!alias) {
    return null;
  }
  const translated = catalogTranslate(
    language,
    alias.aliasKey as I18nKey,
    alias.mapParams ? alias.mapParams(params) : params,
  );
  return translated === alias.aliasKey ? null : translated;
};

export const t = (
  key: string,
  params?: I18nParams,
  language: SupportedLanguage | string = currentLanguage,
): string => {
  const resolvedLanguage = normalizeLanguage(language) ?? DEFAULT_LANGUAGE;
  const catalogKey = toCatalogKey(key);
  const translated = catalogTranslate(resolvedLanguage, catalogKey as I18nKey, params);
  if (translated !== catalogKey) {
    return translated;
  }
  const aliasTranslated = translateCatalogAlias(resolvedLanguage, catalogKey, params);
  if (aliasTranslated) {
    return aliasTranslated;
  }
  return legacyTranslate(key, params, resolvedLanguage);
};

export {
  DEFAULT_LANGUAGE,
  LANGUAGE_PREFERENCES,
  SUPPORTED_LANGUAGES,
  type I18nParams,
  type LanguagePreference,
  type SupportedLanguage,
};
