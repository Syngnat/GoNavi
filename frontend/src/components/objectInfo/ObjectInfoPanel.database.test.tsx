// @vitest-environment jsdom
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

const objectInfoState = vi.hoisted(() => ({
  current: {} as Record<string, unknown>,
}));

vi.mock('../../i18n', () => ({
  t: (key: string) => (
    key === 'object_info.section.database_ddl' ? '建库 SQL' : key
  ),
}));
vi.mock('./hooks/useObjectInfo', () => ({
  useObjectInfo: () => objectInfoState.current,
}));

import ObjectInfoContent from './ObjectInfoPanel';

const collectText = (node: any): string => {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(collectText).join('');
  return collectText(node.children || []);
};

describe('ObjectInfoContent database definition', () => {
  it('shows database name, connection context, and CREATE DATABASE SQL', () => {
    objectInfoState.current = {
      target: {
        kind: 'database',
        connectionId: 'conn-1',
        dbName: 'front_end_sys_dev',
      },
      details: null,
      unsupported: false,
      ddl: [
        'CREATE DATABASE `front_end_sys_dev`',
        '  DEFAULT CHARACTER SET utf8mb4',
        '  COLLATE utf8mb4_0900_ai_ci;',
      ].join('\n'),
      loadState: 'ready',
      reload: vi.fn(),
      databaseDdlUnsupported: false,
      loadError: '',
      connectionName: '开发 240',
    };

    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(<ObjectInfoContent />);
    });

    expect(renderer.root.findByProps({ className: 'gn-object-info-head-name' }).props.title)
      .toBe('front_end_sys_dev');
    const meta = renderer.root.findByProps({ className: 'gn-object-info-meta' });
    expect(collectText(meta.props.children)).toBe('开发 240');
    expect(collectText(renderer.toJSON())).toContain('CREATE DATABASE');
    expect(collectText(renderer.root.findByProps({ className: 'gn-object-info-ddl-title' }).props.children))
      .toBe('建库 SQL');

    act(() => renderer.unmount());
  });

  it('shows a database-specific unsupported message', () => {
    objectInfoState.current = {
      target: {
        kind: 'database',
        connectionId: 'conn-1',
        dbName: 'metrics',
      },
      details: null,
      unsupported: false,
      ddl: '',
      loadState: 'ready',
      reload: vi.fn(),
      databaseDdlUnsupported: true,
      loadError: '',
      connectionName: 'Influx',
    };

    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(<ObjectInfoContent />);
    });

    expect(collectText(renderer.toJSON())).toContain('object_info.message.database_ddl_unsupported');
    act(() => renderer.unmount());
  });
});
