import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useSidebarExternalSqlWorkflow } from './SidebarExternalSqlWorkflow';

const mocks = vi.hoisted(() => ({
  uploadBrowserFile: vi.fn(),
  messageError: vi.fn(),
  messageWarning: vi.fn(),
}));

vi.mock('../../utils/browserFileTransfer', () => ({
  uploadBrowserFile: mocks.uploadBrowserFile,
}));

vi.mock('antd', async () => {
  const React = await import('react');
  const form = {
    getFieldValue: vi.fn(),
    resetFields: vi.fn(),
    setFieldsValue: vi.fn(),
    validateFields: vi.fn(),
  };
  return {
    Button: (props: any) => React.createElement('button', props, props.children),
    Form: Object.assign(
      (props: any) => React.createElement('form', props, props.children),
      {
        Item: (props: any) => React.createElement('form-item', props, props.children),
        useForm: () => [form],
      },
    ),
    Input: (props: any) => React.createElement('input', props),
    Progress: (props: any) => React.createElement('progress', props),
    Select: (props: any) => React.createElement('select', props),
    message: {
      error: mocks.messageError,
      warning: mocks.messageWarning,
      success: vi.fn(),
    },
  };
});

vi.mock('../common/ResizableDraggableModal', () => ({
  default: (props: any) => React.createElement('modal', props, props.children),
}));

describe('useSidebarExternalSqlWorkflow web file selection', () => {
  beforeEach(() => {
    mocks.uploadBrowserFile.mockReset();
    mocks.uploadBrowserFile.mockResolvedValue({
      filePath: 'web-sql-upload-token',
      name: 'seed.sql',
      fileSize: 1024,
      fileSizeMB: '0.1',
    });
    mocks.messageError.mockReset();
    mocks.messageWarning.mockReset();
  });

  it('uploads the selected SQL file and opens the existing execution workbench tab', async () => {
    const addTab = vi.fn();
    const inputNode = { value: '', click: vi.fn() };
    let workflow: ReturnType<typeof useSidebarExternalSqlWorkflow> | null = null;
    let renderer!: ReactTestRenderer;
    const Harness = () => {
      workflow = useSidebarExternalSqlWorkflow({
        connections: [{
          id: 'mysql-1',
          name: 'MySQL',
          config: { type: 'mysql', host: '127.0.0.1', port: 3306, user: 'root' },
        } as any],
        externalSQLDirectories: [],
        activeTab: { connectionId: 'mysql-1', dbName: 'app' },
        connectionIds: ['mysql-1'],
        selectedNodesRef: { current: [] },
        addTab,
        openDataImportWorkbench: vi.fn(),
        saveExternalSQLDirectory: vi.fn(),
        deleteExternalSQLDirectory: vi.fn(),
        updateRecentSQLFilePath: vi.fn(),
        removeRecentSQLFilesByPath: vi.fn(),
        moveRecentSQLFilesByDirectory: vi.fn(),
        removeRecentSQLFilesByDirectory: vi.fn(),
        refreshGlobalExternalSQLRootNode: vi.fn(async () => undefined),
        setExpandedKeys: vi.fn(),
        setAutoExpandParent: vi.fn(),
        getActiveContext: () => ({ connectionId: 'mysql-1', dbName: 'app' }),
        isWebRuntime: true,
      });
      return <input {...workflow.browserSQLFileInputProps} />;
    };

    await act(async () => {
      renderer = create(<Harness />, {
        createNodeMock: (element) => element.type === 'input' ? inputNode : null,
      });
    });

    await act(async () => {
      await workflow!.handleOpenSQLFileFromToolbar();
    });
    expect(inputNode.click).toHaveBeenCalledOnce();

    const file = { name: 'seed.sql', size: 1024 } as File;
    await act(async () => {
      await renderer.root.findByType('input').props.onChange({
        target: { files: [file], value: 'seed.sql' },
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.uploadBrowserFile).toHaveBeenCalledWith(file, 'sql-execution');
    expect(addTab).toHaveBeenCalledWith(expect.objectContaining({
      type: 'sql-file-execution',
      connectionId: 'mysql-1',
      dbName: 'app',
      filePath: 'web-sql-upload-token',
      sqlFileExecutionFileName: 'seed.sql',
      sqlFileExecutionFileSizeMB: '0.1',
    }));
  });
});
