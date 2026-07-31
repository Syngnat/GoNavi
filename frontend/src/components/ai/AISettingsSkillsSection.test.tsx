import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import AISettingsSkillsSection from './AISettingsSkillsSection';
import { I18nProvider } from '../../i18n/provider';
import { t as catalogTranslate } from '../../i18n/catalog';
import { buildOverlayWorkbenchTheme } from '../../utils/overlayWorkbenchTheme';
import type { AISkillConfig } from '../../types';

const REQUIRED_SKILL_KEYS = [
  'ai_settings.skill.description',
  'ai_settings.skill.hint',
  'ai_settings.skill.action.add',
  'ai_settings.skill.empty',
  'ai_settings.skill.name_placeholder',
  'ai_settings.skill.status.enabled',
  'ai_settings.skill.status.disabled',
  'ai_settings.skill.description_placeholder',
  'ai_settings.skill.scope.global.label',
  'ai_settings.skill.scope.global.desc',
  'ai_settings.skill.scope.database.label',
  'ai_settings.skill.scope.database.desc',
  'ai_settings.skill.scope.jvm.label',
  'ai_settings.skill.scope.jvm.desc',
  'ai_settings.skill.scope.jvm_diagnostic.label',
  'ai_settings.skill.scope.jvm_diagnostic.desc',
  'ai_settings.skill.scopes_placeholder',
  'ai_settings.skill.required_tools_placeholder',
  'ai_settings.skill.system_prompt_placeholder',
  'ai_settings.skill.confirm_delete',
  'common.save',
  'common.delete',
  'common.cancel',
] as const;

const skillDraft: AISkillConfig = {
  id: 'skill-1',
  name: '',
  description: '',
  scopes: [],
  requiredTools: [],
  systemPrompt: '',
  enabled: true,
};

const renderSection = (skills: AISkillConfig[]) => renderToStaticMarkup(
  <I18nProvider preference="en-US" systemLanguages={['en-US']} onPreferenceChange={() => {}}>
    <AISettingsSkillsSection
      skills={skills}
      skillRequiredToolOptions={[]}
      overlayTheme={buildOverlayWorkbenchTheme(false)}
      cardBg="#fff"
      cardBorder="rgba(0,0,0,0.08)"
      inputBg="#fff"
      loading={false}
      onAddSkill={() => {}}
      onUpdateSkillDraft={() => {}}
      onSaveSkill={() => {}}
      onDeleteSkill={() => {}}
    />
  </I18nProvider>,
);

describe('AISettingsSkillsSection', () => {
  it('renders the empty skill configuration section in English', () => {
    const markup = renderSection([]);

    expect(markup).toContain('Add Skill');
    expect(markup).toContain('No Skills yet.');
    expect(markup).toContain('named prompt module');
  });

  it('renders skill draft placeholders and actions in English', () => {
    const markup = renderSection([skillDraft]);

    expect(markup).toContain('Skill name, for example: SQL review / JVM diagnostic plan');
    expect(markup).toContain('Enabled');
    expect(markup).toContain('Select where this Skill should apply');
    expect(markup).toContain('Save');
    expect(markup).toContain('Delete');
  });

  it('uses spaced flat sections without decorative dividers', () => {
    const emptyMarkup = renderSection([]);
    const editorMarkup = renderSection([skillDraft]);

    expect(emptyMarkup).toContain('gonavi-ai-skill-empty');
    expect(emptyMarkup).not.toContain('border-bottom:1px solid rgba(0,0,0,0.08)');
    expect(editorMarkup).toContain('gonavi-ai-skill-editor');
    expect(editorMarkup).not.toContain('border-bottom:1px solid rgba(0,0,0,0.08)');
  });

  it('uses native disclosure while keeping editor fields mounted', () => {
    const markup = renderSection([{ ...skillDraft, systemPrompt: 'Keep this draft mounted.' }]);

    expect(markup).toContain('<details class="gonavi-ai-skill-editor"');
    expect(markup).toContain('<summary');
    expect(markup).toContain('Keep this draft mounted.');
    expect(markup).toContain('aria-label="Skill name, for example: SQL review / JVM diagnostic plan"');
  });

  it('uses catalog keys for skill settings chrome', () => {
    for (const key of REQUIRED_SKILL_KEYS) {
      expect(catalogTranslate('en-US', key)).not.toBe(key);
      expect(catalogTranslate('zh-CN', key)).not.toBe(key);
    }

    for (const oldCopy of [
      '全局',
      '所有 AI 会话都启用',
      '数据库',
      '仅 SQL / 数据库场景启用',
      'JVM 资源',
      '仅 JVM 资源分析场景启用',
      'JVM 诊断',
      '仅 JVM 诊断工作台启用',
      'Skill 不是另一条大提示词',
      '启用后会按 scope 注入对应会话',
      '新增 Skill',
      '还没有 Skill',
      'Skill 名称，例如：SQL 审查 / JVM 诊断计划',
      '已启用',
      '已禁用',
      '给自己看的说明',
      '选择这个 Skill 要作用到哪些场景',
      '可选：声明这个 Skill 依赖哪些工具',
      '输入这条 Skill 要追加的 system prompt',
      '保存',
      '删除这个 Skill？',
      '删除',
      '取消',
    ]) {
    }
  });
});
