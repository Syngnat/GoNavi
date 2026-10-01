import React from 'react';
import { create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { AIChatContextMeter } from './AIChatContextMeter';

vi.mock('antd', async () => {
  const actual = await vi.importActual<typeof import('antd')>('antd');
  return {
    ...actual,
    Tooltip: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
  };
});

const textOf = (renderer: ReturnType<typeof create>) => JSON.stringify(renderer.toJSON());

describe('AIChatContextMeter', () => {
  it('shows usage against the window, converting 1000k to 1M', () => {
    const renderer = create(<AIChatContextMeter usageChars={12_800} maxChars={1_000_000} />);

    expect(textOf(renderer)).toContain('12.8k');
    expect(textOf(renderer)).toContain('1M');
  });

  it('is read-only: no menu trigger, since the tier is chosen in the provider settings', () => {
    const renderer = create(<AIChatContextMeter usageChars={0} maxChars={500_000} />);

    expect(renderer.root.findAllByType('button')).toHaveLength(0);
    expect(textOf(renderer)).toContain('500k');
    expect(textOf(renderer)).not.toContain('is-adjustable');
  });

  it('warns once usage passes 80% of the window', () => {
    const renderer = create(<AIChatContextMeter usageChars={90_000} maxChars={100_000} />);
    expect(textOf(renderer)).toContain('is-warn');
  });
});
