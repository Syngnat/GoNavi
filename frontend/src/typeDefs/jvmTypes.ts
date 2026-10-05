export interface JVMJMXConfig {
  enabled?: boolean;
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  domainAllowlist?: string[];
}

export interface JVMEndpointConfig {
  enabled?: boolean;
  baseUrl?: string;
  apiKey?: string;
  timeoutSeconds?: number;
}

export interface JVMAgentConfig {
  enabled?: boolean;
  baseUrl?: string;
  apiKey?: string;
  timeoutSeconds?: number;
}

export type JVMDiagnosticTransport = "agent-bridge" | "arthas-tunnel";

export interface JVMDiagnosticConfig {
  enabled?: boolean;
  transport?: JVMDiagnosticTransport;
  baseUrl?: string;
  targetId?: string;
  apiKey?: string;
  allowObserveCommands?: boolean;
  allowTraceCommands?: boolean;
  allowMutatingCommands?: boolean;
  timeoutSeconds?: number;
}

export interface JVMDiagnosticCapability {
  transport: JVMDiagnosticTransport;
  canOpenSession: boolean;
  canStream: boolean;
  canCancel: boolean;
  allowObserveCommands: boolean;
  allowTraceCommands: boolean;
  allowMutatingCommands: boolean;
  reason?: string;
}

export interface JVMDiagnosticSessionRequest {
  title?: string;
  reason?: string;
}

export interface JVMDiagnosticSessionHandle {
  sessionId: string;
  transport: string;
  startedAt: number;
}

export interface JVMDiagnosticCommandRequest {
  sessionId: string;
  commandId: string;
  command: string;
  source?: string;
  reason?: string;
}

export interface JVMDiagnosticEventChunk {
  sessionId: string;
  commandId?: string;
  event?: string;
  phase?: string;
  content?: string;
  timestamp?: number;
  metadata?: Record<string, any>;
}

export interface JVMDiagnosticAuditRecord {
  timestamp: number;
  connectionId: string;
  sessionId?: string;
  commandId?: string;
  transport: string;
  command: string;
  commandType?: string;
  source?: string;
  reason?: string;
  riskLevel?: string;
  status: string;
}

export interface JVMDiagnosticPlan {
  intent: string;
  transport: JVMDiagnosticTransport;
  command: string;
  riskLevel: "low" | "medium" | "high";
  reason: string;
  expectedSignals?: string[];
}

export interface JVMDiagnosticCommandDraft {
  sessionId?: string;
  command: string;
  source?: "manual" | "ai-plan";
  reason?: string;
}

export interface JVMConfig {
  environment?: "dev" | "uat" | "prod";
  readOnly?: boolean;
  allowedModes?: Array<"jmx" | "endpoint" | "agent">;
  preferredMode?: "jmx" | "endpoint" | "agent";
  jmx?: JVMJMXConfig;
  endpoint?: JVMEndpointConfig;
  agent?: JVMAgentConfig;
  diagnostic?: JVMDiagnosticConfig;
}

export interface JVMCapability {
  mode: "jmx" | "endpoint" | "agent";
  canBrowse: boolean;
  canWrite: boolean;
  canPreview: boolean;
  reason?: string;
  displayLabel: string;
}

export interface JVMMonitoringPoint {
  timestamp: number;
  heapUsedBytes?: number;
  heapCommittedBytes?: number;
  heapMaxBytes?: number;
  nonHeapUsedBytes?: number;
  nonHeapCommittedBytes?: number;
  gcCollectionCount?: number;
  gcCollectionTimeMs?: number;
  gcDeltaCount?: number;
  gcDeltaTimeMs?: number;
  threadCount?: number;
  daemonThreadCount?: number;
  peakThreadCount?: number;
  threadStateCounts?: Record<string, number>;
  loadedClassCount?: number;
  unloadedClassCount?: number;
  classLoadDelta?: number;
  processCpuLoad?: number;
  systemCpuLoad?: number;
  processRssBytes?: number;
  committedVirtualMemoryBytes?: number;
}

export interface JVMMonitoringRecentGCEvent {
  timestamp: number;
  name?: string;
  cause?: string;
  action?: string;
  durationMs?: number;
  beforeUsedBytes?: number;
  afterUsedBytes?: number;
}

export interface JVMMonitoringSessionState {
  connectionId: string;
  providerMode: "jmx" | "endpoint" | "agent";
  running: boolean;
  points?: JVMMonitoringPoint[];
  recentGcEvents?: JVMMonitoringRecentGCEvent[];
  availableMetrics?: string[];
  missingMetrics?: string[];
  providerWarnings?: string[];
}

export interface JVMResourceSummary {
  id: string;
  parentId?: string;
  kind: string;
  name: string;
  path: string;
  providerMode: "jmx" | "endpoint" | "agent";
  canRead: boolean;
  canWrite: boolean;
  hasChildren: boolean;
  sensitive?: boolean;
}

export interface JVMActionPayloadField {
  name: string;
  type?: string;
  required?: boolean;
  description?: string;
}

export interface JVMActionDefinition {
  action: string;
  label?: string;
  description?: string;
  dangerous?: boolean;
  payloadFields?: JVMActionPayloadField[];
  payloadExample?: Record<string, any>;
}

export interface JVMValueSnapshot {
  resourceId: string;
  kind: string;
  format: string;
  version?: string;
  value: any;
  description?: string;
  sensitive?: boolean;
  supportedActions?: JVMActionDefinition[];
  metadata?: Record<string, any>;
}

export interface JVMChangePreview {
  allowed: boolean;
  requiresConfirmation?: boolean;
  confirmationToken?: string;
  summary: string;
  riskLevel: "low" | "medium" | "high";
  blockingReason?: string;
  before: JVMValueSnapshot;
  after: JVMValueSnapshot;
}

export interface JVMChangeRequest {
  providerMode: "jmx" | "endpoint" | "agent";
  resourceId: string;
  action: string;
  reason: string;
  source?: "manual" | "ai-plan";
  expectedVersion?: string;
  confirmationToken?: string;
  payload?: Record<string, any>;
}

export interface JVMApplyResult {
  status: string;
  message?: string;
  updatedValue: JVMValueSnapshot;
}

export interface JVMAuditRecord {
  timestamp: number;
  connectionId: string;
  providerMode: string;
  resourceId: string;
  action: string;
  reason: string;
  source?: string;
  result: string;
}
