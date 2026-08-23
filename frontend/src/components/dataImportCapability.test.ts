import { describe, expect, it } from 'vitest';

import {
  resolveDataImportCapabilityReasonKey,
  resolveDataImportModeCapability,
  type DataImportCapabilityDTO,
} from './dataImportCapability';

describe('resolveDataImportModeCapability', () => {
  it('honors a backend SQL-file veto even for MySQL', () => {
    const capability: DataImportCapabilityDTO = {
      databaseType: 'mysql',
      tableImport: {
        supported: true,
        reason: '',
        requiresPinnedSession: false,
        supportsTransactionalBatch: true,
        supportsContinue: true,
        supportedConflictPolicies: ['stop'],
        supportedFormats: ['csv'],
        supportedEncodings: ['utf-8'],
        supportedCompressions: [],
        supportedClientDirectives: [],
      },
      sqlFileImport: {
        supported: false,
        reason: 'pinned_session_unavailable',
        requiresPinnedSession: true,
        supportsTransactionalBatch: false,
        supportsContinue: false,
        supportedConflictPolicies: [],
        supportedFormats: [],
        supportedEncodings: [],
        supportedCompressions: [],
        supportedClientDirectives: [],
      },
    };

    expect(resolveDataImportModeCapability(capability, 'sqlFile')).toEqual(
      capability.sqlFileImport,
    );
  });

  it('fails closed when the backend capability DTO is unavailable', () => {
    expect(resolveDataImportModeCapability(undefined, 'sqlFile')).toEqual({
      supported: false,
      reason: 'capability_unavailable',
      requiresPinnedSession: true,
      supportsTransactionalBatch: false,
      supportsContinue: false,
      supportedConflictPolicies: [],
      supportedFormats: [],
      supportedEncodings: [],
      supportedCompressions: [],
      supportedClientDirectives: [],
    });
  });

  it('fails closed when the backend returns an incomplete mode capability', () => {
    expect(resolveDataImportModeCapability({} as DataImportCapabilityDTO, 'table')).toEqual({
      supported: false,
      reason: 'capability_unavailable',
      requiresPinnedSession: false,
      supportsTransactionalBatch: false,
      supportsContinue: false,
      supportedConflictPolicies: [],
      supportedFormats: [],
      supportedEncodings: [],
      supportedCompressions: [],
      supportedClientDirectives: [],
    });
  });

  it('fails closed for missing or unknown conflict policies', () => {
    const capability = {
      databaseType: 'mysql',
      tableImport: {
        supported: true,
        reason: '',
        requiresPinnedSession: false,
        supportsTransactionalBatch: true,
        supportsContinue: true,
        supportedFormats: ['csv'],
        supportedEncodings: ['utf-8'],
        supportedCompressions: [],
        supportedClientDirectives: [],
        supportedConflictPolicies: ['stop', 'overwrite_everything'],
      },
    } as unknown as DataImportCapabilityDTO;

    expect(resolveDataImportModeCapability(capability, 'table').supportedConflictPolicies).toEqual([
      'stop',
    ]);
  });

  it('maps backend reason codes to bounded translation keys', () => {
    expect(resolveDataImportCapabilityReasonKey('pinned_session_unavailable')).toBe(
      'data_import.capability.reason.pinned_session_unavailable',
    );
    expect(resolveDataImportCapabilityReasonKey('future_backend_reason')).toBe(
      'data_import.capability.reason.unsupported',
    );
  });
});
