import React from 'react';
import { create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { AIContextRing, formatRingSize } from './AIContextRing';
import { buildAIContextBreakdown, buildAIContextBreakdownFromPreview } from './aiContextBreakdown';

// The popover opens on hover; render its content in place so it can be read.
vi.mock('antd', async () => {
  const actual = await vi.importActual<typeof import('antd')>('antd');
  return {
    ...actual,
    Popover: ({ children, content }: { children: React.ReactNode; content: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children, React.createElement('div', { 'data-popover': true }, content)),
  };
});

const copy = (key: string, params?: Record<string, unknown>) => (params ? `${key}|${JSON.stringify(params)}` : key);
const draw = (breakdown: ReturnType<typeof buildAIContextBreakdown>) => create(<AIContextRing breakdown={breakdown} copy={copy} />);
const json = (renderer: ReturnType<typeof create>) => JSON.stringify(renderer.toJSON());

const history = (user = 0, assistant = 0, toolResults = 0) => ({ user, assistant, toolResults, messageCount: 0 });
const input = { windowSize: 16_000, reservedOutput: 2_000, workspaceBytes: 0, boundBytes: 0, history: history(), draftText: '' };

describe('AIContextRing', () => {
  it('fills the circle in proportion to how much of the prompt budget is used', () => {
    const renderer = draw(buildAIContextBreakdown({ ...input, workspaceBytes: 3_500, history: history(0, 3_500) }));
    const arc = renderer.root.findByProps({ className: 'gn-ai-ctx-ring-arc' });
    expect(arc.props.strokeDasharray).toBe('50 50'); // 7000 of 14000
    expect(renderer.root.findByType('button').props['aria-label']).toBe('ai_chat.context_ring.aria|{"percent":50}');
  });

  it('turns amber and then red as the context fills up', () => {
    const level = (used: number) => draw(buildAIContextBreakdown({ ...input, history: history(used) })).root.findByType('button').props['data-level'];
    expect(level(1_000)).toBe('ok');
    expect(level(11_500)).toBe('warn');
    expect(level(14_000)).toBe('full');
  });

  it('never draws more than a full circle', () => {
    const arc = draw(buildAIContextBreakdown({ ...input, history: history(90_000) })).root.findByProps({ className: 'gn-ai-ctx-ring-arc' });
    expect(arc.props.strokeDasharray).toBe('100 0');
  });

  it('lists each part that takes room, plus skills, the reserve and what is free', () => {
    const renderer = draw(buildAIContextBreakdown({
      ...input, workspaceBytes: 4_000, boundBytes: 800, history: history(1_200, 5_600, 0),
    }));
    const rows = renderer.root.findAll((node) => node.type === 'li').map((node) => node.props['data-seg']);
    expect(rows).toEqual(['workspace', 'bound', 'skills', 'user', 'assistant', 'reserved', 'free']);
    const text = json(renderer);
    expect(text).toContain('ai_chat.context_ring.segment.skills');
    expect(text).toContain('ai_chat.context_ring.note.skills');
    expect(text).toContain('ai_chat.context_ring.note.estimate');
    expect(text).not.toContain('segment.tool_results'); // nothing there, so no row
  });

  it('shows sizes the way the rest of the panel does, and small shares as under 1%', () => {
    expect(formatRingSize(0)).toBe('0');
    expect(formatRingSize(950)).toBe('950');
    expect(formatRingSize(12_800)).toBe('12.8k');
    const text = json(draw(buildAIContextBreakdown({ ...input, workspaceBytes: 40 })));
    expect(text).toContain('<1%');
  });

  it('sizes each bar part against the whole window, with the reply reserve at the end', () => {
    const renderer = draw(buildAIContextBreakdown({ ...input, workspaceBytes: 4_000 }));
    const parts = renderer.root.findAllByProps({ className: 'gn-ai-ctx-bar-part' });
    expect(parts.map((node) => node.props['data-seg'])).toEqual(['workspace', 'reserved']);
    expect(parts[0].props.style.width).toBe('25%');
    expect(parts[1].props.style.width).toBe('12.5%');
  });

  it('says what was left out or cut, so a full-looking ring is understood', () => {
    const measured = (overrides: Record<string, unknown>) => draw(buildAIContextBreakdownFromPreview({
      windowTokens: 16_000, reservedOutputTokens: 2_000, instructionsBytes: 0, workspaceBytes: 3_000, boundBytes: 0, userBytes: 500, assistantBytes: 0,
      toolBytes: 0, retainedMessages: 1, omittedMessages: 0, overflow: false, ...overrides,
    } as any, { windowSize: 16_000, reservedOutput: 2_000 }));
    const plain = json(measured({}));
    expect(plain).not.toContain('note.omitted');
    expect(plain).not.toContain('note.workspace_trimmed');
    expect(plain).not.toContain('note.overflow');

    const trimmed = json(measured({ omittedMessages: 4, workspaceTrimmed: 'active_tab' }));
    expect(trimmed).toContain('ai_chat.context_ring.note.omitted|{\\"count\\":4}');
    expect(trimmed).toContain('ai_chat.context_ring.note.workspace_trimmed');

    const overflow = measured({ overflow: true, userBytes: 40_000 });
    expect(json(overflow)).toContain('ai_chat.context_ring.note.overflow');
    expect(overflow.root.findByType('button').props['data-level']).toBe('full');

    const prompted = measured({ instructionsBytes: 1_200 });
    const rows = prompted.root.findAll((node) => node.type === 'li').map((node) => node.props['data-seg']);
    expect(rows[0]).toBe('instructions');
    expect(json(prompted)).toContain('ai_chat.context_ring.segment.instructions');
  });
});
