import React from 'react';
import TestRenderer from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { GonaviDescriptionList, GonaviLogView, GonaviSection, GonaviStatCard, GonaviStatusBar } from './layout';

describe('plugin UI layout components', () => {
  it('renders a section with description and actions', () => {
    const tree = TestRenderer.create(
      <GonaviSection title="Connection" description="Local" actions={<span>Refresh</span>}>
        <div>body</div>
      </GonaviSection>,
    ).toJSON();
    expect(JSON.stringify(tree)).toContain('Connection');
    expect(JSON.stringify(tree)).toContain('Refresh');
    expect(JSON.stringify(tree)).toContain('body');
  });

  it('renders stat, description and status data as text', () => {
    const tree = TestRenderer.create(
      <div>
        <GonaviStatCard label="Rows" value={42} tone="success" hint="capped" />
        <GonaviDescriptionList items={[{ label: 'Host', value: '127.0.0.1', mono: true }]} />
        <GonaviStatusBar left="ready" right="12 ms" />
      </div>,
    ).toJSON();
    const text = JSON.stringify(tree);
    expect(text).toContain('Rows');
    expect(text).toContain('127.0.0.1');
    expect(text).toContain('12 ms');
  });

  it('renders log lines and an empty state', () => {
    expect(JSON.stringify(TestRenderer.create(<GonaviLogView lines={['one', 'two']} />).toJSON())).toContain('one\\ntwo');
    expect(JSON.stringify(TestRenderer.create(<GonaviLogView lines={[]} />).toJSON())).toContain('No output');
  });
});
