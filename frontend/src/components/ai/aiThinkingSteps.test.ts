import { describe, expect, it } from 'vitest';

import { countThinkingChars, parseThinkingSteps } from './aiThinkingSteps';

describe('AI thinking steps', () => {
  it('turns bold-only summary parts into titled steps', () => {
    expect(parseThinkingSteps('**Checking Oracle version**\n\n**Defining H2.T**\n\n**Preparing 10-row insert**')).toEqual([
      { title: 'Checking Oracle version', body: '' },
      { title: 'Defining H2.T', body: '' },
      { title: 'Preparing 10-row insert', body: '' },
    ]);
  });

  it('attaches following paragraphs to the step they belong to', () => {
    expect(parseThinkingSteps('**Plan**\nCheck the version first.\n\nThen create the table.\n\n**Run**')).toEqual([
      { title: 'Plan', body: 'Check the version first.\n\nThen create the table.' },
      { title: 'Run', body: '' },
    ]);
  });

  it('splits summary parts that were glued together while streaming', () => {
    expect(parseThinkingSteps('**Checking Oracle version****Defining table**').map((step) => step.title)).toEqual([
      'Checking Oracle version',
      'Defining table',
    ]);
  });

  it('keeps plain reasoning text as one untitled step', () => {
    expect(parseThinkingSteps('先看连接，\n再看表结构。')).toEqual([{ body: '先看连接，\n再看表结构。' }]);
  });

  it('treats a title that is still streaming as a title without its markers', () => {
    expect(parseThinkingSteps('**Checking Ora')).toEqual([{ title: 'Checking Ora', body: '' }]);
  });

  it('counts visible characters only', () => {
    expect(countThinkingChars('**Checking Oracle version**')).toBe('Checking Oracle version'.length);
    expect(countThinkingChars('checking')).toBe(8);
    expect(countThinkingChars('')).toBe(0);
  });
});
