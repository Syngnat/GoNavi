import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import ReproductionBundlePanel from './ReproductionBundlePanel';

vi.mock('antd', () => {
  const Descriptions: any = ({ children }: any) => <dl>{children}</dl>;
  Descriptions.Item = ({ children }: any) => <dd>{children}</dd>;
  return {
    Alert: ({ message: text }: any) => <div>{text}</div>,
    Button: ({ children, onClick }: any) => <button type="button" onClick={onClick}>{children}</button>,
    Descriptions,
    Empty: ({ description }: any) => <div>{description}</div>,
    Modal: ({ open, children, onCancel, onOk }: any) => open ? (
      <div data-modal="reproduction-preview">
        {children}
        <button type="button" data-action="cancel" onClick={onCancel}>取消</button>
        <button type="button" data-action="replay" onClick={onOk}>回放</button>
      </div>
    ) : null,
    Space: ({ children }: any) => <div>{children}</div>,
    Table: ({ dataSource = [], columns = [], rowKey }: any) => (
      <div>{dataSource.map((row: any) => (
        <div key={rowKey(row)}>{columns.map((column: any) => column.render?.(row[column.dataIndex], row) || row[column.dataIndex])}</div>
      ))}</div>
    ),
    Tag: ({ children }: any) => <span>{children}</span>,
    Typography: {
      Text: ({ children }: any) => <span>{children}</span>,
      Title: ({ children }: any) => <h2>{children}</h2>,
    },
    message: { error: vi.fn(), success: vi.fn() },
  };
});

describe('ReproductionBundlePanel', () => {
  it('previews the redaction manifest and cancel does not replay', async () => {
    const preview = vi.fn(async () => ({
      success: true,
      data: {
        appVersion: '0.9.3',
        source: { kind: 'query' as const, id: 'source-safe' },
        eventCount: 2,
        fixtureEngine: 'gonavi-fake-v1',
        offlineOnly: true,
        redaction: { credentials: 'excluded', sqlLiterals: 'removed' },
      },
    }));
    const replay = vi.fn(async () => ({ success: true, data: { reproduced: true, sourceKind: 'query' as const } }));
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <ReproductionBundlePanel
          isActive
          backend={{
            ListReproductionBundleSources: vi.fn(async () => ({ success: true, data: { items: [], warnings: [] } })),
            PreviewReproductionBundle: preview,
            ReplayReproductionBundle: replay,
          }}
        />,
      );
    });

    const input = renderer!.root.findByProps({ 'aria-label': '选择最小复现包' });
    await act(async () => {
      await input.props.onChange({
        target: { files: [{ text: async () => '{"safe":true}' }] },
      });
    });
    expect(preview).toHaveBeenCalledWith('{"safe":true}');
    const cancel = renderer!.root.findByProps({ 'data-action': 'cancel' });
    await act(async () => cancel.props.onClick());
    expect(replay).not.toHaveBeenCalled();
  });

  it('runs the fake fixture only after explicit confirmation', async () => {
    const replay = vi.fn(async () => ({ success: true, data: { reproduced: true, sourceKind: 'mcp' as const, errorKind: 'tool' } }));
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <ReproductionBundlePanel
          isActive
          backend={{
            ListReproductionBundleSources: vi.fn(async () => ({ success: true, data: { items: [], warnings: [] } })),
            PreviewReproductionBundle: vi.fn(async () => ({
              success: true,
              data: { source: { kind: 'mcp' as const, id: 'source-safe' }, offlineOnly: true, fixtureEngine: 'gonavi-fake-v1' },
            })),
            ReplayReproductionBundle: replay,
          }}
        />,
      );
    });
    const input = renderer!.root.findByProps({ 'aria-label': '选择最小复现包' });
    await act(async () => {
      await input.props.onChange({ target: { files: [{ text: async () => '{"fixture":true}' }] } });
    });
    const confirm = renderer!.root.findByProps({ 'data-action': 'replay' });
    await act(async () => confirm.props.onClick());
    expect(replay).toHaveBeenCalledTimes(1);
    expect(replay).toHaveBeenCalledWith('{"fixture":true}');
  });
});
