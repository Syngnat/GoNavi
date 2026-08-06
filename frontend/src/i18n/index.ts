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

const catalogAliases: Record<string, CatalogAlias> = {
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
