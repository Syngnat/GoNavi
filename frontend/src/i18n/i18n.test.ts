import { describe, expect, it } from "vitest";

import { t as catalogTranslate } from "./catalog";
import {
  DEFAULT_LANGUAGE,
  LANGUAGE_PREFERENCES,
  SUPPORTED_LANGUAGES,
  resolveLanguage,
  t,
} from "./index";

type LocalizedExpectation = {
  key: string;
  catalogKey: string;
  params?: Record<string, string>;
  catalogParams?: Record<string, string>;
};

const remainingConnectionModalSliceExpectations: LocalizedExpectation[] = [
  {
    key: "connection.modal.step1.group.all",
    catalogKey: "connection_modal.step1.group.all",
  },
  {
    key: "connection.modal.step1.group.relational",
    catalogKey: "connection_modal.step1.group.relational",
  },
  {
    key: "connection.modal.step1.group.domestic",
    catalogKey: "connection_modal.step1.group.domestic",
  },
  {
    key: "connection.modal.step1.group.nosql",
    catalogKey: "connection_modal.step1.group.nosql",
  },
  {
    key: "connection.modal.step1.group.timeseries",
    catalogKey: "connection_modal.step1.group.timeseries",
  },
  {
    key: "connection.modal.step1.group.other",
    catalogKey: "connection_modal.step1.group.other",
  },
  {
    key: "connection.modal.step1.hint.jvm",
    catalogKey: "connection_modal.step1.hint.jvm",
  },
  {
    key: "connection.modal.step1.hint.custom",
    catalogKey: "connection_modal.step1.hint.custom",
  },
  {
    key: "connection.modal.step1.hint.redis",
    catalogKey: "connection_modal.step1.hint.redis",
  },
  {
    key: "connection.modal.step1.hint.mongodb",
    catalogKey: "connection_modal.step1.hint.mongodb",
  },
  {
    key: "connection.modal.step1.hint.milvus",
    catalogKey: "connection_modal.step1.hint.milvus",
  },
  {
    key: "connection.modal.step1.hint.oceanBase",
    catalogKey: "connection_modal.step1.hint.oceanBase",
  },
  {
    key: "connection.modal.step1.hint.file",
    catalogKey: "connection_modal.step1.hint.file",
  },
  {
    key: "connection.modal.step1.hint.standard",
    catalogKey: "connection_modal.step1.hint.standard",
  },
  {
    key: "connection.modal.step1.search.empty",
    catalogKey: "connection_modal.step1.search.empty",
  },
  {
    key: "connection.modal.step1.search.placeholder",
    catalogKey: "connection_modal.step1.search.placeholder",
  },
  {
    key: "connection.modal.field.driver.label",
    catalogKey: "connection_modal.field.driver_name",
  },
  {
    key: "connection.modal.field.driver.required",
    catalogKey: "connection_modal.validation.driver_name_required",
  },
  {
    key: "connection.modal.field.driver.placeholder",
    catalogKey: "connection_modal.field.driver.placeholder",
  },
  {
    key: "connection.modal.field.dsn.label",
    catalogKey: "connection_modal.field.dsn",
  },
  {
    key: "connection.modal.field.dsn.clearSaved",
    catalogKey: "connection_modal.secret.clear_saved_dsn",
  },
  {
    key: "connection.modal.field.dsn.savedDescription",
    catalogKey: "connection_modal.secret.saved_dsn_description",
  },
  {
    key: "connection.modal.field.dsn.placeholder",
    catalogKey: "connection_modal.field.dsn.placeholder",
  },
  {
    key: "connection.modal.section.readOnly.title",
    catalogKey: "connection_modal.section.readOnly.title",
  },
  {
    key: "connection.modal.section.readOnly.description",
    catalogKey: "connection_modal.section.readOnly.description",
  },
  {
    key: "connection.modal.field.readOnly.label",
    catalogKey: "connection_modal.field.readOnly.label",
  },
  {
    key: "connection.modal.field.readOnly.help",
    catalogKey: "connection_modal.field.readOnly.help",
  },
  {
    key: "connection.modal.field.readOnly.status.enabledCount",
    catalogKey: "connection_modal.field.readOnly.status.enabledCount",
    params: { count: "2" },
  },
  {
    key: "connection.modal.field.readOnly.compatibility",
    catalogKey: "connection_modal.field.readOnly.compatibility",
  },
  {
    key: "connection.modal.field.readOnly.option.dataEdit.label",
    catalogKey: "connection_modal.field.readOnly.option.dataEdit.label",
  },
  {
    key: "connection.modal.field.readOnly.option.dataEdit.help",
    catalogKey: "connection_modal.field.readOnly.option.dataEdit.help",
  },
  {
    key: "connection.modal.field.readOnly.option.structureEdit.label",
    catalogKey: "connection_modal.field.readOnly.option.structureEdit.label",
  },
  {
    key: "connection.modal.field.readOnly.option.structureEdit.help",
    catalogKey: "connection_modal.field.readOnly.option.structureEdit.help",
  },
  {
    key: "connection.modal.field.readOnly.option.scriptExecution.label",
    catalogKey: "connection_modal.field.readOnly.option.scriptExecution.label",
  },
  {
    key: "connection.modal.field.readOnly.option.scriptExecution.help",
    catalogKey: "connection_modal.field.readOnly.option.scriptExecution.help",
  },
  {
    key: "connection.modal.field.readOnly.option.dataImport.label",
    catalogKey: "connection_modal.field.readOnly.option.dataImport.label",
  },
  {
    key: "connection.modal.field.readOnly.option.dataImport.help",
    catalogKey: "connection_modal.field.readOnly.option.dataImport.help",
  },
  {
    key: "connection.modal.field.readOnly.summary.title",
    catalogKey: "connection_modal.field.readOnly.summary.title",
  },
  {
    key: "connection.modal.field.readOnly.summary.selected",
    catalogKey: "connection_modal.field.readOnly.summary.selected",
    params: { count: "2" },
  },
  {
    key: "connection.modal.field.readOnly.summary.empty",
    catalogKey: "connection_modal.field.readOnly.summary.empty",
  },
  {
    key: "driver.guidance.customConnectionDriverHelp",
    catalogKey: "driver.guidance.customConnectionDriverHelp",
  },
  {
    key: "connection.modal.uri.feedback.generated",
    catalogKey: "connection_modal.message.uri_generated",
  },
  {
    key: "connection.modal.filePicker.databaseFailure",
    catalogKey: "connection_modal.message.select_database_file_failed",
    params: { detail: "backend raw error: /tmp/app.db" },
    catalogParams: { error: "backend raw error: /tmp/app.db" },
  },
  {
    key: "connection.modal.jvm.jmx.host.label",
    catalogKey: "connection_modal.jvm.jmx_host_override_optional",
  },
  {
    key: "connection.modal.jvm.jmx.port.label",
    catalogKey: "connection_modal.jvm.jmx_port",
  },
  {
    key: "connection.modal.jvm.jmx.username.label",
    catalogKey: "connection_modal.jvm.jmx_username_optional",
  },
  {
    key: "connection.modal.jvm.endpoint.address.label",
    catalogKey: "connection_modal.jvm.endpoint_url",
  },
  {
    key: "connection.modal.jvm.agent.address.label",
    catalogKey: "connection_modal.jvm.agent_url",
  },
  {
    key: "connection.modal.jvm.diagnostic.transport.label",
    catalogKey: "connection_modal.jvm.diagnostic_transport",
  },
  {
    key: "connection.modal.jvm.diagnostic.transport.agentBridge.description",
    catalogKey: "connection_modal.jvm.diagnostic.agent_bridge_description",
  },
  {
    key: "connection.modal.jvm.diagnostic.command.observe.label",
    catalogKey: "connection_modal.jvm.diagnostic.observe_commands",
  },
  {
    key: "connection.modal.jvm.diagnostic.command.observe.description",
    catalogKey: "connection_modal.jvm.diagnostic.observe_commands_description",
  },
  {
    key: "connection.modal.jvm.diagnostic.command.trace.label",
    catalogKey: "connection_modal.jvm.diagnostic.trace_commands",
  },
  {
    key: "connection.modal.jvm.diagnostic.command.trace.description",
    catalogKey: "connection_modal.jvm.diagnostic.trace_commands_description",
  },
  {
    key: "connection.modal.jvm.diagnostic.command.mutating.label",
    catalogKey: "connection_modal.jvm.diagnostic.mutating_commands",
  },
  {
    key: "connection.modal.jvm.diagnostic.command.mutating.description",
    catalogKey: "connection_modal.jvm.diagnostic.mutating_commands_description",
  },
  {
    key: "connection.modal.field.clickHouseProtocol.auto",
    catalogKey: "connection_modal.field.clickHouseProtocol.auto",
  },
  {
    key: "connection.modal.field.oceanBaseProtocol.label",
    catalogKey: "connection_modal.field.oceanBaseProtocol.label",
  },
  {
    key: "connection.modal.field.oceanBaseProtocol.help.primary",
    catalogKey: "connection_modal.field.oceanBaseProtocol.help.primary",
  },
  {
    key: "connection.modal.field.oceanBaseProtocol.help.connectionAttributes",
    catalogKey: "connection_modal.field.oceanBaseProtocol.help.connectionAttributes",
    params: {
      attributes: "connectionAttributes=key1:value1,key2:value2",
    },
  },
  {
    key: "connection.modal.field.defaultDatabase.label",
    catalogKey: "connection_modal.field.default_database_optional",
  },
  {
    key: "connection.modal.field.defaultDatabase.help",
    catalogKey: "connection_modal.help.default_database",
  },
  {
    key: "connection.modal.field.defaultDatabase.placeholder",
    catalogKey: "connection_modal.field.defaultDatabase.placeholder",
  },
  {
    key: "connection.modal.field.serviceName.label",
    catalogKey: "connection_modal.field.service_name",
  },
  {
    key: "connection.modal.field.serviceName.required",
    catalogKey: "connection_modal.validation.oracle_service_required",
  },
  {
    key: "connection.modal.field.serviceName.help",
    catalogKey: "connection_modal.help.oracle_service_name",
  },
  {
    key: "connection.modal.field.serviceName.placeholder",
    catalogKey: "connection_modal.field.serviceName.placeholder",
  },
  {
    key: "connection.modal.field.oracleMode.label",
    catalogKey: "connection_modal.field.oracle_mode.label",
  },
  {
    key: "connection.modal.field.oracleMode.service",
    catalogKey: "connection_modal.field.oracle_mode.service",
  },
  {
    key: "connection.modal.field.oracleMode.sid",
    catalogKey: "connection_modal.field.oracle_mode.sid",
  },
  {
    key: "connection.modal.field.sid.label",
    catalogKey: "connection_modal.field.sid.label",
  },
  {
    key: "connection.modal.field.sid.required",
    catalogKey: "connection_modal.field.sid.required",
  },
  {
    key: "connection.modal.field.sid.placeholder",
    catalogKey: "connection_modal.field.sid.placeholder",
  },
];

describe("i18n", () => {
  it("exposes the complete language set while keeping existing t() compatibility", () => {
    expect(DEFAULT_LANGUAGE).toBe("en-US");
    expect(SUPPORTED_LANGUAGES).toEqual([
      "zh-CN",
      "zh-TW",
      "en-US",
      "ja-JP",
      "de-DE",
      "ru-RU",
    ]);
    expect(LANGUAGE_PREFERENCES).toEqual(["system", ...SUPPORTED_LANGUAGES]);
    expect(t("common.action.cancel", undefined, "zh-CN")).toBe("取消");
    expect(t("common.action.cancel", undefined, "en-US")).toBe("Cancel");
    expect(t("common.cancel", undefined, "de-DE")).toBe("Abbrechen");
    expect(t("connection.modal.title.create", { type: "MySQL" }, "zh-CN")).toBe(
      "新建 MySQL 连接",
    );
    expect(t("connection.modal.title.create", { type: "<raw>" }, "en-US")).toBe(
      "New <raw> connection",
    );
  });

  it("falls back to the key for missing messages and normalizes unsupported languages", () => {
    expect(t("missing.key", undefined, "en-US")).toBe("missing.key");
    expect(resolveLanguage("fr-FR")).toBe(DEFAULT_LANGUAGE);
    expect(resolveLanguage("system", ["zh-HK"])).toBe("zh-TW");
    expect(t("common.action.cancel", undefined, "fr-FR")).toBe("Cancel");
  });

  it.each(["zh-TW", "ja-JP", "de-DE", "ru-RU"] as const)(
    "keeps the remaining ConnectionModal slice keys localized in %s",
    (language) => {
      for (const expectation of remainingConnectionModalSliceExpectations) {
        expect(t(expectation.key, expectation.params, language)).toBe(
          catalogTranslate(
            language,
            expectation.catalogKey,
            expectation.catalogParams ?? expectation.params,
          ),
        );
      }
    },
  );

  it("resolves the Oracle mode keys in zh-CN and en-US (legacy messages)", () => {
    expect(
      t("connection.modal.field.oracleMode.service", undefined, "zh-CN"),
    ).toBe("服务名称");
    expect(t("connection.modal.field.oracleMode.sid", undefined, "zh-CN")).toBe(
      "SID",
    );
    expect(
      t("connection.modal.field.oracleMode.service", undefined, "en-US"),
    ).toBe("Service name");
    expect(t("connection.modal.field.oracleMode.sid", undefined, "en-US")).toBe(
      "SID",
    );
    expect(
      t("connection.modal.field.sid.required", undefined, "zh-CN"),
    ).toBe("请输入 SID");
  });
});
