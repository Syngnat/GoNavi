import { describe, expect, it } from 'vitest';

import type { AIChatMessage } from '../../types';
import {
  AI_CONTEXT_SEGMENT_ORDER,
  MESSAGE_ENVELOPE_BYTES,
  buildAIContextBreakdown,
  buildAIContextBreakdownFromPreview,
  jsonStringBytes,
  measureAIChatHistory,
} from './aiContextBreakdown';
import type { AgentContextPreview } from './aiContextPreviewClient';
import {
  getPublishedWorkspaceMeasure,
  getWorkspaceSnapshotVersion,
  measureWorkspaceSnapshot,
  recordPublishedWorkspaceSnapshot,
  subscribeToWorkspaceSnapshot,
} from './aiWorkspaceSnapshotMeasure';

const message = (overrides: Partial<AIChatMessage>): AIChatMessage => ({
  id: `m-${Math.random()}`, role: 'user', content: '', timestamp: 1, ...overrides,
});

describe('jsonStringBytes', () => {
  // The expected sizes are what Go's json.Marshal produces for the same strings.
  it.each([
    ['abc', 3],
    ['a"b', 4],
    ['back\\slash', 11],
    ['中文', 6],
    ['<>&', 18],
    ['line1\nline2\ttab\r', 19],
    ['😀', 4],
    ['\u0001', 6],
    ['\b\f', 4],
    ['é', 2],
    [' ', 6],
    ['', 0],
  ])('%j takes %i bytes', (text, bytes) => {
    expect(jsonStringBytes(text)).toBe(bytes);
  });
});

describe('measureAIChatHistory', () => {
  it('splits what the conversation carries by who wrote it', () => {
    const measure = measureAIChatHistory([
      message({ role: 'user', content: 'hello' }),
      message({ role: 'assistant', content: 'abc', reasoning_content: 'xy' }),
      message({ role: 'tool', content: '{"rows":3}' }),
    ]);
    expect(measure.user).toBe(MESSAGE_ENVELOPE_BYTES + 5);
    expect(measure.assistant).toBe(MESSAGE_ENVELOPE_BYTES + 3 + 2);
    expect(measure.toolResults).toBe(MESSAGE_ENVELOPE_BYTES + jsonStringBytes('{"rows":3}'));
    expect(measure.messageCount).toBe(3);
  });

  it('counts tool calls with the assistant message that made them', () => {
    const toolCalls = [{ id: 't1', type: 'function', function: { name: 'inspect', arguments: '{}' } }];
    const plain = measureAIChatHistory([message({ role: 'assistant', content: 'x' })]);
    const withCalls = measureAIChatHistory([message({ role: 'assistant', content: 'x', tool_calls: toolCalls as any })]);
    expect(withCalls.assistant - plain.assistant).toBe(JSON.stringify(toolCalls).length);
  });

  it('leaves out what is never sent: UI-only notices, placeholders and system rows', () => {
    const measure = measureAIChatHistory([
      message({ role: 'assistant', content: 'a connection error', excludeFromAIContext: true }),
      message({ role: 'assistant', content: '', loading: true }),
      message({ role: 'system', content: 'local note' }),
    ]);
    expect(measure).toEqual({ user: 0, assistant: 0, toolResults: 0, messageCount: 0, pendingAssistant: 0 });
  });

  it('measures a message once, however many times the list is measured', () => {
    const streaming = message({ role: 'assistant', content: 'partial' });
    const first = measureAIChatHistory([streaming]);
    // A cached message keeps its size even if the object were edited in place;
    // the store replaces messages instead, which is what makes the cache safe.
    streaming.content = 'a much longer text than before';
    expect(measureAIChatHistory([streaming])).toEqual(first);
    expect(measureAIChatHistory([{ ...streaming }]).assistant).toBeGreaterThan(first.assistant);
  });
});

const history = (user = 0, assistant = 0, toolResults = 0) => ({ user, assistant, toolResults, messageCount: 0 });
const base = { windowSize: 10_000, reservedOutput: 2_000, workspaceBytes: 0, boundBytes: 0, history: history(), draftText: '' };

describe('buildAIContextBreakdown', () => {
  it('adds up the parts and leaves the rest as free space', () => {
    const breakdown = buildAIContextBreakdown({ ...base, workspaceBytes: 1_000, boundBytes: 500, history: history(1_500, 2_000, 250) });
    expect(breakdown.used).toBe(5_250);
    expect(breakdown.budget).toBe(8_000);
    expect(breakdown.reserved).toBe(2_000);
    expect(breakdown.free).toBe(2_750);
    expect(breakdown.segments.map((segment) => segment.id)).toEqual([...AI_CONTEXT_SEGMENT_ORDER]);
    expect(breakdown.pressure).toBeCloseTo(5_250 / 8_000);
    expect(breakdown.level).toBe('ok');
  });

  it('counts what is being typed as the person\'s input, and nothing for blank text', () => {
    const typed = buildAIContextBreakdown({ ...base, draftText: 'select 1' });
    expect(typed.segments.find((segment) => segment.id === 'user')?.size).toBe(MESSAGE_ENVELOPE_BYTES + 8);
    expect(buildAIContextBreakdown({ ...base, draftText: '  \n ' }).used).toBe(0);
  });

  it('keeps skills at zero: they are configured but not added to the agent context', () => {
    const breakdown = buildAIContextBreakdown({ ...base, workspaceBytes: 1_000 });
    expect(breakdown.segments.find((segment) => segment.id === 'skills')?.size).toBe(0);
  });

  it('warns at 80% of what the prompt may use and calls it full at 100%', () => {
    expect(buildAIContextBreakdown({ ...base, history: history(6_399) }).level).toBe('ok');
    expect(buildAIContextBreakdown({ ...base, history: history(6_400) }).level).toBe('warn');
    expect(buildAIContextBreakdown({ ...base, history: history(8_000) }).level).toBe('full');
  });

  it('never reports negative free space when the context overflows', () => {
    const breakdown = buildAIContextBreakdown({ ...base, history: history(20_000) });
    expect(breakdown.free).toBe(0);
    expect(breakdown.pressure).toBeGreaterThan(1);
  });

  it('copes with a reserve as large as the window, and with a missing one', () => {
    const greedy = buildAIContextBreakdown({ ...base, reservedOutput: 50_000 });
    expect(greedy.reserved).toBe(10_000);
    expect(greedy.budget).toBe(0);
    expect(greedy.level).toBe('full');
    const none = buildAIContextBreakdown({ ...base, reservedOutput: 0 });
    expect(none.budget).toBe(10_000);
  });
});

describe('workspace snapshot measure', () => {
  const snapshot = (attached: unknown[]) => ({
    revision: 1,
    activeContext: { connectionId: 'c1', attachedItems: attached },
    tabs: [{ id: 't1', draft: 'select * from orders where a < 3' }],
  });

  it('separates the items the person bound from the rest of the workspace', () => {
    const attached = [{ kind: 'editor_selection', content: 'select 1' }];
    const withItems = measureWorkspaceSnapshot(snapshot(attached));
    const without = measureWorkspaceSnapshot(snapshot([]));
    expect(withItems.attachedBytes).toBe(jsonStringBytes(JSON.stringify(attached)));
    expect(without.attachedBytes).toBe(0);
    // Binding something moves bytes between the two parts; the sum only grows by the JSON glue.
    expect(withItems.workspaceBytes).toBeGreaterThan(0);
    expect(Math.abs(withItems.workspaceBytes - (without.workspaceBytes - 0))).toBeLessThan(60);
  });

  it('tells subscribers when a new snapshot is published, and measures lazily', () => {
    let calls = 0;
    const stop = subscribeToWorkspaceSnapshot(() => { calls += 1; });
    const before = getWorkspaceSnapshotVersion();
    const published = snapshot([]);
    recordPublishedWorkspaceSnapshot(published);
    expect(getWorkspaceSnapshotVersion()).toBe(before + 1);
    expect(calls).toBe(1);
    const measure = getPublishedWorkspaceMeasure();
    expect(getPublishedWorkspaceMeasure()).toBe(measure); // cached for the same snapshot
    recordPublishedWorkspaceSnapshot(published); // the same object again is not news
    expect(calls).toBe(1);
    stop();
    recordPublishedWorkspaceSnapshot(snapshot([]));
    expect(calls).toBe(1);
  });
});

const preview = (overrides: Partial<AgentContextPreview> = {}): AgentContextPreview => ({
  windowTokens: 16_000, reservedOutputTokens: 2_000, instructionsBytes: 0, workspaceBytes: 3_000, boundBytes: 1_000, userBytes: 500, assistantBytes: 1_500,
  toolBytes: 0, retainedMessages: 4, omittedMessages: 0, overflow: false, ...overrides,
});

describe('buildAIContextBreakdownFromPreview', () => {
  it('shows what Go measured, against the window the agent enforces', () => {
    const breakdown = buildAIContextBreakdownFromPreview(preview(), { windowSize: 4_096, reservedOutput: 1_024 });
    expect(breakdown.windowSize).toBe(16_000);
    expect(breakdown.reserved).toBe(2_000);
    expect(breakdown.used).toBe(6_000);
    expect(breakdown.free).toBe(8_000);
    expect(breakdown.segments.map((segment) => [segment.id, segment.size])).toEqual([
      ['instructions', 0], ['workspace', 3_000], ['bound', 1_000], ['skills', 0], ['user', 500], ['assistant', 1_500], ['toolResults', 0],
    ]);
    expect(breakdown.level).toBe('ok');
  });

  it('counts the prompts sent first with every turn', () => {
    const breakdown = buildAIContextBreakdownFromPreview(preview({ instructionsBytes: 2_400 }), { windowSize: 16_000, reservedOutput: 2_000 });
    expect(breakdown.segments[0]).toEqual({ id: 'instructions', size: 2_400 });
    expect(breakdown.used).toBe(8_400);
  });

  it('uses the window of the panel where the agent enforces none', () => {
    const breakdown = buildAIContextBreakdownFromPreview(preview({ windowTokens: 0, reservedOutputTokens: 0 }), { windowSize: 128_000, reservedOutput: 4_000 });
    expect(breakdown.windowSize).toBe(128_000);
    expect(breakdown.reserved).toBe(4_000);
  });

  it('adds the answer being written, which Go cannot know yet', () => {
    const breakdown = buildAIContextBreakdownFromPreview(preview(), { windowSize: 16_000, reservedOutput: 2_000 }, 700);
    expect(breakdown.segments.find((segment) => segment.id === 'assistant')?.size).toBe(2_200);
  });

  it('says so when messages were left out or the workspace was cut, and calls an unsendable message full', () => {
    const trimmed = buildAIContextBreakdownFromPreview(preview({ omittedMessages: 3, workspaceTrimmed: 'active_tab' }), { windowSize: 16_000, reservedOutput: 2_000 });
    expect(trimmed.omittedMessages).toBe(3);
    expect(trimmed.workspaceTrimmed).toBe('active_tab');
    const overflow = buildAIContextBreakdownFromPreview(preview({ overflow: true, userBytes: 40_000 }), { windowSize: 16_000, reservedOutput: 2_000 });
    expect(overflow.level).toBe('full');
    expect(overflow.overflow).toBe(true);
  });

  it('warns at 80% of the prompt budget, like the local estimate', () => {
    const near = buildAIContextBreakdownFromPreview(preview({ workspaceBytes: 10_500, boundBytes: 0, userBytes: 1_300, assistantBytes: 0 }), { windowSize: 16_000, reservedOutput: 2_000 });
    expect(near.pressure).toBeGreaterThan(0.8);
    expect(near.level).toBe('warn');
  });
});

describe('the answer being written', () => {
  it('is measured apart from the stored history', () => {
    const measure = measureAIChatHistory([
      message({ role: 'user', content: 'q' }),
      message({ role: 'assistant', content: 'partial answer', loading: true }),
    ]);
    expect(measure.messageCount).toBe(1);
    expect(measure.assistant).toBe(0);
    expect(measure.pendingAssistant).toBe(MESSAGE_ENVELOPE_BYTES + 14);
  });

  it('is nothing before the first word, or for a notice that is never sent', () => {
    expect(measureAIChatHistory([message({ role: 'assistant', content: '', loading: true })]).pendingAssistant).toBe(0);
    expect(measureAIChatHistory([message({ role: 'assistant', content: 'error', loading: true, excludeFromAIContext: true })]).pendingAssistant).toBe(0);
  });
});
