import { t as translateCatalog } from '../i18n/catalog';

export type DataTableDensity = 'comfortable' | 'standard' | 'compact';

export interface DataGridDisplaySettings {
  showDataTableVerticalBorders: boolean;
  /** 数据预览 / SQL 结果表是否显示行号列；默认开启 */
  showDataTableRowNumber: boolean;
  dataTableDensity: DataTableDensity;
  dataTableFontSize: number | null;
  dataTableFontSizeFollowGlobal: boolean;
  sidebarTreeFontSize: number | null;
  sidebarTreeFontSizeFollowGlobal: boolean;
}

export const DEFAULT_DATA_GRID_DISPLAY_SETTINGS: DataGridDisplaySettings = {
  showDataTableVerticalBorders: false,
  showDataTableRowNumber: true,
  dataTableDensity: 'comfortable',
  dataTableFontSize: null,
  dataTableFontSizeFollowGlobal: true,
  sidebarTreeFontSize: null,
  sidebarTreeFontSizeFollowGlobal: true,
};
export const MIN_DATA_TABLE_FONT_SIZE = 10;
export const MAX_DATA_TABLE_FONT_SIZE = 18;
export const MIN_SIDEBAR_TREE_FONT_SIZE = 10;
export const MAX_SIDEBAR_TREE_FONT_SIZE = 18;
// Keep enough room for the column title, filter trigger, sorter and resize handle.
// Default, manual and auto-fit widths must all preserve this invariant.
export const MIN_DATA_TABLE_COLUMN_WIDTH = 120;

type DensityOptionTranslator = (key: string) => string;

interface DensityParams {
  defaultColumnWidth: number;
  cellPadding: string;
  inputCellPadding: string;
  headerMinHeight: number;
  dataFontSize: number;
  metaFontSize: number;
}

const DENSITY_PARAMS: Record<DataTableDensity, DensityParams> = {
  comfortable: {
    defaultColumnWidth: 180,
    cellPadding: '8px',
    inputCellPadding: '0px 4px',
    headerMinHeight: 40,
    dataFontSize: 13,
    metaFontSize: 11,
  },
  standard: {
    defaultColumnWidth: 140,
    cellPadding: '5px 8px',
    inputCellPadding: '0px 3px',
    headerMinHeight: 34,
    dataFontSize: 13,
    metaFontSize: 10,
  },
  compact: {
    defaultColumnWidth: 100,
    cellPadding: '2px 6px',
    inputCellPadding: '0px 2px',
    headerMinHeight: 28,
    dataFontSize: 12,
    metaFontSize: 10,
  },
};

const DENSITY_OPTION_VALUES = [
  'comfortable',
  'standard',
  'compact',
] as const;

export const createDensityOptions = (
  translate: DensityOptionTranslator = (key) => translateCatalog('en-US', key),
) => DENSITY_OPTION_VALUES.map((value) => ({
  label: translate(`app.theme.data_table.density.${value}`),
  value,
}));

export const DENSITY_OPTIONS = createDensityOptions();

export const sanitizeDataTableDensity = (value: unknown): DataTableDensity => {
  if (value === 'standard' || value === 'compact') return value;
  return 'comfortable';
};

const sanitizeOptionalIntegerInRange = (
  value: unknown,
  min: number,
  max: number,
): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.min(max, Math.max(min, Math.round(numeric)));
};

export const sanitizeDataTableFontSize = (value: unknown): number | null => (
  sanitizeOptionalIntegerInRange(value, MIN_DATA_TABLE_FONT_SIZE, MAX_DATA_TABLE_FONT_SIZE)
);

export const sanitizeSidebarTreeFontSize = (value: unknown): number | null => (
  sanitizeOptionalIntegerInRange(value, MIN_SIDEBAR_TREE_FONT_SIZE, MAX_SIDEBAR_TREE_FONT_SIZE)
);

export const getDensityParams = (density: DataTableDensity): DensityParams => {
  return DENSITY_PARAMS[density] || DENSITY_PARAMS.comfortable;
};

export const sanitizeDataGridDisplaySettings = (
  value: Partial<DataGridDisplaySettings> | undefined
): DataGridDisplaySettings => {
  if (!value || typeof value !== 'object') {
    return { ...DEFAULT_DATA_GRID_DISPLAY_SETTINGS };
  }

  const dataTableFontSize = sanitizeDataTableFontSize(value.dataTableFontSize);
  const sidebarTreeFontSize = sanitizeSidebarTreeFontSize(value.sidebarTreeFontSize);

  return {
    showDataTableVerticalBorders: value.showDataTableVerticalBorders === true,
    // 缺省/历史数据：默认显示行号（仅显式 false 才关闭）
    showDataTableRowNumber: value.showDataTableRowNumber !== false,
    dataTableDensity: sanitizeDataTableDensity(value.dataTableDensity),
    dataTableFontSize,
    dataTableFontSizeFollowGlobal: typeof value.dataTableFontSizeFollowGlobal === 'boolean'
      ? value.dataTableFontSizeFollowGlobal
      : dataTableFontSize === null,
    sidebarTreeFontSize,
    sidebarTreeFontSizeFollowGlobal: typeof value.sidebarTreeFontSizeFollowGlobal === 'boolean'
      ? value.sidebarTreeFontSizeFollowGlobal
      : sidebarTreeFontSize === null,
  };
};

export const resolveDataTableDefaultColumnWidth = (
  density: DataTableDensity | null | undefined
): number => {
  return getDensityParams(sanitizeDataTableDensity(density)).defaultColumnWidth;
};

export const resolveDataTableColumnWidth = ({
  manualWidth,
  density,
}: {
  manualWidth: number | null | undefined;
  density: DataTableDensity | null | undefined;
}): number => {
  if (typeof manualWidth === 'number' && Number.isFinite(manualWidth) && manualWidth > 0) {
    return Math.max(MIN_DATA_TABLE_COLUMN_WIDTH, manualWidth);
  }

  return Math.max(MIN_DATA_TABLE_COLUMN_WIDTH, resolveDataTableDefaultColumnWidth(density));
};

export const resolveDataTableVerticalBorderColor = ({
  darkMode,
  visible,
}: {
  darkMode: boolean;
  visible: boolean;
}): string => {
  if (!visible) {
    return 'transparent';
  }

  return darkMode ? 'rgba(255, 255, 255, 0.08)' : 'rgba(15, 23, 42, 0.08)';
};
