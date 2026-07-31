import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

import {
  buildJVMChangeDraftFromAIPlan,
  buildJVMAIPlanPrompt,
  extractJVMChangePlan,
  resolveJVMAIPlanResourceId,
  resolveJVMAIPlanTargetTabId,
} from './jvmAiPlan';

const translatedCopy: Record<string, string> = {
  'jvm_ai_plan.error.payload_json_object_required': 'Translated payload object required',
  'jvm_ai_plan.snapshot.unavailable': 'Translated snapshot unavailable.',
  'jvm_ai_plan.actions.none': 'Translated actions none.',
  'jvm_ai_plan.actions.label': ' <{{label}}>',
  'jvm_ai_plan.actions.description': ' :: {{description}}',
  'jvm_ai_plan.actions.payload_fields': ' :: fields={{fields}}',
  'jvm_ai_plan.actions.field_separator': '|',
  'jvm_ai_plan.actions.required_suffix': '(req)',
  'jvm_ai_plan.prompt.resource_path_missing': '(translated missing path)',
  'jvm_ai_plan.prompt.environment_unknown': 'translated-unknown',
  'jvm_ai_plan.prompt.intro': 'Translated JVM prompt intro.',
  'jvm_ai_plan.prompt.connection_name': 'Conn={{connectionName}}',
  'jvm_ai_plan.prompt.target_host': 'Host={{host}}',
  'jvm_ai_plan.prompt.provider_mode': 'Mode={{providerMode}}',
  'jvm_ai_plan.prompt.environment': 'Env={{environmentLabel}}',
  'jvm_ai_plan.prompt.connection_policy.read_only': 'Translated read only policy',
  'jvm_ai_plan.prompt.connection_policy.writable': 'Translated writable policy',
  'jvm_ai_plan.prompt.connection_policy': 'Policy={{policy}}',
  'jvm_ai_plan.prompt.resource_path': 'Path={{resourcePath}}',
  'jvm_ai_plan.prompt.snapshot_title': 'Translated snapshot title:',
  'jvm_ai_plan.prompt.supported_actions_title': 'Translated actions title:',
  'jvm_ai_plan.prompt.output_requirements_title': 'Translated requirements:',
  'jvm_ai_plan.prompt.requirement.single_json_block': 'Translated requirement 1.',
  'jvm_ai_plan.prompt.requirement.fields': 'Translated requirement 2.',
  'jvm_ai_plan.prompt.requirement.resource_path': 'Translated requirement path {{resourcePath}}.',
  'jvm_ai_plan.prompt.requirement.action': 'Translated requirement action.',
  'jvm_ai_plan.prompt.requirement.payload': 'Translated requirement payload.',
  'jvm_ai_plan.prompt.requirement.no_execute': 'Translated requirement no execute.',
  'jvm_ai_plan.prompt.example_title': 'Translated JSON example:',
  'jvm_ai_plan.prompt.example_reason': 'Translated cache reason',
};

const translate = (key: string, params?: Record<string, unknown>) => {
  const template = translatedCopy[key] || key;
  return template.replace(/\{\{(\w+)\}\}/g, (_match, name) => String(params?.[name] ?? ''));
};

describe('extractJVMChangePlan', () => {
  it('parses fenced json plan with namespace and key selector', () => {
    const message = [
      '建议先预览再执行：',
      '```json',
      '{"targetType":"cacheEntry","selector":{"namespace":"orders","key":"user:1"},"action":"updateValue","payload":{"format":"json","value":{"status":"ACTIVE"}},"reason":"修复缓存脏值"}',
      '```',
    ].join('\n');

    const plan = extractJVMChangePlan(message);
    expect(plan?.action).toBe('updateValue');
    expect(plan?.selector.namespace).toBe('orders');
    expect(plan?.selector.key).toBe('user:1');
    expect(plan ? resolveJVMAIPlanResourceId(plan) : '').toBe('orders/user:1');
  });

  it('parses fenced json plan with explicit resource path', () => {
    const message = [
      '```json',
      '{"targetType":"managedBean","selector":{"resourcePath":"/cache/orders/user:1"},"action":"clear","reason":"触发受控清理"}',
      '```',
    ].join('\n');

    const plan = extractJVMChangePlan(message);
    expect(plan?.targetType).toBe('managedBean');
    expect(plan?.selector.resourcePath).toBe('/cache/orders/user:1');
    expect(plan?.action).toBe('clear');
  });

  it('returns null for malformed plan', () => {
    expect(extractJVMChangePlan('```json\n{"action":1}\n```')).toBeNull();
  });

  it('returns null when selector is missing', () => {
    expect(
      extractJVMChangePlan('```json\n{"targetType":"cacheEntry","action":"evict","reason":"修复缓存脏值"}\n```'),
    ).toBeNull();
  });
});

describe('buildJVMChangeDraftFromAIPlan', () => {
  it('maps updateValue plan to current JVM change contract', () => {
    const plan = extractJVMChangePlan(
      '```json\n{"targetType":"cacheEntry","selector":{"namespace":"orders","key":"user:1"},"action":"updateValue","payload":{"format":"json","value":{"status":"ACTIVE"}},"reason":"修复缓存脏值"}\n```',
    );

    expect(plan).not.toBeNull();
    expect(buildJVMChangeDraftFromAIPlan(plan!)).toEqual({
      resourceId: 'orders/user:1',
      action: 'put',
      reason: '修复缓存脏值',
      source: 'ai-plan',
      payload: {
        status: 'ACTIVE',
      },
    });
  });

  it('maps clear plan without leaking wrapper payload fields', () => {
    const plan = extractJVMChangePlan(
      '```json\n{"targetType":"managedBean","selector":{"resourcePath":"/cache/orders"},"action":"clear","reason":"受控清理"}\n```',
    );

    expect(plan).not.toBeNull();
    expect(buildJVMChangeDraftFromAIPlan(plan!)).toEqual({
      resourceId: '/cache/orders',
      action: 'clear',
      reason: '受控清理',
      source: 'ai-plan',
      payload: {},
    });
  });

  it('rejects non-object update payload values for current preview contract', () => {
    const plan = extractJVMChangePlan(
      '```json\n{"targetType":"cacheEntry","selector":{"resourcePath":"/cache/orders"},"action":"updateValue","payload":{"format":"text","value":"ACTIVE"},"reason":"修复缓存脏值"}\n```',
    );

    expect(plan).not.toBeNull();
    expect(() => buildJVMChangeDraftFromAIPlan(plan!)).toThrow(/payload.*JSON object/i);
  });

  it('uses translated error copy for invalid AI plan payloads', () => {
    const plan = extractJVMChangePlan(
      '```json\n{"targetType":"cacheEntry","selector":{"resourcePath":"/cache/orders"},"action":"updateValue","payload":{"format":"text","value":"ACTIVE"},"reason":"修复缓存脏值"}\n```',
    );

    expect(plan).not.toBeNull();
    expect(() => buildJVMChangeDraftFromAIPlan(plan!, translate)).toThrow('Translated payload object required');
  });

  it('keeps generic action for managed bean payload updates', () => {
    const plan = extractJVMChangePlan(
      '```json\n{"targetType":"attribute","selector":{"resourcePath":"jmx://java.lang/type=Memory/attribute/Verbose"},"action":"set","payload":{"format":"json","value":{"value":true}},"reason":"开启诊断日志"}\n```',
    );

    expect(plan).not.toBeNull();
    expect(buildJVMChangeDraftFromAIPlan(plan!)).toEqual({
      resourceId: 'jmx://java.lang/type=Memory/attribute/Verbose',
      action: 'set',
      reason: '开启诊断日志',
      source: 'ai-plan',
      payload: {
        value: true,
      },
    });
  });
});

describe('buildJVMAIPlanPrompt', () => {
  it('masks sensitive snapshot values before injecting the AI prompt', () => {
    const prompt = buildJVMAIPlanPrompt({
      connectionName: 'orders-jvm',
      host: '127.0.0.1',
      providerMode: 'jmx',
      resourcePath: 'jmx:/attribute/app/Password',
      readOnly: false,
      snapshot: {
        resourceId: 'jmx:/attribute/app/Password',
        kind: 'attribute',
        format: 'string',
        value: 'secret-token',
        sensitive: true,
        supportedActions: [
          {
            action: 'set',
            payloadExample: { value: 'secret-token' },
          },
        ],
      },
    });

    expect(prompt).toContain('********');
    expect(prompt).not.toContain('secret-token');
  });

  it('builds the prompt from translated JVM AI plan copy', () => {
    const prompt = buildJVMAIPlanPrompt({
      connectionName: 'orders-jvm',
      providerMode: 'endpoint',
      resourcePath: '',
      readOnly: true,
      snapshot: null,
    }, translate);

    expect(prompt).toContain('Translated JVM prompt intro.');
    expect(prompt).toContain('Conn=orders-jvm');
    expect(prompt).toContain('Path=(translated missing path)');
    expect(prompt).toContain('Policy=Translated read only policy');
    expect(prompt).toContain('Translated snapshot unavailable.');
    expect(prompt).toContain('Translated actions none.');
    expect(prompt).toContain('Translated cache reason');
    expect(prompt).not.toContain('请分析下面这个 JVM 资源');
    expect(prompt).not.toContain('当前资源快照尚未加载成功');
  });
});

describe('resolveJVMAIPlanTargetTabId', () => {
  it('prefers the original tab when message context still matches', () => {
    expect(
      resolveJVMAIPlanTargetTabId(
        [
          {
            id: 'tab-orders',
            title: 'orders',
            type: 'jvm-resource',
            connectionId: 'conn-orders',
            providerMode: 'endpoint',
            resourcePath: '/cache/orders/user:1',
          },
        ],
        {
          tabId: 'tab-orders',
          connectionId: 'conn-orders',
          providerMode: 'endpoint',
          resourcePath: '/cache/orders/user:1',
        },
      ),
    ).toBe('tab-orders');
  });

  it('falls back to a reopened tab with the same JVM context', () => {
    expect(
      resolveJVMAIPlanTargetTabId(
        [
          {
            id: 'tab-orders-reopened',
            title: 'orders',
            type: 'jvm-resource',
            connectionId: 'conn-orders',
            providerMode: 'endpoint',
            resourcePath: '/cache/orders/user:1',
          },
        ],
        {
          tabId: 'tab-orders-old',
          connectionId: 'conn-orders',
          providerMode: 'endpoint',
          resourcePath: '/cache/orders/user:1',
        },
      ),
    ).toBe('tab-orders-reopened');
  });

  it('rejects tabs that only match the current session but not the original JVM context', () => {
    expect(
      resolveJVMAIPlanTargetTabId(
        [
          {
            id: 'tab-other-resource',
            title: 'orders-other',
            type: 'jvm-resource',
            connectionId: 'conn-orders',
            providerMode: 'endpoint',
            resourcePath: '/cache/orders/user:2',
          },
        ],
        {
          tabId: 'tab-orders',
          connectionId: 'conn-orders',
          providerMode: 'endpoint',
          resourcePath: '/cache/orders/user:1',
        },
      ),
    ).toBe('');
  });
});
