import { describe, expect, it } from 'vitest';

import { buildTableOverviewCompactGridStyle } from './tableOverviewCompactColumns';

describe('table overview compact grid columns', () => {
  it('keeps flexible defaults when no width has been adjusted', () => {
    const style = buildTableOverviewCompactGridStyle(['name', 'rows']) as Record<string, string>;

    expect(style['--gn-table-overview-compact-columns']).toBe(
      'minmax(240px, 1.7fr) minmax(88px, 0.65fr)',
    );
    expect(style['--gn-table-overview-compact-min-width']).toBe('328px');
  });

  it('uses explicit widths and grows the scroll width to match', () => {
    const style = buildTableOverviewCompactGridStyle(
      ['name', 'rows'],
      { name: 360, rows: 72 },
    ) as Record<string, string>;

    expect(style['--gn-table-overview-compact-columns']).toBe('360px 88px');
    expect(style['--gn-table-overview-compact-min-width']).toBe('448px');
  });
});
