import { describe, expect, it } from "vitest";

import {
  buildMonitoringAvailabilityText,
  extractThreadStateRows,
  formatCompactNumber,
  formatMonitoringAxisBytes,
  formatRecentGCLabel,
  normalizeMonitoringProviderMode,
  resolveMonitoringMetricLabel,
  resolveThreadStateLabel,
} from "./jvmMonitoringPresentation";

describe("jvmMonitoringPresentation", () => {
  it("summarizes degraded metrics with localized labels and raw provider warnings", () => {
    expect(
      buildMonitoringAvailabilityText({
        missingMetrics: ["cpu.process", "memory.rss"],
        providerWarnings: ["endpoint cpu metric unavailable"],
      }, "en-US"),
    ).toBe(
      "Missing metrics: Process CPU, Process physical memory | Monitoring source warning: endpoint cpu metric unavailable",
    );
  });

  it("localizes metric and thread state labels while preserving unknown raw values", () => {
    expect(resolveMonitoringMetricLabel("cpu.process", "en-US")).toBe("Process CPU");
    expect(resolveMonitoringMetricLabel("custom.metric", "en-US")).toBe("custom.metric");
    expect(resolveThreadStateLabel("RUNNABLE", "en-US")).toBe("Runnable");
    expect(resolveThreadStateLabel("CUSTOM_STATE", "en-US")).toBe("CUSTOM_STATE");
    expect(
      extractThreadStateRows(
        { timestamp: 1713945600000, threadStateCounts: { RUNNABLE: 2 } },
        "en-US",
      )[0]?.label,
    ).toBe("Runnable");
  });

  it("formats locale-sensitive compact numbers with the requested language", () => {
    expect(formatCompactNumber(1234, "en-US")).toBe("1,234");
    expect(formatCompactNumber(1234, "de-DE")).toBe("1.234");
  });

  it("formats recent gc event label with duration", () => {
    expect(
      formatRecentGCLabel({
        timestamp: 1713945600000,
        name: "G1 Young Generation",
        durationMs: 21,
      }, "en-US"),
    ).toContain("21ms");
  });

  it("formats byte axis ticks with compact units instead of raw byte numbers", () => {
    expect(formatMonitoringAxisBytes(120_000_000)).toBe("114 MB");
    expect(formatMonitoringAxisBytes(0)).toBe("0 B");
    expect(formatMonitoringAxisBytes(undefined)).toBe("--");
  });

  it("normalizes provider mode and falls back on unknown values", () => {
    expect(normalizeMonitoringProviderMode("AGENT", "jmx")).toBe("agent");
    expect(normalizeMonitoringProviderMode("unsupported", "endpoint")).toBe("endpoint");
    expect(normalizeMonitoringProviderMode(undefined, "jmx")).toBe("jmx");
  });
});
