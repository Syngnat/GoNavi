import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useImportPreviewState } from '../components/importPreview/hooks/useImportPreviewState';
import { useImportPreviewActions } from '../components/importPreview/hooks/useImportPreviewActions';
import { buildImportParserOptions } from '../components/importPreview/importPreviewModel';
import type { ImportPreviewStateApi } from '../components/importPreview/hooks/useImportPreviewState';

const mocks = vi.hoisted(() => ({
  preview: vi.fn(), columns: vi.fn(), execute: vi.fn(), notify: vi.fn(),
  store: { theme: 'light', connections: [{ id: 'hive', name: 'Hive', config: { type: 'hive', host: 'warehouse', port: 10000, user: '' } }] },
}));
vi.mock('../store', () => ({ useStore: (selector: (state: typeof mocks.store) => unknown) => selector(mocks.store) }));
vi.mock('../i18n/provider', () => ({ useOptionalI18n: () => null }));
vi.mock('./productionRiskConfirm', () => ({ confirmProductionRisk: async () => true }));
vi.mock('./sidebarDatabaseRefresh', () => ({ dispatchSidebarTableDataRefresh: mocks.notify }));
vi.mock('./webRpc', () => ({
  invokeAppWithSignal: (_method: string, _args: unknown[], _signal: AbortSignal, fallback: () => Promise<unknown>) => fallback(),
  isWebRPCAbortError: () => false,
}));
vi.mock('../../wailsjs/go/app/App', () => ({
  PreviewImportFileWithOptions: mocks.preview, DBGetColumns: mocks.columns,
  ImportDataWithProgressOptions: mocks.execute, ExportImportErrorRows: vi.fn(), CancelImportJob: vi.fn(),
}));
vi.mock('../../wailsjs/runtime/runtime', () => ({ EventsOn: () => vi.fn() }));
vi.mock('antd', async () => {
  const React = await import('react');
  return {
    Space: ({ children }: { children?: React.ReactNode }) => React.createElement('span', null, children),
    Button: ({ children, onClick, disabled, type }: { children?: React.ReactNode; onClick?: () => void; disabled?: boolean; type?: string }) =>
      React.createElement('button', { onClick, disabled, 'data-primary': type === 'primary' }, children),
  };
});

const previewRows = [{ text: null }, { text: 'NULL' }, { text: '' }, { text: String.fromCharCode(92) + 'n' }];

beforeEach(() => {
  mocks.store.connections[0].config.type = 'hive';
  mocks.preview.mockReset().mockResolvedValue({ success: true, data: { columns: ['text'], totalRows: 4, previewRows, sourceIdentity: { token: 'identity' } } });
  mocks.columns.mockReset().mockResolvedValue({ success: true, data: [{ name: 'text', type: 'STRING' }] });
  mocks.execute.mockReset().mockResolvedValue({ success: true, data: { success: 4, failed: 0 } });
  mocks.notify.mockReset();
});

const mountImport = async (filePath: string) => {
  let current: ImportPreviewStateApi | undefined;
  function Harness() {
    const state = useImportPreviewState({ connectionId: 'hive', visible: true, filePath, dbName: 'default', tableName: 'target', continueOnError: false, importOptions: undefined, onImportingChange: undefined });
    current = state;
    const actions = useImportPreviewActions({ ...state, filePath, dbName: 'default', tableName: 'target', onSuccess: vi.fn(), onClose: vi.fn() });
    return actions.footer;
  }
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<Harness />); });
  return { renderer, state: () => current!, rerender: () => act(async () => renderer.update(<Harness />)), cleanup: () => act(() => renderer.unmount()) };
};

describe('Hive lossless preview and execution import options', () => {
  it.each(['csv', 'json', 'xlsx'])('sends losslessHive for both %s preview and actual import without rewriting values', async extension => {
    const filePath = '/imports/values.' + extension;
    const view = await mountImport(filePath);
    try {
      expect(mocks.preview).toHaveBeenCalledWith(filePath, expect.objectContaining({ losslessHive: true }));
      expect(view.state().previewData?.previewRows).toEqual(previewRows);
      const button = view.renderer.root.findByProps({ 'data-primary': true });
      expect(button.props.disabled).toBe(false);
      await act(async () => { await button.props.onClick(); });
      expect(mocks.execute).toHaveBeenCalledWith(expect.anything(), 'default', 'target', filePath,
        expect.objectContaining({ losslessHive: true, sourceIdentityToken: 'identity', columnMappings: { text: 'text' } }));
    } finally { view.cleanup(); }
  });

  it('recognizes Hive aliases and custom Hive drivers without changing legacy defaults', () => {
    for (const type of ['hive', 'hive2', 'hiveserver2', 'hs2', 'apache-hive']) expect(buildImportParserOptions(undefined, false, { type }).losslessHive).toBe(true);
    expect(buildImportParserOptions(undefined, false, { type: 'custom', driver: 'hive' }).losslessHive).toBe(true);
    for (const type of ['mysql', 'postgres', 'unknown']) expect(buildImportParserOptions(undefined, false, { type })).toEqual(buildImportParserOptions(undefined, false));
  });

  it('invalidates preview parsing when the same target switches between Hive and non-Hive', async () => {
    const view = await mountImport('/imports/values.csv');
    try {
      expect(mocks.preview.mock.calls[0][1]).toHaveProperty('losslessHive', true);
      mocks.store.connections[0].config.type = 'mysql';
      await view.rerender();
      expect(mocks.preview).toHaveBeenCalledTimes(2);
      expect(mocks.preview.mock.calls[1][1]).not.toHaveProperty('losslessHive');
    } finally { view.cleanup(); }
  });

  it('leaves non-Hive parsing and import defaults unchanged', async () => {
    mocks.store.connections[0].config.type = 'mysql';
    const view = await mountImport('/imports/values.csv');
    try {
      expect(mocks.preview.mock.calls[0][1]).not.toHaveProperty('losslessHive');
      await act(async () => { await view.renderer.root.findByProps({ 'data-primary': true }).props.onClick(); });
      expect(mocks.execute.mock.calls[0][4]).not.toHaveProperty('losslessHive');
    } finally { view.cleanup(); }
  });
});
