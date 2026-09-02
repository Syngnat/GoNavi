import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ResultDiffPageResult, ResultDiffSummary } from '../../utils/resultDiff/types';
import ResultDiffPanel from './ResultDiffPanel';

const testState = vi.hoisted(() => ({
  fetchResultDiffPage: vi.fn(),
  message: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
  paginationProps: [] as any[],
  previewProps: [] as any[],
  selectProps: [] as any[],
}));

vi.mock('../../i18n', () => ({ t: (key: string) => key }));
vi.mock('../../i18n/provider', () => ({ useOptionalI18n: () => null }));
vi.mock('../../utils/resultDiff/client', () => ({
  closeResultDiffJob: vi.fn(async () => undefined),
  fetchResultDiffPage: testState.fetchResultDiffPage,
  formatCellValue: (value: unknown) => String(value ?? 'NULL'),
}));
vi.mock('../../utils/resultDiff/exportDiff', () => ({
  buildDiffExportContent: vi.fn(),
  buildSummaryText: vi.fn(() => ''),
  copyTextToClipboard: vi.fn(async () => undefined),
  downloadTextFile: vi.fn(),
}));
vi.mock('../../hooks/useManagedPointerInteraction', () => ({
  useManagedPointerInteraction: () => ({ startInteraction: () => false }),
}));
vi.mock('@ant-design/icons', async () => {
  const ReactModule = await import('react');
  const Icon = () => ReactModule.createElement('span');
  return { CloseOutlined: Icon, CompressOutlined: Icon, CopyOutlined: Icon, DownloadOutlined: Icon, ExpandOutlined: Icon };
});
vi.mock('antd', async () => {
  const ReactModule = await import('react');
  const passthrough = (tag: string) => ({ children, ...props }: any) => ReactModule.createElement(tag, props, children);
  const Typography = {
    Paragraph: passthrough('typography-paragraph'),
    Text: passthrough('typography-text'),
    Title: passthrough('typography-title'),
  };
  return {
    Button: passthrough('button'),
    ConfigProvider: passthrough('config-provider'),
    Drawer: passthrough('drawer'),
    Empty: passthrough('empty'),
    Pagination: (props: any) => {
      testState.paginationProps.push(props);
      return ReactModule.createElement('pagination-control', props);
    },
    Select: (props: any) => {
      testState.selectProps.push(props);
      return ReactModule.createElement('select-control', props);
    },
    Space: passthrough('space'),
    Table: passthrough('table-control'),
    Tag: passthrough('tag'),
    Tooltip: passthrough('tooltip'),
    Typography,
    message: testState.message,
  };
});
vi.mock('./ResultDiffModePreview', async () => {
  const ReactModule = await import('react');
  return {
    default: (props: any) => {
      testState.previewProps.push(props);
      return ReactModule.createElement('result-diff-preview');
    },
    estimateResultDiffColumnWidth: () => 120,
    renderColumnHeaderTitle: (name: string) => name,
    translateDiffKind: (kind: string) => kind,
  };
});

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

const deferred = <T,>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
};

const summary: ResultDiffSummary = {
  added: 1,
  removed: 1,
  changed: 1,
  same: 0,
  unmatched: 0,
  leftRowCount: 2,
  rightRowCount: 2,
  commonColumns: ['id', 'name'],
  leftOnlyColumns: [],
  rightOnlyColumns: [],
  changedColumnFreq: {},
  keyColumns: ['id'],
  comparedColumns: ['name'],
};

const pageResult = (id: number, total: number): ResultDiffPageResult => ({
  jobId: 'job-1',
  total,
  offset: 0,
  limit: 50,
  rows: [{ kind: 'changed', keys: { id }, left: { id }, right: { id } }],
});

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

const latest = <T,>(items: T[]): T => items[items.length - 1];

const kindSelect = () => [...testState.selectProps]
  .reverse()
  .find((props) => props.options?.some((option: { value: string }) => option.value === 'all'));

describe('ResultDiffPanel page loading', () => {
  beforeEach(() => {
    testState.fetchResultDiffPage.mockReset();
    testState.message.error.mockReset();
    testState.paginationProps.length = 0;
    testState.previewProps.length = 0;
    testState.selectProps.length = 0;
  });

  it('ignores a stale page response after the filter changes', async () => {
    const stalePage = deferred<ResultDiffPageResult>();
    const currentPage = deferred<ResultDiffPageResult>();
    testState.fetchResultDiffPage.mockImplementation(({ kinds }: { kinds?: string[] }) => (
      kinds?.[0] === 'changed' ? currentPage.promise : stalePage.promise
    ));

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <ResultDiffPanel
          open
          jobId="job-1"
          summary={summary}
          leftLabel="Left"
          rightLabel="Right"
          onClose={() => undefined}
        />,
      );
    });

    act(() => kindSelect().onChange('changed'));
    await flush();
    expect(testState.fetchResultDiffPage).toHaveBeenCalledTimes(2);

    stalePage.resolve(pageResult(1, 99));
    await flush();
    expect(latest(testState.previewProps)).toEqual(expect.objectContaining({ loading: true, rows: [] }));
    expect(latest(testState.paginationProps).total).toBe(0);

    currentPage.resolve(pageResult(2, 7));
    await flush();
    expect(latest(testState.previewProps)).toEqual(expect.objectContaining({
      loading: false,
      rows: [expect.objectContaining({ keys: { id: 2 } })],
    }));
    expect(latest(testState.paginationProps).total).toBe(7);
    expect(testState.message.error).not.toHaveBeenCalled();
    renderer.unmount();
  });
});
