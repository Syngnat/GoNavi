import type {
  DataSyncRouteCapability,
  DataSyncPreflightSnapshot,
  DataSyncTaskDefinition,
  DataSyncValidationIssue,
  DataSyncValidationCode,
  DataSyncIndexColumn,
  DataSyncUnmigratedIndex,
  DataSyncPreflightProgress,
} from './model';
import {
  record,
  enumValue,
  boolean,
  optionalBoolean,
  optionalString,
  DataSyncGatewayProtocolError,
  array,
  string,
  fromMillis,
  optionalNumber,
  isRecord,
} from './wailsDtoPrimitives';
import type { WailsDataSyncJobDefinition } from './wailsDtoJobEncode';
import type { WailsQueryResultLike } from './wailsDtoMetadata';

export const decodeRouteCapability = (value: unknown): DataSyncRouteCapability => {
  const capability = record(value, 'DataSyncCapabilityResolve.data');
  const level = enumValue(
    capability.supportLevel,
    ['full', 'partial', 'planned', 'unsupported'] as const,
    'DataSyncCapabilityResolve.data.supportLevel',
  );
  return {
    level: level === 'planned' ? 'unsupported' : level,
    canExecute: boolean(capability.canExecute, 'DataSyncCapabilityResolve.data.canExecute'),
    supportsAutoCreate: boolean(
      capability.supportsAutoCreate,
      'DataSyncCapabilityResolve.data.supportsAutoCreate',
    ),
    supportsAutoAddColumns: optionalBoolean(
      capability.supportsAutoAddColumns,
      'DataSyncCapabilityResolve.data.supportsAutoAddColumns',
    ),
    requiresExistingTarget: optionalBoolean(
      capability.requiresExistingTarget,
      'DataSyncCapabilityResolve.data.requiresExistingTarget',
    ),
    supportsMutations: optionalBoolean(
      capability.supportsMutations,
      'DataSyncCapabilityResolve.data.supportsMutations',
    ),
    supportsCdc: false,
  };
};

export type DecodedDataSyncPreflight = {
  snapshot: DataSyncPreflightSnapshot;
  definition: WailsDataSyncJobDefinition;
  capability: DataSyncRouteCapability;
};

export const decodeDataSyncPreflight = (
  value: unknown,
  task: DataSyncTaskDefinition,
): DecodedDataSyncPreflight => {
  const payload = record(value, 'DataSyncJobPreflight.data');
  const status = enumValue(
    payload.status,
    ['blocked', 'warning', 'passed'] as const,
    'DataSyncJobPreflight.data.status',
  );
  const definition = record(payload.definition, 'DataSyncJobPreflight.data.definition');
  const definitionHash = optionalString(
    payload.definitionHash,
    'DataSyncJobPreflight.data.definitionHash',
  );
  if (status !== 'blocked' && !definitionHash) {
    throw new DataSyncGatewayProtocolError(
      'DataSyncJobPreflight.data.definitionHash',
      'passed preflight omitted definition hash',
    );
  }
  const issues: DataSyncValidationIssue[] = array(
    payload.issues,
    'DataSyncJobPreflight.data.issues',
  ).map((item, index) => {
    const issue = record(item, `DataSyncJobPreflight.data.issues[${index}]`);
    const code = string(issue.code, `DataSyncJobPreflight.data.issues[${index}].code`, false);
    return {
      id: `${code}:${optionalString(issue.mappingId, 'issue.mappingId')}:${index}`,
      code: code as DataSyncValidationCode,
      severity: enumValue(
        issue.severity,
        ['blocker', 'warning', 'info'] as const,
        `DataSyncJobPreflight.data.issues[${index}].severity`,
      ),
      stage: enumValue(
        issue.stage,
        ['endpoints', 'mappings', 'delivery', 'trigger', 'preflight'] as const,
        `DataSyncJobPreflight.data.issues[${index}].stage`,
      ),
      mappingId: optionalString(issue.mappingId, 'issue.mappingId') || undefined,
      message: optionalString(issue.message, 'issue.message') || undefined,
      detail: decodePreflightIssueDetail(issue.detail, index),
    };
  });
  let capability: DataSyncRouteCapability;
  if (status === 'blocked') {
    try {
      capability = decodeRouteCapability(payload.capability);
    } catch {
      // Early validation/endpoint failures legitimately have no resolved
      // route capability. The blocked snapshot is still useful and remains
      // fail-closed; only passed/warning results require a complete contract.
      capability = {
        level: 'unknown',
        canExecute: false,
        supportsAutoCreate: false,
        supportsAutoAddColumns: false,
        requiresExistingTarget: false,
        supportsMutations: false,
        supportsCdc: false,
      };
    }
  } else {
    capability = decodeRouteCapability(payload.capability);
  }
  return {
    snapshot: {
      taskId: task.id,
      taskRevision: task.revision,
      taskEditEpoch: task.editEpoch,
      status,
      issues,
      definitionHash,
      approvalRequired: boolean(
        payload.approvalRequired,
        'DataSyncJobPreflight.data.approvalRequired',
      ),
      // Approval evidence is intentionally backend-only. List/Get/Preflight
      // responses never expose it, so the UI can only trust a token minted in
      // this process for this exact definition hash.
      approvalSatisfied: false,
      checkedAt: fromMillis(payload.checkedAt, 'DataSyncJobPreflight.data.checkedAt'),
    },
    definition,
    capability,
  };
};

/**
 * Preflight is the sole command whose expected blocked result uses
 * QueryResult.success=false while still returning a structured payload.
 * Accept only that exact, decoded state; every other failure remains closed.
 */
export const decodeDataSyncPreflightQuery = (
  result: WailsQueryResultLike,
  task: DataSyncTaskDefinition,
): DecodedDataSyncPreflight => {
  const response = record(result, 'DataSyncJobPreflight');
  if (!Object.prototype.hasOwnProperty.call(response, 'data')) {
    throw new DataSyncGatewayProtocolError(
      'DataSyncJobPreflight',
      'response omitted data',
    );
  }
  const decoded = decodeDataSyncPreflight(response.data, task);
  if (response.success === true) {
    if (decoded.snapshot.status === 'blocked') {
      throw new DataSyncGatewayProtocolError(
        'DataSyncJobPreflight',
        'successful response reported blocked status',
      );
    }
    return decoded;
  }
  if (response.success === false && decoded.snapshot.status === 'blocked') {
    return decoded;
  }
  const message = optionalString(
    response.message,
    'DataSyncJobPreflight.message',
  ).trim();
  throw new DataSyncGatewayProtocolError(
    'DataSyncJobPreflight',
    message || 'inconsistent response status',
  );
};

export type DecodedDataSyncApproval = {
  token: string;
  expiresAt: string;
};

export type DecodedDataSyncApprovalChallenge = {
  challenge: string;
  notBefore: string;
  expiresAt: string;
};

export const decodeDataSyncApprovalChallenge = (
  value: unknown,
): DecodedDataSyncApprovalChallenge => {
  const challenge = record(value, 'DataSyncJobApprovalBegin.data');
  const notBefore = fromMillis(
    challenge.notBefore,
    'DataSyncJobApprovalBegin.data.notBefore',
  );
  const expiresAt = fromMillis(
    challenge.expiresAt,
    'DataSyncJobApprovalBegin.data.expiresAt',
  );
  if (!notBefore || !expiresAt || Date.parse(expiresAt) <= Date.parse(notBefore)) {
    throw new DataSyncGatewayProtocolError(
      'DataSyncJobApprovalBegin.data',
      'invalid approval countdown window',
    );
  }
  return {
    challenge: string(
      challenge.challenge,
      'DataSyncJobApprovalBegin.data.challenge',
      false,
    ),
    notBefore,
    expiresAt,
  };
};

export const decodeDataSyncApproval = (
  value: unknown,
): DecodedDataSyncApproval => {
  const approval = record(value, 'DataSyncJobApprove.data');
  const expiresAt = fromMillis(
    approval.expiresAt,
    'DataSyncJobApprove.data.expiresAt',
  );
  if (!expiresAt) {
    throw new DataSyncGatewayProtocolError(
      'DataSyncJobApprove.data.expiresAt',
      'approval token expiry is missing',
    );
  }
  return {
    token: string(approval.token, 'DataSyncJobApprove.data.token', false),
    expiresAt,
  };
};

export const decodeCDCAdapters = (value: unknown): string[] =>
  array(value, 'DataSyncCDCAdapterList.data').map((item, index) =>
    string(item, `DataSyncCDCAdapterList.data[${index}]`, false),
  );

const decodeIndexColumns = (value: unknown, path: string): DataSyncIndexColumn[] =>
  array(value, path).map((item, index) => {
    const column = record(item, `${path}[${index}]`);
    return {
      name: string(column.name, `${path}[${index}].name`, false),
      prefixLength:
        optionalNumber(column.prefixLength, `${path}[${index}].prefixLength`) || undefined,
    };
  });

const decodeUnmigratedIndex = (value: unknown, path: string): DataSyncUnmigratedIndex => {
  const index = record(value, path);
  return {
    name: string(index.name, `${path}.name`, false),
    columns: decodeIndexColumns(index.columns || [], `${path}.columns`),
    unique: boolean(index.unique, `${path}.unique`),
    indexType: optionalString(index.indexType, `${path}.indexType`) || '',
    reasonCode: optionalString(index.reasonCode, `${path}.reasonCode`) || undefined,
    reason: string(index.reason, `${path}.reason`, false),
    remediationStatements: array(
      index.remediationStatements || [],
      `${path}.remediationStatements`,
    ).map((statement, indexOffset) =>
      string(statement, `${path}.remediationStatements[${indexOffset}]`, false),
    ),
  };
};

const decodePreflightIssueDetail = (
  value: unknown,
  issueIndex: number,
): DataSyncValidationIssue['detail'] => {
  if (!isRecord(value)) return undefined;
  const path = `DataSyncJobPreflight.data.issues[${issueIndex}].detail`;
  let unmigratedIndex: DataSyncUnmigratedIndex | undefined;
  if (value.unmigratedIndex) {
    unmigratedIndex = decodeUnmigratedIndex(value.unmigratedIndex, `${path}.unmigratedIndex`);
  }
  let preflightProgress: DataSyncPreflightProgress | undefined;
  if (isRecord(value.preflightProgress)) {
    const progress = value.preflightProgress;
    preflightProgress = {
      checked: optionalNumber(progress.checked, `${path}.preflightProgress.checked`),
      total: optionalNumber(progress.total, `${path}.preflightProgress.total`),
      mappingKey: optionalString(progress.mappingKey, `${path}.preflightProgress.mappingKey`) || undefined,
      mappingLabel: optionalString(progress.mappingLabel, `${path}.preflightProgress.mappingLabel`) || undefined,
    };
  }
  if (!unmigratedIndex && !preflightProgress) return undefined;
  return {
    ...(unmigratedIndex ? { unmigratedIndex } : {}),
    ...(preflightProgress ? { preflightProgress } : {}),
  };
};
