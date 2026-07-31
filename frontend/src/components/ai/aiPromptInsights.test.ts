import { describe, expect, it } from 'vitest';

import { buildAIGuidanceSnapshot } from './aiPromptInsights';

describe('aiPromptInsights', () => {
  it('localizes prompt guidance wrappers while keeping prompt and skill content raw', () => {
    const snapshot = buildAIGuidanceSnapshot({
      userPromptSettings: {
        global: '回答前先核对上下文。',
        database: '',
        jvm: '',
        jvmDiagnostic: '',
      },
      skills: [
        {
          id: 'skill-1',
          name: '结构审查',
          description: '优先核对字段和索引',
          systemPrompt: '先看字段，再给结论。',
          enabled: true,
          scopes: ['database'],
          requiredTools: ['get_columns'],
        },
      ],
      translate: (key, params) => {
        const suffix = params
          ? ` ${Object.entries(params).map(([paramKey, value]) => `${paramKey}=${value}`).join(',')}`
          : '';
        return `T:${key}${suffix}`;
      },
    });

    expect(snapshot.customPrompts[0].label).toBe('T:ai_chat.inspection.guidance.scope.global');
    expect(snapshot.customPrompts[0].content).toBe('回答前先核对上下文。');
    expect(snapshot.enabledSkills[0].name).toBe('结构审查');
    expect(snapshot.enabledSkills[0].systemPrompt).toBe('先看字段，再给结论。');
    expect(snapshot.message).toBe('T:ai_chat.inspection.guidance.message.configured promptCount=1,skillCount=1');
  });

  it('summarizes active custom prompts and enabled skills for runtime inspection', () => {
    const snapshot = buildAIGuidanceSnapshot({
      userPromptSettings: {
        global: '回答前先核对上下文。',
        database: '默认只读优先。',
        jvm: '',
        jvmDiagnostic: '',
      },
      skills: [
        {
          id: 'skill-1',
          name: '结构审查',
          description: '优先核对字段和索引',
          systemPrompt: '先看字段，再给结论。',
          enabled: true,
          scopes: ['database'],
          requiredTools: ['get_columns'],
        },
        {
          id: 'skill-2',
          name: 'JVM 诊断',
          description: '诊断命令审查',
          systemPrompt: '先列风险。',
          enabled: false,
          scopes: ['jvmDiagnostic'],
        },
      ],
    });

    expect(snapshot.customPromptCount).toBe(2);
    expect(snapshot.customPrompts.find((item) => item.scope === 'global')?.enabled).toBe(true);
    expect(snapshot.enabledSkillCount).toBe(1);
    expect(snapshot.disabledSkillCount).toBe(1);
    expect(snapshot.enabledSkills[0].name).toBe('结构审查');
    expect(snapshot.enabledSkills[0].requiredTools).toEqual(['get_columns']);
  });
});
