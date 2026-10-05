import { readCssWithImports } from './readCssWithImports';

export const readV2ThemeCss = (): string => [
  readCssWithImports(new URL('../v2-theme.css', import.meta.url)),
  readCssWithImports(new URL('../styles/v2-theme-workbench.css', import.meta.url)),
  readCssWithImports(new URL('../styles/v2-theme-ai.css', import.meta.url)),
].join('\n');
