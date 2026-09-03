import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAIChatTypewriter } from './useAIChatTypewriter';

const flushAnimationFrames = (frames: Map<number, FrameRequestCallback>, passes: number) => {
  for (let pass = 0; pass < passes; pass += 1) {
    const pending = [...frames.entries()];
    frames.clear();
    for (const [, callback] of pending) {
      callback(0);
    }
  }
};

describe('useAIChatTypewriter', () => {
  const previousRequestAnimationFrame = Object.getOwnPropertyDescriptor(globalThis, 'requestAnimationFrame');
  const previousCancelAnimationFrame = Object.getOwnPropertyDescriptor(globalThis, 'cancelAnimationFrame');
  let renderer: ReactTestRenderer | null = null;
  let displayedContent = '';
  let isAnimating = false;
  let scheduledFrames: Map<number, FrameRequestCallback>;
  let nextFrameId: number;

  const Harness = ({ content, isStreaming }: { content: string; isStreaming: boolean }) => {
    const typewriter = useAIChatTypewriter(content, isStreaming);
    displayedContent = typewriter.content;
    isAnimating = typewriter.isAnimating;
    return null;
  };

  beforeEach(() => {
    scheduledFrames = new Map();
    nextFrameId = 1;
    Object.defineProperty(globalThis, 'requestAnimationFrame', {
      configurable: true,
      value: vi.fn((callback: FrameRequestCallback) => {
        const frameId = nextFrameId++;
        scheduledFrames.set(frameId, callback);
        return frameId;
      }),
    });
    Object.defineProperty(globalThis, 'cancelAnimationFrame', {
      configurable: true,
      value: vi.fn((frameId: number) => scheduledFrames.delete(frameId)),
    });
  });

  afterEach(() => {
    act(() => renderer?.unmount());
    renderer = null;
    for (const [name, descriptor] of [
      ['requestAnimationFrame', previousRequestAnimationFrame],
      ['cancelAnimationFrame', previousCancelAnimationFrame],
    ] as const) {
      if (descriptor) {
        Object.defineProperty(globalThis, name, descriptor);
      } else {
        Reflect.deleteProperty(globalThis, name);
      }
    }
  });

  it('reveals a streamed batch progressively instead of committing it in one render', () => {
    const streamedText = 'SSE batches should animate smoothly, even when a full paragraph arrives together.';
    act(() => {
      renderer = create(<Harness content="" isStreaming />);
    });

    act(() => {
      renderer?.update(<Harness content={streamedText} isStreaming />);
    });

    expect(displayedContent).toBe('');
    expect(isAnimating).toBe(true);
    expect(scheduledFrames.size).toBe(1);

    act(() => flushAnimationFrames(scheduledFrames, 1));

    expect(displayedContent).not.toBe(streamedText);
    expect(streamedText.startsWith(displayedContent)).toBe(true);

    act(() => flushAnimationFrames(scheduledFrames, 12));

    expect(displayedContent).toBe(streamedText);
    expect(isAnimating).toBe(false);
  });

  it('drains buffered text after the stream completes but renders existing history immediately', () => {
    const streamedText = '中文、emoji 🚀 和 English 都按 Unicode 字符边界平滑显示。';
    act(() => {
      renderer = create(<Harness content="" isStreaming />);
    });
    act(() => {
      renderer?.update(<Harness content={streamedText} isStreaming />);
    });
    act(() => flushAnimationFrames(scheduledFrames, 1));

    expect(displayedContent).not.toBe(streamedText);
    expect(isAnimating).toBe(true);

    act(() => {
      renderer?.update(<Harness content={streamedText} isStreaming={false} />);
      flushAnimationFrames(scheduledFrames, 12);
    });

    expect(displayedContent).toBe(streamedText);
    expect(isAnimating).toBe(false);

    act(() => {
      renderer?.update(<Harness content="persisted history" isStreaming={false} />);
    });

    expect(displayedContent).toBe('persisted history');
    expect(scheduledFrames.size).toBe(0);
  });
});
