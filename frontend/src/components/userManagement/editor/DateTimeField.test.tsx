/** @vitest-environment jsdom */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DateTimeField from './DateTimeField';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const render = (value: string) => act(() => {
  root.render(<DateTimeField value={value} disabled={false} label="valid until" onChange={vi.fn()} />);
});

describe('DateTimeField', () => {
  it('shows a date picker for empty and parseable values', () => {
    render('');
    expect(container.querySelector('.ant-picker')).not.toBeNull();
    render('2026-12-31 08:30:00');
    expect(container.querySelector('.ant-picker')).not.toBeNull();
    expect((container.querySelector('.ant-picker input') as HTMLInputElement).value).toBe('2026-12-31 08:30:00');
  });

  it('keeps unparseable server values visible in a text box instead of dropping them', () => {
    render('infinity');
    expect(container.querySelector('.ant-picker')).toBeNull();
    expect((container.querySelector('input') as HTMLInputElement).value).toBe('infinity');
  });
});
