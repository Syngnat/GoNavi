export type DataImportMode = 'table' | 'sqlFile';

export type DataImportModeCapabilityDTO = {
  supported: boolean;
  reason: string;
  requiresPinnedSession: boolean;
  supportsTransactionalBatch: boolean;
  supportsContinue: boolean;
  supportedConflictPolicies: string[];
  supportedFormats: string[];
  supportedEncodings: string[];
  supportedCompressions: string[];
  supportedClientDirectives: string[];
};

export type DataImportCapabilityDTO = {
  databaseType: string;
  tableImport: DataImportModeCapabilityDTO;
  sqlFileImport: DataImportModeCapabilityDTO;
};

const KNOWN_DATA_IMPORT_REASON_CODES = new Set([
  'capability_unavailable',
  'data_import_restricted',
  'database_runtime_unavailable',
  'database_type_unsupported',
  'pinned_session_unavailable',
  'sql_file_import_restricted',
  'table_import_runtime_unavailable',
]);

export const resolveDataImportCapabilityReasonKey = (reason: string): string => {
  const normalized = String(reason || '').trim();
  if (!KNOWN_DATA_IMPORT_REASON_CODES.has(normalized)) {
    return 'data_import.capability.reason.unsupported';
  }
  return `data_import.capability.reason.${normalized}`;
};

const unavailableModeCapability = (mode: DataImportMode): DataImportModeCapabilityDTO => ({
  supported: false,
  reason: 'capability_unavailable',
  requiresPinnedSession: mode === 'sqlFile',
  supportsTransactionalBatch: false,
  supportsContinue: false,
  supportedConflictPolicies: [],
  supportedFormats: [],
  supportedEncodings: [],
  supportedCompressions: [],
  supportedClientDirectives: [],
});

export const resolveDataImportModeCapability = (
  capability: DataImportCapabilityDTO | null | undefined,
  mode: DataImportMode,
): DataImportModeCapabilityDTO => {
  if (!capability) {
    return unavailableModeCapability(mode);
  }
  const modeCapability = mode === 'table'
    ? capability.tableImport
    : capability.sqlFileImport;
  if (!modeCapability || typeof modeCapability.supported !== 'boolean') {
    return unavailableModeCapability(mode);
  }
  const supportedConflictPolicies = Array.isArray(modeCapability.supportedConflictPolicies)
    ? modeCapability.supportedConflictPolicies.filter((policy) => (
        policy === 'stop' || policy === 'skip_duplicates' || policy === 'upsert'
      ))
    : [];
  return { ...modeCapability, supportedConflictPolicies };
};
