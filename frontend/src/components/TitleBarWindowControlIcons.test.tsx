import React from 'react';
import { create } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';

import {
  TitleBarCloseIcon,
  TitleBarMaximizeIcon,
  TitleBarMinimizeIcon,
  TitleBarRestoreIcon,
  resolveTitleBarWindowToggleIcon,
} from './TitleBarWindowControlIcons';

describe('TitleBarWindowControlIcons', () => {
  it('renders thin-line minimize / maximize / restore / close glyphs', () => {
    const asNode = (node: ReturnType<ReturnType<typeof create>['toJSON']>) => (
      Array.isArray(node) ? node[0] : node
    );
    const min = asNode(create(<TitleBarMinimizeIcon />).toJSON());
    const max = asNode(create(<TitleBarMaximizeIcon />).toJSON());
    const restore = asNode(create(<TitleBarRestoreIcon />).toJSON());
    const close = asNode(create(<TitleBarCloseIcon />).toJSON());

    expect(min?.type).toBe('svg');
    expect(max?.props?.viewBox).toBe('0 0 12 12');
    expect(JSON.stringify(max)).toContain('rx');
    expect(JSON.stringify(restore)).toContain('titlebar-window-control-restore-front');
    expect(JSON.stringify(close)).toContain('M3.1 3.1l5.8 5.8');
  });

  it('switches maximize and restore icons by kind', () => {
    const maximizeTree = create(resolveTitleBarWindowToggleIcon('maximize')).toJSON();
    const restoreTree = create(resolveTitleBarWindowToggleIcon('restore')).toJSON();
    expect(JSON.stringify(maximizeTree)).toContain('7.3');
    expect(JSON.stringify(restoreTree)).toContain('titlebar-window-control-restore-front');
  });
});
