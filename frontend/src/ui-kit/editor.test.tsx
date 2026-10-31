/** @vitest-environment jsdom */
import React from 'react';
import TestRenderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { GonaviSqlEditor } from './components';

describe('GonaviSqlEditor', () => {
  it('runs on Ctrl+Enter and exposes an explicit Run button', () => {
    const onRun = vi.fn();
    const renderer = TestRenderer.create(<GonaviSqlEditor value="select 1" onRun={onRun} />);
    const textarea = renderer.root.findByType('textarea');
    const preventDefault = vi.fn();
    textarea.props.onKeyDown({ key: 'Enter', ctrlKey: true, metaKey: false, preventDefault });
    expect(onRun).toHaveBeenCalledTimes(1);
    expect(preventDefault).toHaveBeenCalled();
    const button = renderer.root.findAllByType('button').find((node) => node.props.children === 'Run');
    expect(button).toBeTruthy();
  });

  it('does not run plain Enter', () => {
    const onRun = vi.fn();
    const renderer = TestRenderer.create(<GonaviSqlEditor onRun={onRun} />);
    renderer.root.findByType('textarea').props.onKeyDown({ key: 'Enter', ctrlKey: false, metaKey: false, preventDefault: vi.fn() });
    expect(onRun).not.toHaveBeenCalled();
  });
});
