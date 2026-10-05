import React from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const client = vi.hoisted(() => ({ canPreviewAgentContext: vi.fn(() => true), previewAgentContext: vi.fn() }));
vi.mock('./aiContextPreviewClient', () => client);
vi.mock('./useAIWorkspaceSnapshot', () => ({ getAIWorkspaceSourceInstanceID: () => 'instance-1' }));

import type { AIChatAttachment, AIContextItem } from '../../types';
import { PREVIEW_DEBOUNCE_MS, useAIContextBreakdown } from './useAIContextBreakdown';
import { recordPublishedWorkspaceSnapshot } from './aiWorkspaceSnapshotMeasure';
import type { AgentContextPreview } from './aiContextPreviewClient';
import type { AIContextBreakdown } from './aiContextBreakdown';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const preview = (overrides: Partial<AgentContextPreview> = {}): AgentContextPreview => ({
  windowTokens: 16_384, reservedOutputTokens: 2_048, instructionsBytes: 0, workspaceBytes: 3_000, boundBytes: 0, userBytes: 0, assistantBytes: 0,
  toolBytes: 0, retainedMessages: 0, omittedMessages: 0, overflow: false, ...overrides,
});

const provider = { id: 'gonavi-ai', model: 'gonavi-sql', maxTokens: 2_048 };
const history = { user: 0, assistant: 0, toolResults: 0, messageCount: 0, pendingAssistant: 0 };

interface Props {
  input?: string;
  sessionId?: string;
  items?: AIContextItem[];
  attachments?: AIChatAttachment[];
  window?: number;
}

const mounted: Array<ReturnType<typeof create>> = [];

const mount = (initial: Props = {}) => {
  let latest: AIContextBreakdown | null = null;
  const Probe: React.FC<Props> = ({ input = '', sessionId, items = [], attachments = [], window: windowSize = 4_096 }) => {
    latest = useAIContextBreakdown({
      history, contextWindow: windowSize, activeProvider: provider, contextItems: items, input, draftAttachments: attachments, sessionId,
    });
    return null;
  };
  let renderer!: ReturnType<typeof create>;
  act(() => { renderer = create(<Probe {...initial} />); });
  mounted.push(renderer);
  return { value: () => latest, update: (props: Props) => act(() => renderer.update(<Probe {...props} />)) };
};

const pause = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

beforeEach(() => {
  vi.useFakeTimers();
  client.canPreviewAgentContext.mockReset().mockReturnValue(true);
  client.previewAgentContext.mockReset().mockResolvedValue(preview());
  recordPublishedWorkspaceSnapshot(null);
});

afterEach(() => {
  // Every probe is released: a mounted one would hear about the next test's workspace and measure too.
  act(() => { mounted.splice(0).forEach((renderer) => renderer.unmount()); });
  vi.useRealTimers();
});

describe('useAIContextBreakdown', () => {
  it('shows nothing until Go has measured, instead of a number that may be wrong', async () => {
    const view = mount();
    expect(view.value()).toBeNull();
    await pause(PREVIEW_DEBOUNCE_MS + 10);
    expect(view.value()).not.toBeNull();
  });

  it('shows what Go measured: a new chat with a large workspace is not full', async () => {
    // The desktop published a 22 KB workspace; the agent sends 3 KB of it, against the window of the Gateway rather than the stale 4k of the panel.
    recordPublishedWorkspaceSnapshot({ activeContext: {}, tabs: [{ draft: 'x'.repeat(22_000) }] });
    const view = mount({ window: 4_096 });
    await pause(PREVIEW_DEBOUNCE_MS + 10);
    const breakdown = view.value() as AIContextBreakdown;
    expect(breakdown.windowSize).toBe(16_384);
    expect(breakdown.used).toBe(3_000);
    expect(breakdown.pressure).toBeLessThan(0.3);
    expect(breakdown.level).toBe('ok');
  });

  it('asks for what the next message would carry: session, input, provider, bound context, and only a marker for an image', async () => {
    const items: AIContextItem[] = [{ kind: 'editor_selection', dbName: 'shop', tableName: '__gonavi_editor_selection__', ddl: '', label: 'q', content: 'select 1' }];
    const attachments: AIChatAttachment[] = [
      { id: 'a', name: 'shot.png', mimeType: 'image/png', size: 9, kind: 'image', dataUrl: `data:image/png;base64,${'A'.repeat(50_000)}`, ocr: { status: 'done', text: 'ERROR 1146' } },
      { id: 'b', name: 'notes.md', mimeType: 'text/markdown', size: 4, kind: 'markdown', text: '# notes' },
    ];
    mount({ input: 'why?', sessionId: 'session-7', items, attachments });
    await pause(PREVIEW_DEBOUNCE_MS + 10);

    expect(client.previewAgentContext).toHaveBeenCalledTimes(1);
    const request = client.previewAgentContext.mock.calls[0][0];
    expect(request).toMatchObject({ sessionId: 'session-7', content: 'why?', provider: 'gonavi-ai', model: 'gonavi-sql', contextSourceId: 'desktop', contextSourceInstanceId: 'instance-1' });
    const byName = (name: string, mediaType?: string) => request.attachments.filter((a: { name: string; mediaType: string }) => a.name === name && (!mediaType || a.mediaType === mediaType));
    expect(byName('shot.png', 'image/png')[0].data).toBe('data:image/png;base64,'); // not 50 KB of base64 per keystroke
    expect(byName('shot.png', 'application/vnd.gonavi.ocr+text')[0].data).toBe('ERROR 1146');
    expect(byName('notes.md')[0].data).toBe('# notes');
    expect(request.attachments.some((a: { mediaType: string }) => a.mediaType === 'application/vnd.gonavi.context+json')).toBe(true);
  });

  it('waits for typing to pause, and measures again for the text that is there then', async () => {
    const view = mount({ input: 'a' });
    await pause(100);
    view.update({ input: 'ab' });
    await pause(100);
    view.update({ input: 'abc' });
    await pause(PREVIEW_DEBOUNCE_MS + 10);
    expect(client.previewAgentContext).toHaveBeenCalledTimes(1);
    expect(client.previewAgentContext.mock.calls[0][0].content).toBe('abc');
  });

  it('measures again when the conversation, the session, or what is bound changes', async () => {
    const view = mount({ input: 'x', sessionId: 's1' });
    await pause(PREVIEW_DEBOUNCE_MS + 10);
    view.update({ input: 'x', sessionId: 's2' });
    await pause(PREVIEW_DEBOUNCE_MS + 10);
    view.update({ input: 'x', sessionId: 's2', items: [{ dbName: 'shop', tableName: 'orders', ddl: 'create table orders (id int)' }] });
    await pause(PREVIEW_DEBOUNCE_MS + 10);
    expect(client.previewAgentContext).toHaveBeenCalledTimes(3);
  });

  it('ignores an answer that arrives after a newer question', async () => {
    let releaseFirst: (value: AgentContextPreview) => void = () => undefined;
    client.previewAgentContext
      .mockImplementationOnce(() => new Promise((resolve) => { releaseFirst = resolve; }))
      .mockResolvedValueOnce(preview({ workspaceBytes: 500 }));
    const view = mount({ input: 'one' });
    await pause(PREVIEW_DEBOUNCE_MS + 10);
    view.update({ input: 'two' });
    await pause(PREVIEW_DEBOUNCE_MS + 10);
    expect(view.value()?.used).toBe(500);
    await act(async () => { releaseFirst(preview({ workspaceBytes: 9_999 })); });
    expect(view.value()?.used).toBe(500); // the late first answer must not overwrite it
  });

  it('estimates where Go cannot measure, with the workspace held to its share', async () => {
    client.canPreviewAgentContext.mockReturnValue(false);
    recordPublishedWorkspaceSnapshot({ activeContext: {}, tabs: [{ draft: 'x'.repeat(22_000) }] });
    const view = mount({ window: 16_384 });
    const breakdown = view.value() as AIContextBreakdown;
    expect(breakdown).not.toBeNull();
    expect(breakdown.used).toBeLessThanOrEqual(Math.floor((16_384 - 2_048) * 0.25));
    expect(client.previewAgentContext).not.toHaveBeenCalled();
  });

  it('falls back to the estimate when a measurement fails', async () => {
    client.previewAgentContext.mockRejectedValue(new Error('ledger locked'));
    const view = mount({ window: 16_384 });
    expect(view.value()).toBeNull();
    await pause(PREVIEW_DEBOUNCE_MS + 10);
    expect(view.value()).not.toBeNull();
  });

  it('draws nothing before the window is known', async () => {
    const view = mount({ window: 0 });
    await pause(PREVIEW_DEBOUNCE_MS + 10);
    expect(view.value()).toBeNull();
  });
});
