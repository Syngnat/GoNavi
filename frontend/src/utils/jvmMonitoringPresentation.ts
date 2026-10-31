import type {
  JVMMonitoringPoint,
  JVMMonitoringRecentGCEvent,
  JVMMonitoringSessionState,
} from "../types";
import {
  getCurrentLanguage,
  t,
  type SupportedLanguage,
} from "../i18n";
import { formatBytes } from "./byteSize";

const METRIC_LABELS: Record<string, string> = {
  "heap.used": "jvm_monitoring_presentation.metric.heap_used",
  "heap.non_heap": "jvm_monitoring_presentation.metric.heap_non_heap",
  "gc.count": "jvm_monitoring_presentation.metric.gc_count",
  "gc.time": "jvm_monitoring_presentation.metric.gc_time",
  "gc.events": "jvm_monitoring_presentation.metric.gc_events",
  "thread.count": "jvm_monitoring_presentation.metric.thread_count",
  "thread.states": "jvm_monitoring_presentation.metric.thread_states",
  "class.loading": "jvm_monitoring_presentation.metric.class_loading",
  "cpu.process": "jvm_monitoring_presentation.metric.cpu_process",
  "cpu.system": "jvm_monitoring_presentation.metric.cpu_system",
  "memory.rss": "jvm_monitoring_presentation.metric.memory_rss",
  "memory.virtual": "jvm_monitoring_presentation.metric.memory_virtual",
};

export type JVMMonitoringProviderMode = JVMMonitoringSessionState["providerMode"];

const MONITORING_PROVIDER_MODES: JVMMonitoringProviderMode[] = [
  "jmx",
  "endpoint",
  "agent",
];

const THREAD_STATE_LABELS: Record<string, string> = {
  NEW: "jvm_monitoring_presentation.thread_state.new",
  RUNNABLE: "jvm_monitoring_presentation.thread_state.runnable",
  BLOCKED: "jvm_monitoring_presentation.thread_state.blocked",
  WAITING: "jvm_monitoring_presentation.thread_state.waiting",
  TIMED_WAITING: "jvm_monitoring_presentation.thread_state.timed_waiting",
  TERMINATED: "jvm_monitoring_presentation.thread_state.terminated",
};

const resolveLanguage = (language?: SupportedLanguage): SupportedLanguage =>
  language ?? getCurrentLanguage();

const createTimeFormatter = (language?: SupportedLanguage) => new Intl.DateTimeFormat(resolveLanguage(language), {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

export type MonitoringChartPoint = JVMMonitoringPoint & {
  timeLabel: string;
};

export const resolveMonitoringMetricLabel = (
  metric: string,
  language?: SupportedLanguage,
): string => {
  const normalized = String(metric || "").trim();
  const key = METRIC_LABELS[normalized];
  return key ? t(key, undefined, resolveLanguage(language)) : normalized;
};

export const resolveThreadStateLabel = (
  state?: string | null,
  language?: SupportedLanguage,
): string => {
  const normalized = String(state || "").trim().toUpperCase();
  const key = THREAD_STATE_LABELS[normalized];
  return key ? t(key, undefined, resolveLanguage(language)) : String(state || "").trim();
};

export const formatMonitoringTime = (
  timestamp?: number,
  language?: SupportedLanguage,
): string => {
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) {
    return "--";
  }
  return createTimeFormatter(language).format(new Date(timestamp));
};

export { formatBytes };

export const formatMonitoringAxisBytes = (value?: number): string => formatBytes(value);

export const formatPercent = (value?: number): string => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return "--";
  }
  return `${(value * 100).toFixed(1)}%`;
};

export const formatCompactNumber = (
  value?: number,
  language?: SupportedLanguage,
): string => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "--";
  }
  return value.toLocaleString(resolveLanguage(language));
};

export const formatDurationMs = (value?: number): string => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return "--";
  }
  return `${Math.round(value)}ms`;
};

export const normalizeMonitoringProviderMode = (
  value: unknown,
  fallback: JVMMonitoringProviderMode = "jmx",
): JVMMonitoringProviderMode => {
  const normalized = String(value || "").trim().toLowerCase();
  if (MONITORING_PROVIDER_MODES.includes(normalized as JVMMonitoringProviderMode)) {
    return normalized as JVMMonitoringProviderMode;
  }
  return MONITORING_PROVIDER_MODES.includes(fallback) ? fallback : "jmx";
};

export const buildMonitoringAvailabilityText = ({
  missingMetrics,
  providerWarnings,
}: Pick<JVMMonitoringSessionState, "missingMetrics" | "providerWarnings">,
language?: SupportedLanguage,
): string => {
  const resolvedLanguage = resolveLanguage(language);
  const fragments: string[] = [];

  if (Array.isArray(missingMetrics) && missingMetrics.length > 0) {
    const metrics = missingMetrics
      .map((metric) => resolveMonitoringMetricLabel(metric, resolvedLanguage))
      .join(resolvedLanguage.startsWith("zh") ? "、" : ", ");
    fragments.push(
      t("jvm_monitoring_presentation.availability.missing_metrics", {
        metrics,
      }, resolvedLanguage),
    );
  }

  if (Array.isArray(providerWarnings) && providerWarnings.length > 0) {
    fragments.push(
      t("jvm_monitoring_presentation.availability.provider_warnings", {
        warnings: providerWarnings.join(resolvedLanguage.startsWith("zh") ? "；" : "; "),
      }, resolvedLanguage),
    );
  }

  if (fragments.length === 0) {
    return t(
      "jvm_monitoring_presentation.availability.no_obvious_degradation",
      undefined,
      resolvedLanguage,
    );
  }

  return fragments.join(" | ");
};

export const formatRecentGCLabel = (
  event: JVMMonitoringRecentGCEvent,
  language?: SupportedLanguage,
): string => {
  const parts = [
    formatMonitoringTime(event.timestamp, language),
    String(event.name || "").trim(),
    typeof event.durationMs === "number" ? `${event.durationMs}ms` : "",
    String(event.cause || "").trim(),
  ].filter(Boolean);

  return parts.join(" · ");
};

export const buildMonitoringChartPoints = (
  points: JVMMonitoringPoint[] = [],
  language?: SupportedLanguage,
): MonitoringChartPoint[] =>
  points.map((point) => ({
    ...point,
    timeLabel: formatMonitoringTime(point.timestamp, language),
  }));

export const extractThreadStateRows = (
  point?: JVMMonitoringPoint,
  language?: SupportedLanguage,
): Array<{ state: string; label: string; count: number }> =>
  Object.entries(point?.threadStateCounts || {})
    .map(([state, count]) => ({
      state,
      label: resolveThreadStateLabel(state, language),
      count: Number(count) || 0,
    }))
    .sort((left, right) => right.count - left.count);

export const monitoringMetricAvailable = (
  session: Pick<JVMMonitoringSessionState, "availableMetrics"> | undefined,
  metric: string,
): boolean =>
  Array.isArray(session?.availableMetrics) &&
  session.availableMetrics.includes(metric);
