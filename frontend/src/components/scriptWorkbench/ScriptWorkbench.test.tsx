/** @vitest-environment jsdom */
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TabData } from '../../types';
import { useStore } from '../../store';
import { I18nProvider } from '../../i18n/provider';
import {
  getDirtyWorkbenchTabCloseGuards,
  getWorkbenchTabCloseGuardStates,
} from '../../utils/workbenchTabCloseProtection';
import type {
  ScriptLibrarySnapshot,
  ScriptLibraryScript,
  ScriptInputBinding,
  ScriptRunEvent,
  ScriptWorkbenchAdapter,
} from './scriptWorkbenchTypes';
import ScriptWorkbench from './ScriptWorkbench';
import { ScriptWorkbenchWriteDialog } from './ScriptWorkbenchWriteDialog';
import { ScriptWorkbenchContextBar } from './ScriptWorkbenchContextBar';
import { loadScriptWorkbenchDraft } from './scriptWorkbenchDraftStorage';

vi.mock('antd', () => ({
  Alert: ({
    message,
    description,
    closable,
    onClose,
  }: {
    message: string;
    description: string;
    closable?: boolean;
    onClose?: () => void;
  }) => (
    <div data-testid="script-alert">
      {message}: {description}
      {closable ? <button type="button" aria-label="Dismiss error" onClick={onClose} /> : null}
    </div>
  ),
  Spin: () => <span data-testid="script-spin" />,
  Drawer: ({
    open,
    title,
    children,
    footer,
  }: {
    open?: boolean;
    title?: React.ReactNode;
    children?: React.ReactNode;
    footer?: React.ReactNode;
  }) => (
    <div data-testid="script-settings-drawer" data-open={open ? 'true' : 'false'}>
      {title}
      {children}
      {footer}
    </div>
  ),
  Select: ({
    id,
    value,
    onChange,
    options = [],
  }: {
    id?: string;
    value?: string[];
    onChange?: (value: string[]) => void;
    options?: Array<{ value: string; label: string }>;
  }) => (
    <select
      id={id}
      multiple
      value={value}
      onChange={(event) => onChange?.(
        Array.from(event.currentTarget.selectedOptions, (option) => option.value),
      )}
    >
      {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
  ),
  Switch: ({ checked, disabled, onChange, 'aria-label': ariaLabel }: {
    checked?: boolean;
    disabled?: boolean;
    onChange?: (value: boolean) => void;
    'aria-label'?: string;
  }) => (
    <button
      type="button"
      aria-label={ariaLabel}
      aria-pressed={checked}
      disabled={disabled}
      onClick={() => onChange?.(!checked)}
    />
  ),
}));

vi.mock('../MonacoEditor', () => ({
  default: ({ value, onChange }: { value?: string; onChange?: (value: string) => void }) => (
    <textarea
      data-testid="script-monaco"
      value={value}
      onChange={(event) => onChange?.(event.target.value)}
    />
  ),
}));

const tab: TabData = {
  id: 'script-workbench:new',
  title: 'Script Workbench',
  type: 'script-workbench',
  connectionId: '',
  preserveUnboundConnection: true,
};

const snapshot: ScriptLibrarySnapshot = {
  owner: 'local',
  scripts: [],
  folders: [],
  canWrite: true,
  canShare: true,
  sharedOnly: false,
};

const createAdapter = (): ScriptWorkbenchAdapter => ({
  listLibrary: vi.fn(async () => snapshot),
  getScript: vi.fn(async () => {
    throw new Error('not used');
  }),
  saveScript: vi.fn(async () => {
    throw new Error('not used');
  }),
  saveFolder: vi.fn(async () => {
    throw new Error('not used');
  }),
  deleteScript: vi.fn(async () => undefined),
  deleteFolder: vi.fn(async () => undefined),
  shareScript: vi.fn(async () => {
    throw new Error('not used');
  }),
  shareFolder: vi.fn(async () => {
    throw new Error('not used');
  }),
  chooseInputFile: vi.fn(async () => null),
  listInputSheets: vi.fn(async () => []),
  authorizeWrite: vi.fn(async () => ({ requiresConfirmation: false })),
  runScript: vi.fn(async (_request, observer) => {
    const emit = (event: ScriptRunEvent) => observer.onEvent(event);
    emit({ type: 'progress', progress: { current: 3, total: 3, startedAt: 1, elapsedMs: 40 } });
    emit({
      type: 'output',
      output: {
        outputId: 'run-1:0',
        name: 'result',
        columns: ['ok'],
        rows: [{ ok: 1 }],
        page: 1,
        pageSize: 100,
        totalRows: 1,
      },
    });
    emit({ type: 'result', result: { success: true, durationMs: 40 } });
    return { runId: 'run-1', startedAt: 1 };
  }),
  cancelRun: vi.fn(async () => undefined),
  getOutputPage: vi.fn(async () => ({
    outputId: 'run-1:0',
    name: 'result',
    columns: ['ok'],
    rows: [{ ok: 1 }],
    page: 1,
    pageSize: 100,
    totalRows: 1,
  })),
});

const textOf = (renderer: ReactTestRenderer): string => JSON.stringify(renderer.toJSON());

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
};

describe('ScriptWorkbench', () => {
  beforeEach(() => {
    delete (window as any).go;
    window.localStorage.clear();
    useStore.setState({ connections: [] });
  });

  it('does not silently fall back to demo data when the backend binding is missing', async () => {
    delete (window as any).go;
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(<ScriptWorkbench tab={tab} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    const text = textOf(renderer!);
    expect(text).toContain('The script workbench backend is unavailable');
    expect(text).not.toContain('Excel million-ID batch query');
    act(() => renderer!.unmount());
  });

  it('runs a read-only script through the injected adapter and renders its output', async () => {
    const adapter = createAdapter();
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(<ScriptWorkbench tab={tab} adapter={adapter} />);
      await Promise.resolve();
    });
    const runButton = renderer!.root.findByProps({ 'data-testid': 'script-workbench-run' });
    await act(async () => {
      runButton.props.onClick();
      await Promise.resolve();
    });

    expect(adapter.runScript).toHaveBeenCalledWith(expect.objectContaining({
      allowWrite: false,
      script: expect.stringContaining('gonavi.db.query'),
    }), expect.anything(), expect.anything());
    const text = textOf(renderer!);
    expect(text).toContain('Completed');
    expect(text).toContain('result');
    act(() => renderer!.unmount());
  });

  it('requires explicit write confirmation before calling the run backend', async () => {
    const adapter = createAdapter();
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(<ScriptWorkbench tab={tab} adapter={adapter} />);
      await Promise.resolve();
    });
    const allowWrite = renderer!.root.findAll((node) => (
      node.type === 'button' && node.props['aria-label'] === 'Allow write operations'
    ))[0];
    act(() => allowWrite.props.onClick());
    const runButton = renderer!.root.findByProps({ 'data-testid': 'script-workbench-run' });
    act(() => runButton.props.onClick());

    expect(adapter.runScript).not.toHaveBeenCalled();
    expect(renderer!.root.findAllByProps({ 'data-testid': 'script-workbench-write-dialog' })).toHaveLength(1);
    act(() => renderer!.unmount());
  });

  it('authorizes write runs and forwards the one-time token to the backend', async () => {
    const adapter = createAdapter();
    adapter.authorizeWrite = vi.fn(async () => ({
      requiresConfirmation: true,
      confirmationToken: 'write-token-1',
    }));
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(<ScriptWorkbench tab={tab} adapter={adapter} />);
      await Promise.resolve();
    });
    const allowWrite = renderer!.root.findAll((node) => (
      node.type === 'button' && node.props['aria-label'] === 'Allow write operations'
    ))[0];
    act(() => allowWrite.props.onClick());
    act(() => renderer!.root.findByProps({ 'data-testid': 'script-workbench-run' }).props.onClick());
    await act(async () => {
      renderer!.root.findByType(ScriptWorkbenchWriteDialog).props.onResolve(true);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(adapter.authorizeWrite).toHaveBeenCalledWith(expect.objectContaining({
      allowWrite: true,
      batchSize: 500,
      inListLimit: 1000,
    }), expect.anything());
    expect(adapter.runScript).toHaveBeenCalledWith(expect.objectContaining({
      allowWrite: true,
      confirmationToken: 'write-token-1',
      limits: expect.objectContaining({
        defaultBatch: 500,
        defaultInList: 1000,
      }),
    }), expect.anything(), expect.anything());
    act(() => renderer!.unmount());
  });

  it('invalidates a pending write authorization when the draft changes', async () => {
    const adapter = createAdapter();
    const authorization = deferred<{ requiresConfirmation: boolean; confirmationToken: string }>();
    let authorizationSignal: AbortSignal | undefined;
    adapter.authorizeWrite = vi.fn((_request, signal) => {
      authorizationSignal = signal;
      return authorization.promise;
    });
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(<ScriptWorkbench tab={tab} adapter={adapter} />);
      await Promise.resolve();
    });
    const allowWrite = renderer!.root.findAll((node) => (
      node.type === 'button' && node.props['aria-label'] === 'Allow write operations'
    ))[0];
    act(() => allowWrite.props.onClick());
    act(() => renderer!.root.findByProps({ 'data-testid': 'script-workbench-run' }).props.onClick());
    await act(async () => {
      renderer!.root.findByType(ScriptWorkbenchWriteDialog).props.onResolve(true);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(adapter.authorizeWrite).toHaveBeenCalledTimes(1);
    expect(authorizationSignal?.aborted).toBe(false);

    act(() => {
      renderer!.root.findByProps({ 'data-testid': 'script-monaco' }).props.onChange({
        target: { value: 'gonavi.output("changed", []);' },
      });
    });
    await act(async () => {
      authorization.resolve({
        requiresConfirmation: true,
        confirmationToken: 'stale-token',
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(authorizationSignal?.aborted).toBe(true);
    expect(adapter.runScript).not.toHaveBeenCalled();
    expect(renderer!.root.findByProps({ 'data-testid': 'script-monaco' }).props.value)
      .toContain('changed');
    act(() => renderer!.unmount());
  });

  it('keeps the write switch disabled until the permission snapshot loads', async () => {
    const adapter = createAdapter();
    adapter.listLibrary = vi.fn(() => new Promise<ScriptLibrarySnapshot>(() => undefined));
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(<ScriptWorkbench tab={tab} adapter={adapter} />);
      await Promise.resolve();
    });
    const allowWrite = renderer!.root.findAll((node) => (
      node.type === 'button' && node.props['aria-label'] === 'Allow write operations'
    ))[0];
    expect(allowWrite.props.disabled).toBe(true);
    act(() => renderer!.unmount());
  });

  it('registers an explicit draft close guard and persists before detach', async () => {
    const adapter = createAdapter();
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(<ScriptWorkbench tab={tab} adapter={adapter} />);
      await Promise.resolve();
    });
    act(() => {
      renderer!.root.findByProps({ 'data-testid': 'script-monaco' }).props.onChange({
        target: { value: 'gonavi.output("draft", [{ changed: true }]);' },
      });
    });
    const guards = getDirtyWorkbenchTabCloseGuards([tab.id]);
    expect(guards).toHaveLength(1);
    await act(async () => {
      await guards[0].guard.persist?.();
    });
    expect(loadScriptWorkbenchDraft(tab.id)).toMatchObject({
      name: 'Untitled script',
      source: 'gonavi.output("draft", [{ changed: true }]);',
    });
    act(() => renderer!.unmount());
    expect(getDirtyWorkbenchTabCloseGuards([tab.id])).toHaveLength(0);
  });

  it('exposes a running close guard that can explicitly cancel the active run', async () => {
    const adapter = createAdapter();
    adapter.runScript = vi.fn(async () => ({ runId: 'run-guard', startedAt: 1 }));
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(<ScriptWorkbench tab={tab} adapter={adapter} />);
      await Promise.resolve();
    });
    await act(async () => {
      renderer!.root.findByProps({ 'data-testid': 'script-workbench-run' }).props.onClick();
      await Promise.resolve();
    });
    const runningState = getWorkbenchTabCloseGuardStates([tab.id])
      .find((state) => state.running);
    expect(runningState).toBeTruthy();

    await act(async () => {
      await runningState?.guard.cancelRun?.();
    });
    expect(adapter.cancelRun).toHaveBeenCalledWith('run-guard');
    act(() => renderer!.unmount());
  });

  it('keeps the backend adapter stable when the interface language changes', async () => {
    const getSnapshot = vi.fn(async () => ({ success: true, data: snapshot }));
    (window as any).go = {
      app: {
        App: {
          GetScriptLibrarySnapshot: getSnapshot,
        },
      },
    };
    const onPreferenceChange = vi.fn();
    const renderTree = (preference: 'en-US' | 'zh-CN') => (
      <I18nProvider
        preference={preference}
        systemLanguages={['en-US']}
        onPreferenceChange={onPreferenceChange}
      >
        <ScriptWorkbench tab={tab} />
      </I18nProvider>
    );
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(renderTree('en-US'));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(getSnapshot).toHaveBeenCalledTimes(1);
    await act(async () => {
      renderer!.update(renderTree('zh-CN'));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(getSnapshot).toHaveBeenCalledTimes(1);
    act(() => renderer!.unmount());
  });

  it('supports inline workbench name editing for editable scripts', async () => {
    const adapter = createAdapter();
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(<ScriptWorkbench tab={tab} adapter={adapter} />);
      await Promise.resolve();
    });
    const renameButton = renderer!.root.findAll((node) => (
      node.type === 'button' && node.props['aria-label'] === 'Rename'
    ))[0];
    act(() => renameButton.props.onClick());
    const input = renderer!.root.findByProps({ 'aria-label': 'Script name' });
    act(() => {
      input.props.onChange({ target: { value: 'Renamed script' } });
    });
    act(() => {
      renderer!.root.findByProps({ 'aria-label': 'Script name' })
        .props.onKeyDown({ key: 'Enter', preventDefault: vi.fn() });
    });

    expect(textOf(renderer!)).toContain('Renamed script');
    act(() => renderer!.unmount());
  });

  it('shows local run failures in the unified results area', async () => {
    const adapter = createAdapter();
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(<ScriptWorkbench tab={tab} adapter={adapter} />);
      await Promise.resolve();
    });
    act(() => {
      renderer!.root.findByProps({ 'data-testid': 'script-monaco' }).props.onChange({
        target: { value: '' },
      });
    });
    act(() => {
      renderer!.root.findByProps({ 'data-testid': 'script-workbench-run' }).props.onClick();
    });
    expect(textOf(renderer!)).toContain('Script operation failed');
    expect(textOf(renderer!)).toContain('Script code cannot be empty');
    act(() => {
      renderer!.root.findByProps({ 'data-testid': 'script-workbench-run' }).props.onClick();
    });
    expect(textOf(renderer!)).toContain('Script code cannot be empty');
    act(() => renderer!.unmount());
  });

  it('ignores a file chosen for a draft instance that was replaced while the picker was open', async () => {
    const adapter = createAdapter();
    const chosenFile = deferred<ScriptInputBinding | null>();
    adapter.chooseInputFile = vi.fn(() => chosenFile.promise);
    adapter.saveScript = vi.fn(async (input) => ({
      id: 'script-created',
      name: input.name,
      description: input.description || '',
      code: input.code,
      owner: 'local',
      visibility: input.visibility,
      folderId: input.folderId,
      connections: [],
      inputs: [],
      allowWrite: false,
      batchSize: 500,
      inListLimit: 1_000,
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
    }));
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(<ScriptWorkbench tab={tab} adapter={adapter} />);
      await Promise.resolve();
    });
    act(() => {
      renderer!.root.findByProps({ className: 'gn-script-context-add' }).props.onClick();
    });
    act(() => {
      renderer!.root.findByProps({ 'data-testid': 'script-workbench-library' }).props.onClick();
    });
    await act(async () => {
      renderer!.root.findByProps({ 'data-testid': 'script-library-new-script' }).props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      chosenFile.resolve({
        alias: 'late_file',
        name: 'late.xlsx',
        sheetName: 'Sheet1',
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(renderer!.root.findByType(ScriptWorkbenchContextBar).props.inputs).toEqual([]);
    act(() => renderer!.unmount());
  });

  it('loads XLSX worksheets, defaults to the first sheet, and forwards the selected sheet', async () => {
    const adapter = createAdapter();
    adapter.chooseInputFile = vi.fn(async () => ({
      alias: 'orders',
      name: 'orders.xlsx',
      path: '/tmp/orders.xlsx',
      headerRow: 1,
    }));
    adapter.listInputSheets = vi.fn(async () => ['Sheet1', 'Sheet2']);
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(<ScriptWorkbench tab={tab} adapter={adapter} />);
      await Promise.resolve();
    });

    await act(async () => {
      renderer!.root.findByProps({ className: 'gn-script-context-add' }).props.onClick();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(adapter.listInputSheets).toHaveBeenCalledWith(expect.objectContaining({
      alias: 'orders',
      name: 'orders.xlsx',
      path: '/tmp/orders.xlsx',
    }));
    const sheetSelect = renderer!.root.findByProps({ 'data-testid': 'script-context-sheet-0' });
    expect(sheetSelect.props.value).toBe('Sheet1');
    expect(sheetSelect.findAllByType('option').map((option) => option.props.value))
      .toEqual(expect.arrayContaining(['Sheet1', 'Sheet2']));

    act(() => {
      sheetSelect.props.onChange({ target: { value: 'Sheet2' } });
    });
    await act(async () => {
      renderer!.root.findByProps({ 'data-testid': 'script-workbench-run' }).props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(adapter.runScript).toHaveBeenCalledWith(expect.objectContaining({
      inputs: [expect.objectContaining({
        alias: 'orders',
        sheetName: 'Sheet2',
      })],
    }), expect.anything(), expect.anything());
    act(() => renderer!.unmount());
  });

  it('lets the draft override the run limits and forwards the resolved values', async () => {
    const adapter = createAdapter();
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(<ScriptWorkbench tab={tab} adapter={adapter} />);
      await Promise.resolve();
    });

    act(() => {
      renderer!.root.findByProps({ 'data-testid': 'script-limit-timeout' }).props.onChange({
        target: { value: '45' },
      });
    });
    act(() => {
      renderer!.root.findByProps({ 'data-testid': 'script-limit-db-calls' }).props.onChange({
        target: { value: '20000' },
      });
    });
    act(() => {
      renderer!.root.findByProps({ 'data-testid': 'script-limit-output-rows' }).props.onChange({
        target: { value: '80000' },
      });
    });
    act(() => {
      renderer!.root.findByProps({ 'data-testid': 'script-limit-memory' }).props.onChange({
        target: { value: '768' },
      });
    });

    await act(async () => {
      renderer!.root.findByProps({ 'data-testid': 'script-workbench-run' }).props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(adapter.runScript).toHaveBeenCalledWith(expect.objectContaining({
      limits: expect.objectContaining({
        timeoutMs: 45 * 60_000,
        maxDbCalls: 20_000,
        maxOutputRows: 80_000,
        memoryLimitBytes: 768 * 1024 * 1024,
      }),
    }), expect.anything(), expect.anything());
    act(() => renderer!.unmount());
  });

  it('restores runtime defaults when run-limit overrides are reset', async () => {
    const adapter = createAdapter();
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(<ScriptWorkbench tab={tab} adapter={adapter} />);
      await Promise.resolve();
    });

    act(() => {
      renderer!.root.findByProps({ 'data-testid': 'script-limit-timeout' }).props.onChange({
        target: { value: '45' },
      });
    });
    expect(renderer!.root.findByProps({ 'data-testid': 'script-limit-timeout' }).props.value).toBe(45);

    act(() => {
      renderer!.root.findByProps({ 'data-testid': 'script-reset-limits' }).props.onClick();
    });
    expect(renderer!.root.findByProps({ 'data-testid': 'script-limit-timeout' }).props.value).toBe(30);

    await act(async () => {
      renderer!.root.findByProps({ 'data-testid': 'script-workbench-run' }).props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(adapter.runScript).toHaveBeenCalledWith(expect.objectContaining({
      limits: expect.objectContaining({
        timeoutMs: 30 * 60_000,
        maxDbCalls: 10_000,
        maxOutputRows: 50_000,
        memoryLimitBytes: 512 * 1024 * 1024,
      }),
    }), expect.anything(), expect.anything());
    act(() => renderer!.unmount());
  });

  it('supports multiple aliases for the same connection and different databases', async () => {
    useStore.setState({
      connections: [{
        id: 'conn-prod',
        name: 'prod',
        environmentType: 'production',
        config: {
          type: 'mysql',
          host: 'db.internal',
          port: 3306,
          user: 'reader',
          database: 'orders',
          useSSH: false,
          ssh: { host: '', port: 22, user: '' },
        },
      }],
    });
    const adapter = createAdapter();
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(<ScriptWorkbench tab={tab} adapter={adapter} />);
      await Promise.resolve();
    });
    const add = renderer!.root.findByProps({ 'data-testid': 'script-workbench-add-connection' });
    act(() => add.props.onClick());
    act(() => add.props.onClick());

    expect(renderer!.root.findByProps({ 'data-testid': 'script-workbench-binding-alias-0' }).props.value).toBe('prod');
    expect(renderer!.root.findByProps({ 'data-testid': 'script-workbench-binding-alias-1' }).props.value).toBe('prod2');
    act(() => renderer!.root.findByProps({ 'data-testid': 'script-workbench-binding-database-1' }).props.onChange({
      target: { value: 'archive_center' },
    }));
    expect(renderer!.root.findByProps({ 'data-testid': 'script-workbench-binding-database-1' }).props.value).toBe('archive_center');
    act(() => renderer!.unmount());
    useStore.setState({ connections: [] });
  });

  it('saves a dirty current script before sharing it from the library', async () => {
    const savedTab: TabData = {
      id: 'script-workbench:script-1',
      title: 'Nightly',
      type: 'script-workbench',
      connectionId: '',
      scriptId: 'script-1',
      scriptDisplayName: 'Nightly',
    };
    const script = {
      id: 'script-1',
      name: 'Nightly',
      description: 'desc',
      code: 'gonavi.log("server copy");',
      owner: 'local',
      visibility: 'private' as const,
      connections: [],
      inputs: [],
      allowWrite: false,
      batchSize: 500,
      inListLimit: 1_000,
      revision: 1,
      canEdit: true,
      canShare: true,
      createdAt: 1,
      updatedAt: 1,
    };
    const adapter = createAdapter();
    adapter.listLibrary = vi.fn(async () => ({
      ...snapshot,
      scripts: [script],
    }));
    adapter.getScript = vi.fn(async () => script);
    adapter.saveScript = vi.fn(async (input) => ({
      ...script,
      ...input,
      id: 'script-1',
      revision: 2,
      updatedAt: 2,
    }));
    adapter.shareScript = vi.fn(async (input) => ({
      ...script,
      code: 'gonavi.log("edited copy");',
      revision: 3,
      visibility: input.visibility,
    }));
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(<ScriptWorkbench tab={savedTab} adapter={adapter} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    act(() => {
      renderer!.root.findByProps({ 'data-testid': 'script-monaco' }).props.onChange({
        target: { value: 'gonavi.log("edited copy");' },
      });
      renderer!.root.findByProps({ 'data-testid': 'script-workbench-library' }).props.onClick();
    });
    const dialog = renderer!.root.findByProps({ 'data-testid': 'script-library-dialog' });
    const shareButton = dialog.findAll((node) => (
      node.type === 'button'
      && node.props['aria-label'] === 'Share'
      && node.props.disabled !== true
    ))[0];
    await act(async () => {
      shareButton.props.onClick();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(adapter.saveScript).toHaveBeenCalledWith(expect.objectContaining({
      id: 'script-1',
      code: 'gonavi.log("edited copy");',
      description: 'desc',
      revision: 1,
    }));
    expect(adapter.shareScript).toHaveBeenCalledWith({
      id: 'script-1',
      revision: 2,
      visibility: 'shared',
    });
    expect(textOf(renderer!)).toContain('Stop sharing');
    act(() => renderer!.unmount());
  });

  it('locks the header share action while a share request is in flight', async () => {
    const adapter = createAdapter();
    const shared = deferred<ScriptLibraryScript>();
    const savedShareScript: ScriptLibraryScript = {
      id: 'script-share',
      name: 'Untitled script',
      description: '',
      code: 'const result = gonavi.db.query("prod", {\n  sql: "SELECT 1 AS ok",\n  maxRows: 100,\n});\n\ngonavi.output("result", result.rows);\n',
      owner: 'local',
      visibility: 'private',
      canEdit: true,
      canShare: true,
      connections: [],
      inputs: [],
      allowWrite: false,
      batchSize: 500,
      inListLimit: 1_000,
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
    };
    adapter.saveScript = vi.fn(async () => savedShareScript);
    adapter.shareScript = vi.fn(() => shared.promise);
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(<ScriptWorkbench tab={tab} adapter={adapter} />);
      await Promise.resolve();
    });
    await act(async () => {
      renderer!.root.findByProps({ 'data-testid': 'script-workbench-share' }).props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(adapter.shareScript).toHaveBeenCalledTimes(1);
    expect(renderer!.root.findByProps({ 'data-testid': 'script-workbench-share' }).props.disabled)
      .toBe(true);
    act(() => {
      renderer!.root.findByProps({ 'data-testid': 'script-workbench-share' }).props.onClick();
    });
    expect(adapter.shareScript).toHaveBeenCalledTimes(1);

    await act(async () => {
      shared.resolve({
        ...savedShareScript,
        visibility: 'shared',
        revision: 2,
      });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(renderer!.root.findByProps({ 'data-testid': 'script-workbench-share' }).props.disabled)
      .toBe(false);
    act(() => renderer!.unmount());
  });
});
