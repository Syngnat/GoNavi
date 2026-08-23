import type { RequestTracePage } from './requestDiagnosticsModel';

export interface RequestDiagnosticsRpcResult<T = unknown> {
  success?: boolean;
  data?: T;
  message?: string;
}

export interface DatabaseDiagnosticRedaction {
  credentials?: string;
  dsn?: string;
  sqlLiterals?: string;
  businessValues?: string;
  sensitivePaths?: string;
}

export interface DatabaseDiagnosticScope {
  included?: string[];
  excluded?: string[];
  redaction?: DatabaseDiagnosticRedaction;
}

export interface DatabaseDiagnosticSourceAvailability {
  connectionState?: string;
  driverTypes?: string[];
  requestTraces?: string;
  slowQueryHistory?: string;
  logs?: string;
  aiSnapshot?: string;
  metadataTiming?: string;
}

export interface DatabaseDiagnosticPreview {
  readOnly?: boolean;
  format?: string;
  scope?: DatabaseDiagnosticScope;
  redaction?: DatabaseDiagnosticRedaction;
  connectionCount?: number;
  requestTraceCount?: number;
  runningQueryCount?: number;
  pendingTransactionCount?: number;
  slowQuerySummaryCount?: number;
  sources?: DatabaseDiagnosticSourceAvailability;
}

export interface DatabaseDiagnosticExportPayload {
  fileName?: string;
  mimeType?: string;
  content?: string;
}

export type ReproductionBundleSourceKind = 'query' | 'sync' | 'import' | 'mcp';

export interface ReproductionBundleSourceRef {
  kind: ReproductionBundleSourceKind;
  id: string;
}

export interface ReproductionBundleSourceSummary extends ReproductionBundleSourceRef {
  label?: string;
  status?: string;
  errorKind?: string;
  updatedAt?: number;
}

export interface ReproductionBundleSourcePage {
  items?: ReproductionBundleSourceSummary[];
  warnings?: string[];
}

export interface ReproductionBundleRedaction extends DatabaseDiagnosticRedaction {
  rawErrorMessages?: string;
}

export interface ReproductionBundlePreview {
  schemaVersion?: number;
  format?: string;
  appVersion?: string;
  source?: ReproductionBundleSourceSummary;
  capabilities?: Record<string, string>;
  eventCount?: number;
  fixtureEngine?: string;
  offlineOnly?: boolean;
  redaction?: ReproductionBundleRedaction;
}

export interface ReproductionBundleReplayResult {
  reproduced?: boolean;
  engine?: string;
  sourceKind?: ReproductionBundleSourceKind;
  status?: string;
  errorKind?: string;
  events?: Array<{ offsetMs?: number; name?: string; status?: string; stage?: string }>;
}

export interface RequestDiagnosticsBackend {
  GetRequestDiagnostics?: (filter: { requestId?: string; entry?: string; limit?: number }) => Promise<RequestDiagnosticsRpcResult<RequestTracePage>>;
  GetDatabaseDiagnosticPackagePreview?: () => Promise<RequestDiagnosticsRpcResult<DatabaseDiagnosticPreview>>;
  BuildDatabaseDiagnosticPackage?: () => Promise<RequestDiagnosticsRpcResult<DatabaseDiagnosticExportPayload>>;
  ExportDatabaseDiagnosticPackage?: () => Promise<RequestDiagnosticsRpcResult<Record<string, string>>>;
  ListReproductionBundleSources?: () => Promise<RequestDiagnosticsRpcResult<ReproductionBundleSourcePage>>;
  BuildReproductionBundle?: (kind: ReproductionBundleSourceKind, sourceId: string) => Promise<RequestDiagnosticsRpcResult<DatabaseDiagnosticExportPayload>>;
  ExportReproductionBundle?: (kind: ReproductionBundleSourceKind, sourceId: string) => Promise<RequestDiagnosticsRpcResult<Record<string, string>>>;
  PreviewReproductionBundle?: (content: string) => Promise<RequestDiagnosticsRpcResult<ReproductionBundlePreview>>;
  ReplayReproductionBundle?: (content: string) => Promise<RequestDiagnosticsRpcResult<ReproductionBundleReplayResult>>;
}

export const resolveRequestDiagnosticsBackend = (): RequestDiagnosticsBackend => {
  if (typeof window === 'undefined') return {};
  return ((window as any).go?.app?.App || {}) as RequestDiagnosticsBackend;
};

export const unwrapRequestDiagnostics = <T>(result: RequestDiagnosticsRpcResult<T>): T => {
  if (result?.success === false) {
    throw new Error(String(result.message || '').trim() || 'Request diagnostics failed');
  }
  return result?.data as T;
};
