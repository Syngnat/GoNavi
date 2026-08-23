import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import RequestDiagnosticsWorkbench from './RequestDiagnosticsWorkbench';

describe('RequestDiagnosticsWorkbench', () => {
  it('renders the privacy boundary and an empty diagnostic panel', () => {
    const markup = renderToStaticMarkup(
      <RequestDiagnosticsWorkbench
        tab={{ id: 'request-diagnostics', title: '请求诊断', type: 'request-diagnostics', connectionId: '' }}
        backend={{}}
      />,
    );
    expect(markup).toContain('请求诊断');
    expect(markup).toContain('不保存 SQL、结果行、连接地址或凭证');
    expect(markup).toContain('按请求 ID 过滤');
    expect(markup).toContain('生成诊断包');
    expect(markup).toContain('导出前会先展示采集范围和脱敏结果');
    expect(markup).toContain('失败任务最小复现包');
    expect(markup).toContain('查询、同步、导入和 MCP 失败');
    expect(markup).toContain('导入前显示脱敏清单');
    expect(markup).toContain('导入复现包');
    expect(markup).toContain('暂无可导出的失败任务');
    expect(markup).toContain('暂无请求追踪');
  });
});
