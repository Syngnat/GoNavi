import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import QueryEditorToolbar from './QueryEditorToolbar';

const antdState = vi.hoisted(() => ({
  buttonProps: [] as any[],
  dropdownProps: [] as any[],
  selectProps: [] as any[],
  transactionProps: [] as any[],
}));

vi.mock('antd', () => ({
  Button: (props: any) => {
    antdState.buttonProps.push(props);
    return (
      <button type="button" aria-label={props['aria-label']} onClick={props.onClick}>
        {props.children}
      </button>
    );
  },
  Dropdown: (props: any) => {
    antdState.dropdownProps.push(props);
    return <div data-dropdown>{props.children}</div>;
  },
  Select: (props: any) => {
    antdState.selectProps.push(props);
    return <div data-select={props.className}>{props.placeholder}</div>;
  },
  Tooltip: ({ children }: any) => <>{children}</>,
}));

vi.mock('@ant-design/icons', () => {
  const Icon = () => <span />;
  return {
    DiffOutlined: Icon,
    DownOutlined: Icon,
    EyeInvisibleOutlined: Icon,
    EyeOutlined: Icon,
    EllipsisOutlined: Icon,
    FormatPainterOutlined: Icon,
    PlayCircleOutlined: Icon,
    RobotOutlined: Icon,
    SearchOutlined: Icon,
    SaveOutlined: Icon,
    SettingOutlined: Icon,
    StopOutlined: Icon,
  };
});

vi.mock('../i18n', () => ({
  t: (key: string) => key,
}));

vi.mock('../i18n/provider', () => ({
  useOptionalI18n: () => ({ t: (key: string) => key }),
}));

vi.mock('./QueryEditorTransactionSettings', () => ({
  default: (props: any) => {
    antdState.transactionProps.push(props);
    return <div data-transaction-settings />;
  },
}));

const disabledShortcut = { enabled: false, combo: '' };

const buildProps = (overrides: Record<string, unknown> = {}) => ({
  isV2Ui: true,
  currentConnectionId: 'es-1',
  currentDb: 'events',
  queryCapableConnections: [{ id: 'es-1', name: 'Elasticsearch', config: { type: 'elasticsearch' } } as any],
  dbList: ['events', 'logs'],
  maxRows: 5000,
  sqlEditorCommitMode: 'manual' as const,
  sqlEditorAutoCommitDelayMs: 0,
  pendingTransactionToolbar: <span>pending transaction</span>,
  runQueryShortcutBinding: disabledShortcut,
  saveQueryShortcutBinding: disabledShortcut,
  formatSqlShortcutBinding: disabledShortcut,
  triggerSqlAiCompletionShortcutBinding: disabledShortcut,
  toggleQueryResultsPanelShortcutBinding: disabledShortcut,
  activeShortcutPlatform: 'windows' as const,
  isResultPanelVisible: true,
  wordWrapEnabled: false,
  loading: false,
  saveMoreMenuItems: [{ key: 'save-file', label: 'save file' }],
  formatSettingsMenu: [{ key: 'format-setting', label: 'format setting' }],
  onConnectionChange: vi.fn(),
  onDatabaseChange: vi.fn(),
  onMaxRowsChange: vi.fn(),
  onCommitModeChange: vi.fn(),
  onAutoCommitDelayMsChange: vi.fn(),
  onCaptureEditorCursorPosition: vi.fn(),
  onRun: vi.fn(),
  onCancel: vi.fn(),
  onQuickSave: vi.fn(),
  onFindInEditor: vi.fn(),
  onToggleWordWrap: vi.fn(),
  onFormat: vi.fn(),
  onTriggerSqlAiCompletion: vi.fn(),
  onToggleResultPanelVisibility: vi.fn(),
  onAIAction: vi.fn(),
  ...overrides,
});

const menuKeys = (): string[] => antdState.dropdownProps.flatMap((props) => (
  (props.menu?.items || []).flatMap((item: any) => item?.key ? [String(item.key)] : [])
));

const buttonByLabel = (label: string) => [...antdState.buttonProps]
  .reverse()
  .find((props) => props['aria-label'] === label);

describe('QueryEditorToolbar Elasticsearch mode', () => {
  let renderer: ReactTestRenderer | null = null;

  beforeEach(() => {
    renderer?.unmount();
    renderer = null;
    antdState.buttonProps = [];
    antdState.dropdownProps = [];
    antdState.selectProps = [];
    antdState.transactionProps = [];
  });

  it('shows ES request actions and hides SQL-only controls', () => {
    const onRun = vi.fn();
    const onRunAll = vi.fn();
    const templateMenuItems = [{ key: 'match_all', label: 'match all' }];

    act(() => {
      renderer = create(<QueryEditorToolbar {...buildProps({
        editorMode: 'elasticsearch',
        onRun,
        onRunAll,
        templateMenuItems,
      })} />);
    });

    expect(antdState.selectProps).toHaveLength(2);
    expect(antdState.selectProps[1]).toMatchObject({
      placeholder: 'query_editor.elasticsearch.placeholder.index_optional',
      allowClear: true,
    });
    expect(antdState.transactionProps).toHaveLength(0);
    expect(menuKeys()).toEqual(expect.arrayContaining(['match_all', 'ai-generate']));
    expect(menuKeys()).not.toEqual(expect.arrayContaining([
      'ai-inline-completion',
      'save-file',
      'format-setting',
    ]));

    const labels = antdState.buttonProps.map((props) => props['aria-label']).filter(Boolean);
    expect(labels).toEqual(expect.arrayContaining([
      'query_editor.elasticsearch.action.templates',
      'query_editor.elasticsearch.action.run_current',
      'query_editor.elasticsearch.action.run_all',
      'query_editor.action.save',
      'query_editor.elasticsearch.action.ai',
      'query_editor.elasticsearch.action.format',
    ]));
    expect(labels).not.toEqual(expect.arrayContaining([
      'query_editor.action.more',
      'query_editor.action.find_in_editor',
      'query_editor.action.format_sql',
      'app.shortcuts.action.triggerSqlAiCompletion.label',
    ]));
    expect(JSON.stringify(renderer?.toJSON())).not.toContain('pending transaction');

    act(() => {
      buttonByLabel('query_editor.elasticsearch.action.run_current')?.onClick();
      buttonByLabel('query_editor.elasticsearch.action.run_all')?.onClick();
    });
    expect(onRun).toHaveBeenCalledTimes(1);
    expect(onRunAll).toHaveBeenCalledTimes(1);
  });

  it('keeps the existing SQL toolbar when editorMode is omitted', () => {
    act(() => {
      renderer = create(<QueryEditorToolbar {...buildProps()} />);
    });

    expect(antdState.selectProps).toHaveLength(3);
    expect(antdState.transactionProps).toHaveLength(1);
    expect(menuKeys()).toEqual(expect.arrayContaining([
      'ai-inline-completion',
      'save-file',
      'format-setting',
    ]));
    expect(buttonByLabel('query_editor.action.run')).toBeDefined();
    expect(buttonByLabel('query_editor.action.more')).toBeDefined();
    expect(buttonByLabel('query_editor.elasticsearch.action.run_all')).toBeUndefined();
    expect(JSON.stringify(renderer?.toJSON())).toContain('pending transaction');
  });

  it('shows a working stop action while an ES request is running', () => {
    const onCancel = vi.fn();
    act(() => {
      renderer = create(<QueryEditorToolbar {...buildProps({
        editorMode: 'elasticsearch',
        loading: true,
        onCancel,
      })} />);
    });

    act(() => {
      buttonByLabel('query_editor.action.stop')?.onClick();
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(antdState.selectProps).toHaveLength(2);
    expect(antdState.selectProps.every((props) => props.disabled === true)).toBe(true);
  });
});
