import { describe, expect, it } from 'vitest';
import { GONAVI_CHART_COLORS, gonaviChartSeries } from './chart';

describe('chart helpers', () => {
  it('fills names and cycles palette colours', () => {
    const series = gonaviChartSeries([
      { key: 'a' },
      { key: 'b', name: 'B' },
      { key: 'c', color: '#123456' },
    ]);
    expect(series[0]).toEqual({ key: 'a', name: 'a', color: GONAVI_CHART_COLORS[0] });
    expect(series[1]).toEqual({ key: 'b', name: 'B', color: GONAVI_CHART_COLORS[1] });
    expect(series[2]).toEqual({ key: 'c', name: 'c', color: '#123456' });
  });

  it('cycles past the palette length', () => {
    const series = gonaviChartSeries(Array.from({ length: GONAVI_CHART_COLORS.length + 1 }, (_, index) => ({ key: `k${index}` })));
    expect(series.at(-1)?.color).toBe(GONAVI_CHART_COLORS[0]);
  });
});
