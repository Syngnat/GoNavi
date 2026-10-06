/**
 * Validated categorical palette (eight fixed slots, light and dark steps of the
 * same hues). Series take slots in order and never cycle; a remainder uses the
 * neutral. Scatter shows at most three series, the slots that stay apart when
 * every pair of points can overlap.
 */
const LIGHT_SERIES = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'];
const DARK_SERIES = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];

export const RESULT_CHART_SCATTER_MAX_SERIES = 3;

export interface ResultChartTheme {
  series: readonly string[];
  neutral: string;
  surface: string;
  text: string;
  mutedText: string;
  grid: string;
}

export const resultChartTheme = (darkMode: boolean): ResultChartTheme => (darkMode
  ? {
    series: DARK_SERIES,
    neutral: '#6e6d68',
    surface: '#1f1f1f',
    text: 'rgba(255, 255, 255, 0.86)',
    mutedText: 'rgba(255, 255, 255, 0.6)',
    grid: 'rgba(255, 255, 255, 0.08)',
  }
  : {
    series: LIGHT_SERIES,
    neutral: '#a3a29d',
    surface: '#ffffff',
    text: 'rgba(0, 0, 0, 0.85)',
    mutedText: 'rgba(0, 0, 0, 0.55)',
    grid: 'rgba(0, 0, 0, 0.08)',
  });
