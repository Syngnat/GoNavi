/** @vitest-environment jsdom */

import React from 'react';
import { Switch } from 'antd';
import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { WorkspaceSqlStatementHighlightRow } from './WorkspaceSqlStatementHighlightRow';

const storeState = vi.hoisted(() => ({
  sqlStatementHighlight: {
    highlightCurrentSqlStatement: true,
    confirmSqlStatementRun: false,
  },
  setSqlStatementHighlightSettings: vi.fn(),
}));

vi.mock('../../store', () => ({
  useStore: <T,>(selector: (state: typeof storeState) => T): T => selector(storeState),
}));

vi.mock('../../i18n/provider', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

describe('WorkspaceSqlStatementHighlightRow', () => {
  beforeEach(() => {
    storeState.sqlStatementHighlight.highlightCurrentSqlStatement = true;
    storeState.sqlStatementHighlight.confirmSqlStatementRun = false;
    storeState.setSqlStatementHighlightSettings.mockReset();
  });

  it('updates both settings and disables confirmation when highlighting is off', () => {
    const renderer = create(<WorkspaceSqlStatementHighlightRow />);
    let switches = renderer.root.findAllByType(Switch);

    act(() => switches[0].props.onChange(false));
    act(() => switches[1].props.onChange(true));

    expect(storeState.setSqlStatementHighlightSettings).toHaveBeenNthCalledWith(1, {
      highlightCurrentSqlStatement: false,
    });
    expect(storeState.setSqlStatementHighlightSettings).toHaveBeenNthCalledWith(2, {
      confirmSqlStatementRun: true,
    });

    storeState.sqlStatementHighlight.highlightCurrentSqlStatement = false;
    storeState.sqlStatementHighlight.confirmSqlStatementRun = true;
    act(() => renderer.update(<WorkspaceSqlStatementHighlightRow />));
    switches = renderer.root.findAllByType(Switch);

    expect(switches[1].props.disabled).toBe(true);
    expect(switches[1].props.checked).toBe(true);
  });
});
