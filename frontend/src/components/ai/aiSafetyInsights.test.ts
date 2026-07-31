import { describe, expect, it } from 'vitest';

import { buildAISafetySnapshot } from './aiSafetyInsights';

describe('buildAISafetySnapshot', () => {
  it('localizes safety labels, restrictions, recommendations and summary while preserving raw connection names', () => {
    const snapshot = buildAISafetySnapshot({
      safetyLevel: 'readonly',
      connections: [
        {
          id: 'conn-1',
          name: '生产主库',
          config: {
            type: 'mysql',
            host: '127.0.0.1',
            port: 3306,
            user: 'root',
          },
        },
      ],
      activeContext: { connectionId: 'conn-1', dbName: 'orders' },
      translate: (key, params) => {
        const suffix = params
          ? ` ${Object.entries(params).map(([paramKey, value]) => `${paramKey}=${value}`).join(',')}`
          : '';
        return `T:${key}${suffix}`;
      },
    });

    expect(snapshot.safetyLabel).toBe('T:ai_chat.inspection.runtime.safety.readonly');
    expect(snapshot.sqlRuleText).toBe('T:ai_chat.inspection.safety.rule.readonly');
    expect(snapshot.effectiveRestrictions).toContain('T:ai_chat.inspection.safety.rule.readonly');
    expect(snapshot.effectiveRestrictions).toContain('T:ai_chat.inspection.safety.restriction.readonly_blocks_mutating');
    expect(snapshot.recommendations).toContain('T:ai_chat.inspection.safety.recommendation.enable_readwrite_for_dml');
    expect(snapshot.message).toBe('T:ai_chat.inspection.safety.message.active safety=T:ai_chat.inspection.runtime.safety.readonly,connection=生产主库');
    expect(snapshot.activeConnection?.connectionName).toBe('生产主库');
  });

  it('describes readonly ai safety when no active connection is selected', () => {
    const snapshot = buildAISafetySnapshot({
      safetyLevel: 'readonly',
      connections: [],
    });

    expect(snapshot.safetyLevel).toBe('readonly');
    expect(snapshot.permissionMatrix.allowQuery).toBe(true);
    expect(snapshot.permissionMatrix.allowDML).toBe(false);
    expect(snapshot.permissionMatrix.allowDDL).toBe(false);
    expect(snapshot.hasActiveConnection).toBe(false);
    expect(snapshot.effectiveRestrictions).toContain('Read-only mode only allows query statements.');
    expect(snapshot.recommendations).toContain('Switch AI safety level to read/write mode before executing INSERT/UPDATE/DELETE.');
  });

  it('includes jvm connection restrictions and MCP write confirmation hints', () => {
    const snapshot = buildAISafetySnapshot({
      safetyLevel: 'readwrite',
      connections: [
        {
          id: 'jvm-1',
          name: 'JVM 诊断环境',
          config: {
            type: 'jvm',
            host: '10.0.0.8',
            port: 0,
            user: '',
            jvm: {
              environment: 'uat',
              readOnly: true,
              diagnostic: {
                transport: 'agent-bridge',
                allowObserveCommands: true,
                allowTraceCommands: true,
                allowMutatingCommands: false,
              },
            },
          },
        },
      ],
      tabs: [
        {
          id: 'diag-tab-1',
          title: 'JVM 诊断',
          type: 'jvm-diagnostic',
          connectionId: 'jvm-1',
          readOnly: true,
        },
      ],
      activeTabId: 'diag-tab-1',
    });

    expect(snapshot.permissionMatrix.allowDML).toBe(true);
    expect(snapshot.permissionMatrix.allowDDL).toBe(false);
    expect(snapshot.activeConnection?.readOnly).toBe(true);
    expect(snapshot.jvmGuards?.allowMutatingCommands).toBe(false);
    expect(snapshot.effectiveRestrictions.join('\n')).toContain('allowMutating=true');
    expect(snapshot.effectiveRestrictions.join('\n')).toContain('Current JVM diagnostics explicitly disallow mutating commands');
  });

  it('describes full safety mode as allowing other statements with confirmation', () => {
    const snapshot = buildAISafetySnapshot({
      safetyLevel: 'full',
      connections: [],
    });

    expect(snapshot.safetyLevel).toBe('full');
    expect(snapshot.permissionMatrix.allowDML).toBe(true);
    expect(snapshot.permissionMatrix.allowDDL).toBe(true);
    expect(snapshot.sqlRuleText).toContain('allows all SQL operations');
    expect(snapshot.effectiveRestrictions.join('\n')).toContain('high-risk or unrecognized statements still require confirmation');
  });
});
