import { describe, expect, it } from 'vitest';

import { t as translate } from '../i18n';
import type { SavedConnection, SecurityUpdateIssue, SecurityUpdateStatus } from '../types';
import {
  hasSecurityUpdateRecentResult,
  resolveSecurityUpdateFocusState,
  resolveSecurityUpdateRepairEntry,
  resolveSecurityUpdateSettingsFocusTarget,
  shouldRefreshSecurityUpdateDetailsFocus,
  shouldReopenSecurityUpdateDetails,
  shouldRetrySecurityUpdateAfterRepairSave,
} from './securityUpdateRepairFlow';

const en = (key: string) => translate(key, undefined, 'en-US');

const createConnection = (id: string): SavedConnection => ({
  id,
  name: `连接-${id}`,
  config: {
    id,
    type: 'postgres',
    host: 'db.local',
    port: 5432,
    user: 'postgres',
  },
});

const createStatus = (overrides: Partial<SecurityUpdateStatus> = {}): SecurityUpdateStatus => ({
  overallStatus: 'needs_attention',
  summary: {
    total: 1,
    updated: 0,
    pending: 1,
    skipped: 0,
    failed: 0,
  },
  issues: [],
  ...overrides,
});

describe('securityUpdateRepairFlow', () => {
  it('opens the matching connection and preserves the return source for security update repairs', () => {
    const target = createConnection('conn-1');
    const issue: SecurityUpdateIssue = {
      id: 'issue-1',
      action: 'open_connection',
      refId: 'conn-1',
    };

    expect(resolveSecurityUpdateRepairEntry(issue, [target])).toEqual({
      type: 'connection',
      connection: target,
      repairSource: 'connection',
    });
  });

  it('returns a stable warning key when the target connection no longer exists without a translator', () => {
    const issue: SecurityUpdateIssue = {
      id: 'issue-1',
      action: 'open_connection',
      refId: 'missing-conn',
    };

    expect(resolveSecurityUpdateRepairEntry(issue, [createConnection('conn-1')])).toEqual({
      type: 'warning',
      message: 'security_update.repair.warning.connection_not_found',
    });
  });

  it('uses the catalog warning when a repair translator is provided', () => {
    const issue: SecurityUpdateIssue = {
      id: 'issue-1',
      action: 'open_connection',
      refId: 'missing-conn',
    };

    const resolveWithTranslator = resolveSecurityUpdateRepairEntry as unknown as (
      issue: SecurityUpdateIssue,
      connections: SavedConnection[],
      status: SecurityUpdateStatus | null,
      t: (key: string) => string,
    ) => ReturnType<typeof resolveSecurityUpdateRepairEntry>;

    expect(resolveWithTranslator(issue, [createConnection('conn-1')], null, en)).toEqual({
      type: 'warning',
      message: 'The matching connection was not found. Check the latest status first.',
    });
  });

  it('maps proxy, ai and retry actions to the expected repair entry', () => {
    expect(resolveSecurityUpdateRepairEntry({ id: 'proxy', action: 'open_proxy_settings' }, [])).toEqual({
      type: 'proxy',
      repairSource: 'proxy',
    });
    expect(resolveSecurityUpdateRepairEntry({ id: 'ai', action: 'open_ai_settings', refId: 'provider-1' }, [])).toEqual({
      type: 'ai',
      providerId: 'provider-1',
      repairSource: 'ai',
    });
    expect(resolveSecurityUpdateRepairEntry({ id: 'retry', action: 'retry_update' }, [])).toEqual({
      type: 'retry',
    });
  });

  it('routes view_details actions to the latest result section when a recent result exists', () => {
    const status = createStatus({
      backupPath: '/tmp/gonavi-backup.json',
      lastError: '写入新密钥失败',
    });

    expect(hasSecurityUpdateRecentResult(status)).toBe(true);
    expect(resolveSecurityUpdateSettingsFocusTarget(status)).toBe('recent_result');
    expect(resolveSecurityUpdateRepairEntry({ id: 'details', action: 'view_details' }, [], status)).toEqual({
      type: 'details',
      focusTarget: 'recent_result',
    });
  });

  it('falls back to the status section when no recent result is available yet', () => {
    const status = createStatus();

    expect(hasSecurityUpdateRecentResult(status)).toBe(false);
    expect(resolveSecurityUpdateSettingsFocusTarget(status)).toBe('status');
    expect(resolveSecurityUpdateRepairEntry({ id: 'details', action: 'view_details' }, [], status)).toEqual({
      type: 'details',
      focusTarget: 'status',
    });
  });

  it('builds a fresh focus pulse for repeated details clicks and clears it when the modal closes', () => {
    expect(resolveSecurityUpdateFocusState(true, 'status', 1)).toEqual({
      target: 'status',
      pulseKey: 'status:1',
    });
    expect(resolveSecurityUpdateFocusState(true, 'status', 2)).toEqual({
      target: 'status',
      pulseKey: 'status:2',
    });
    expect(resolveSecurityUpdateFocusState(false, 'status', 2)).toEqual({
      target: null,
      pulseKey: null,
    });
    expect(resolveSecurityUpdateFocusState(true, null, 3)).toEqual({
      target: null,
      pulseKey: null,
    });
  });

  it('reopens security update details after closing a repair entry opened from that page', () => {
    expect(shouldReopenSecurityUpdateDetails('connection')).toBe(true);
    expect(shouldReopenSecurityUpdateDetails('proxy')).toBe(true);
    expect(shouldReopenSecurityUpdateDetails('ai')).toBe(true);
    expect(shouldReopenSecurityUpdateDetails(null)).toBe(false);
  });

  it('retries the current round automatically after saving a connection from the repair flow', () => {
    expect(shouldRetrySecurityUpdateAfterRepairSave('connection')).toBe(true);
    expect(shouldRetrySecurityUpdateAfterRepairSave('proxy')).toBe(false);
    expect(shouldRetrySecurityUpdateAfterRepairSave('ai')).toBe(false);
    expect(shouldRetrySecurityUpdateAfterRepairSave(null)).toBe(false);
  });

  it('does not force a new focus pulse when the details modal is already open and only the round result is refreshing', () => {
    expect(shouldRefreshSecurityUpdateDetailsFocus({
      requestedOpen: true,
      wasOpen: true,
    })).toBe(false);
    expect(shouldRefreshSecurityUpdateDetailsFocus({
      requestedOpen: true,
      wasOpen: false,
    })).toBe(true);
    expect(shouldRefreshSecurityUpdateDetailsFocus({
      requestedOpen: false,
      wasOpen: true,
    })).toBe(false);
  });
});
