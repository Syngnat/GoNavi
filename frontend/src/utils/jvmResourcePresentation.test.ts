import { describe, expect, it } from "vitest";

import {
  buildJVMActionPayloadTemplate,
  buildJVMPreviewApplyRequest,
  estimateJVMResourceEditorHeight,
  formatJVMAuditResultLabel,
  formatJVMActionSummary,
  formatJVMMetadataForDisplay,
  formatJVMRiskLevelText,
  formatJVMValueForDisplay,
  resolveJVMAuditResultColor,
  resolveJVMActionDisplay,
  resolveJVMValueEditorLanguage,
} from "./jvmResourcePresentation";

describe("jvmResourcePresentation", () => {
  it("provides a localized fallback label for built-in JVM actions", () => {
    expect(resolveJVMActionDisplay({ action: "set" }, "zh-CN")).toMatchObject({
      action: "set",
      label: "设置属性",
      description: "更新当前资源暴露的可写属性值。",
    });
    expect(resolveJVMActionDisplay({ action: "set" }, "en-US")).toMatchObject({
      action: "set",
      label: "Set property",
      description: "Update a writable property exposed by the current resource.",
    });
  });

  it("keeps provider-supplied action labels when they already exist", () => {
    expect(
      resolveJVMActionDisplay({
        action: "invoke",
        label: "执行重置",
        description: "调用 reset 操作",
      }),
    ).toEqual({
      action: "invoke",
      label: "执行重置",
      description: "调用 reset 操作",
    });
  });

  it("formats the supported action summary with both localized label and code", () => {
    expect(
      formatJVMActionSummary([
        { action: "set" },
        { action: "invoke", label: "执行重置" },
      ], "zh-CN"),
    ).toBe("设置属性（set）, 执行重置（invoke）");
    expect(formatJVMActionSummary([{ action: "set" }], "en-US")).toBe(
      "Set property（set）",
    );
  });

  it("localizes risk levels and audit result states", () => {
    expect(formatJVMRiskLevelText("medium", "zh-CN")).toBe("中");
    expect(formatJVMRiskLevelText("", "zh-CN")).toBe("未知");
    expect(formatJVMRiskLevelText("medium", "en-US")).toBe("Medium");
    expect(formatJVMRiskLevelText("", "en-US")).toBe("Unknown");
    expect(formatJVMAuditResultLabel("applied", "zh-CN")).toBe("已执行");
    expect(formatJVMAuditResultLabel("applied", "en-US")).toBe("Applied");
    expect(formatJVMAuditResultLabel("done", "en-US")).toBe("Success");
    expect(formatJVMAuditResultLabel("warning", "en-US")).toBe("Warning");
    expect(formatJVMAuditResultLabel("blocked", "en-US")).toBe("Blocked");
    expect(formatJVMAuditResultLabel("error", "en-US")).toBe("Failed");
    expect(formatJVMAuditResultLabel("", "en-US")).toBe("Unknown");
    expect(formatJVMAuditResultLabel("custom-state", "en-US")).toBe(
      "custom-state",
    );
    expect(resolveJVMAuditResultColor("warning")).toBe("gold");
  });

  it("uses json mode for structured snapshots", () => {
    expect(resolveJVMValueEditorLanguage("json", { name: "orders" })).toBe(
      "json",
    );
    expect(resolveJVMValueEditorLanguage("array", [{ id: 1 }])).toBe("json");
  });

  it("detects JSON-looking strings so the preview can use the structured editor", () => {
    expect(
      resolveJVMValueEditorLanguage("string", '{\"name\":\"orders\"}'),
    ).toBe("json");
  });

  it("falls back to plaintext for ordinary string values", () => {
    expect(resolveJVMValueEditorLanguage("string", "cache-enabled")).toBe(
      "plaintext",
    );
  });

  it("masks sensitive JVM snapshot values for display", () => {
    expect(
      formatJVMValueForDisplay({
        resourceId: "jmx:/attribute/app/Password",
        kind: "attribute",
        format: "string",
        value: "secret-token",
        sensitive: true,
      }),
    ).toBe("********");
    expect(
      formatJVMValueForDisplay({
        resourceId: "jmx:/attribute/app/State",
        kind: "attribute",
        format: "json",
        value: { state: "READY" },
      }),
    ).toBe(JSON.stringify({ state: "READY" }, null, 2));
  });

  it("masks sensitive JVM snapshot metadata for display", () => {
    expect(
      formatJVMMetadataForDisplay({
        metadata: { token: "secret-token" },
        sensitive: true,
      }),
    ).toBe("********");
    expect(
      formatJVMMetadataForDisplay({
        metadata: { owner: "orders" },
      }),
    ).toBe(JSON.stringify({ owner: "orders" }, null, 2));
  });

  it("masks sensitive action payload examples", () => {
    expect(
      buildJVMActionPayloadTemplate(
        {
          action: "set",
          payloadExample: { value: "secret-token" },
        },
        true,
      ),
    ).toBe("{\n  \n}");
  });

  it("builds apply requests from the previewed request and confirmation token", () => {
    const previewedRequest = {
      providerMode: "jmx" as const,
      resourceId: "jmx:/attribute/app/Mode",
      action: "set",
      reason: "修复运行模式",
      source: "manual" as const,
      expectedVersion: "v1",
      payload: { value: "warm" },
    };

    expect(
      buildJVMPreviewApplyRequest(previewedRequest, {
        allowed: true,
        requiresConfirmation: true,
        confirmationToken: "token-from-preview",
        summary: "设置 Mode",
        riskLevel: "high",
        before: {
          resourceId: "jmx:/attribute/app/Mode",
          kind: "attribute",
          format: "string",
          value: "cold",
        },
        after: {
          resourceId: "jmx:/attribute/app/Mode",
          kind: "attribute",
          format: "string",
          value: "warm",
        },
      }),
    ).toEqual({
      ...previewedRequest,
      confirmationToken: "token-from-preview",
    });
  });

  it("localizes missing confirmation token errors for apply requests", () => {
    expect(() =>
      buildJVMPreviewApplyRequest(
        {
          providerMode: "jmx",
          resourceId: "jmx:/attribute/app/Mode",
          action: "set",
          reason: "修复运行模式",
          payload: { value: "warm" },
        },
        {
          allowed: true,
          requiresConfirmation: true,
          summary: "设置 Mode",
          riskLevel: "high",
          before: {
            resourceId: "jmx:/attribute/app/Mode",
            kind: "attribute",
            format: "string",
            value: "cold",
          },
          after: {
            resourceId: "jmx:/attribute/app/Mode",
            kind: "attribute",
            format: "string",
            value: "warm",
          },
        },
        "zh-CN",
      ),
    ).toThrow("确认令牌缺失");

    expect(() =>
      buildJVMPreviewApplyRequest(
        {
          providerMode: "jmx",
          resourceId: "jmx:/attribute/app/Mode",
          action: "set",
          reason: "repair runtime mode",
          payload: { value: "warm" },
        },
        {
          allowed: true,
          requiresConfirmation: true,
          summary: "Set Mode",
          riskLevel: "high",
          before: {
            resourceId: "jmx:/attribute/app/Mode",
            kind: "attribute",
            format: "string",
            value: "cold",
          },
          after: {
            resourceId: "jmx:/attribute/app/Mode",
            kind: "attribute",
            format: "string",
            value: "warm",
          },
        },
        "en-US",
      ),
    ).toThrow("Confirmation token is missing. Preview again before executing.");
  });

  it("caps editor height for very long payloads while keeping short content compact", () => {
    expect(estimateJVMResourceEditorHeight("line-1")).toBe(180);
    expect(
      estimateJVMResourceEditorHeight(new Array(80).fill("line").join("\n")),
    ).toBe(420);
  });
});
