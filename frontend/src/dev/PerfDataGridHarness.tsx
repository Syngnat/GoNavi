import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Card, InputNumber, Segmented, Select, Space, Typography } from 'antd';

import DataGrid, { GONAVI_ROW_KEY } from '../components/DataGrid';
import { t } from '../i18n';
import { useStore } from '../store';
import type { SavedConnection } from '../types';
import type { EditRowLocator } from '../utils/rowLocator';
import type { DataTableDensity } from '../utils/dataGridDisplay';

const { Text } = Typography;

type HarnessUiVersion = 'legacy' | 'v2';
type HarnessTheme = 'light' | 'dark';

type HarnessRow = Record<string, any> & {
  [GONAVI_ROW_KEY]: string;
};

type HarnessRuntimeConfig = {
  uiVersion: HarnessUiVersion;
  density: DataTableDensity;
  theme: HarnessTheme;
  uiScale: number;
  fontSize: number;
};

type HarnessRestoreSnapshot = {
  connections: SavedConnection[];
  appearance: ReturnType<typeof useStore.getState>['appearance'];
  theme: ReturnType<typeof useStore.getState>['theme'];
  uiScale: number;
  fontSize: number;
  bodyUiVersion: string | null;
  bodyTheme: string | null;
  bodyFontSize: string;
  rootVars: Record<string, string>;
};

const HARNESS_CONNECTION: SavedConnection = {
  id: 'perf-conn',
  name: 'Perf Data Grid',
  config: {
    id: 'perf-conn',
    type: 'mysql',
    host: '127.0.0.1',
    port: 3306,
    user: 'root',
    database: 'perf_lab',
  },
};

const hasHarnessAppearanceDrift = (
  appearance: ReturnType<typeof useStore.getState>['appearance'],
  uiVersion: HarnessUiVersion,
  density: DataTableDensity,
): boolean => (
  appearance.uiVersion !== uiVersion
  || appearance.dataTableDensity !== density
  || appearance.dataTableFontSize !== null
  || appearance.dataTableFontSizeFollowGlobal !== true
);

const DEFAULT_HARNESS_CONFIG: HarnessRuntimeConfig = {
  uiVersion: 'legacy',
  density: 'comfortable',
  theme: 'light',
  uiScale: 1,
  fontSize: 14,
};

const clampHarnessUiScale = (value: unknown): number => {
  if (value === null || value === undefined || value === '') {
    return DEFAULT_HARNESS_CONFIG.uiScale;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_HARNESS_CONFIG.uiScale;
  return Math.min(1.25, Math.max(0.8, numeric));
};

const clampHarnessFontSize = (value: unknown): number => {
  if (value === null || value === undefined || value === '') {
    return DEFAULT_HARNESS_CONFIG.fontSize;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_HARNESS_CONFIG.fontSize;
  return Math.min(20, Math.max(12, Math.round(numeric)));
};

const readHarnessRowCount = (): number => {
  if (typeof window === 'undefined') return 10000;
  try {
    const rawValue = new URLSearchParams(window.location.search).get('rows');
    if (rawValue === null || rawValue === '') return 10000;
    const numeric = Number(rawValue);
    if (!Number.isFinite(numeric)) return 10000;
    return Math.min(50000, Math.max(0, Math.trunc(numeric)));
  } catch {
    return 10000;
  }
};

const readHarnessRuntimeConfig = (): HarnessRuntimeConfig => {
  if (typeof window === 'undefined') {
    return { ...DEFAULT_HARNESS_CONFIG };
  }
  try {
    const searchParams = new URLSearchParams(window.location.search);
    const uiVersion = searchParams.get('uiVersion') === 'v2' ? 'v2' : DEFAULT_HARNESS_CONFIG.uiVersion;
    const densityRaw = searchParams.get('density');
    const density: DataTableDensity = densityRaw === 'compact' || densityRaw === 'standard'
      ? densityRaw
      : DEFAULT_HARNESS_CONFIG.density;
    const theme = searchParams.get('theme') === 'dark' ? 'dark' : DEFAULT_HARNESS_CONFIG.theme;
    return {
      uiVersion,
      density,
      theme,
      uiScale: clampHarnessUiScale(searchParams.get('uiScale')),
      fontSize: clampHarnessFontSize(searchParams.get('fontSize')),
    };
  } catch {
    return { ...DEFAULT_HARNESS_CONFIG };
  }
};

const DOCUMENT_ROOT_VAR_KEYS = [
  '--gonavi-font-size',
  '--gn-ui-scale',
  '--gn-font-size',
  '--gn-font-size-sm',
  '--gn-font-size-xs',
  '--gn-font-size-mono',
  '--gn-data-table-font-size',
  '--gn-sidebar-tree-font-size',
] as const;

const buildHarnessColumns = (count: number): string[] => {
  const safeCount = Math.max(8, Math.min(64, Math.trunc(count || 0)));
  return Array.from({ length: safeCount }, (_, index) => {
    if (index === 0) return 'id';
    if (index === 1) return 'created_at';
    if (index === 2) return 'updated_at';
    if (index === 3) return 'register_date';
    if (index === 4) return 'status';
    return `col_${String(index + 1).padStart(2, '0')}`;
  });
};

const buildHarnessData = (rowCount: number, columnNames: string[]): HarnessRow[] => {
  const safeRows = Math.max(0, Math.min(50000, Math.trunc(rowCount || 0)));
  return Array.from({ length: safeRows }, (_, rowIndex) => {
    const rowNumber = rowIndex + 1;
    const nextRow: HarnessRow = {
      [GONAVI_ROW_KEY]: `perf-row-${rowNumber}`,
      id: rowNumber,
      created_at: `2026-05-${String((rowNumber % 28) + 1).padStart(2, '0')} 09:${String(rowNumber % 60).padStart(2, '0')}:12`,
      updated_at: `2026-05-${String((rowNumber % 28) + 1).padStart(2, '0')} 18:${String((rowNumber * 3) % 60).padStart(2, '0')}:45`,
      register_date: `2026-05-${String((rowNumber % 28) + 1).padStart(2, '0')} 09:10:11`,
      status: rowNumber % 3 === 0 ? 'active' : (rowNumber % 3 === 1 ? 'pending' : 'archived'),
    };
    columnNames.forEach((columnName, columnIndex) => {
      if (Object.prototype.hasOwnProperty.call(nextRow, columnName)) {
        return;
      }
      if (columnIndex % 9 === 0) {
        nextRow[columnName] = rowNumber * (columnIndex + 1);
        return;
      }
      if (columnIndex % 7 === 0) {
        nextRow[columnName] = JSON.stringify({
          row: rowNumber,
          col: columnName,
          flag: rowIndex % 5 === 0,
        });
        return;
      }
      nextRow[columnName] = `${columnName}-value-${rowNumber}-${(columnIndex % 5) + 1}`;
    });
    return nextRow;
  });
};

const HARNESS_EDIT_LOCATOR: EditRowLocator = {
  strategy: 'primary-key',
  columns: ['id'],
  valueColumns: ['id'],
  readOnly: false,
};

const PerfDataGridHarness: React.FC = () => {
  const initialConfig = useMemo(() => readHarnessRuntimeConfig(), []);
  const setAppearance = useStore((state) => state.setAppearance);
  const setTheme = useStore((state) => state.setTheme);
  const setUiScale = useStore((state) => state.setUiScale);
  const setFontSize = useStore((state) => state.setFontSize);
  const [rowCount, setRowCount] = useState(readHarnessRowCount);
  const [columnCount, setColumnCount] = useState(24);
  const [uiVersion, setUiVersion] = useState<HarnessUiVersion>(initialConfig.uiVersion);
  const [density, setDensity] = useState<DataTableDensity>(initialConfig.density);
  const restoreSnapshotRef = useRef<HarnessRestoreSnapshot | null>(null);

  const columnNames = useMemo(() => buildHarnessColumns(columnCount), [columnCount]);
  const data = useMemo(() => buildHarnessData(rowCount, columnNames), [rowCount, columnNames]);
  const effectiveUiScale = clampHarnessUiScale(initialConfig.uiScale);
  const effectiveFontSize = clampHarnessFontSize(initialConfig.fontSize);
  const effectiveDataTableFontSize = effectiveFontSize;

  useEffect(() => {
    if (restoreSnapshotRef.current) return;
    const currentState = useStore.getState();
    restoreSnapshotRef.current = {
      connections: currentState.connections,
      appearance: { ...currentState.appearance },
      theme: currentState.theme,
      uiScale: currentState.uiScale,
      fontSize: currentState.fontSize,
      bodyUiVersion: document.body.getAttribute('data-ui-version'),
      bodyTheme: document.body.getAttribute('data-theme'),
      bodyFontSize: document.body.style.fontSize,
      rootVars: Object.fromEntries(
        DOCUMENT_ROOT_VAR_KEYS.map((key) => [key, document.documentElement.style.getPropertyValue(key)])
      ),
    };
    currentState.replaceConnections([HARNESS_CONNECTION]);

    return () => {
      const snapshot = restoreSnapshotRef.current;
      if (!snapshot) return;
      useStore.getState().replaceConnections(snapshot.connections);
      useStore.getState().setAppearance(snapshot.appearance);
      useStore.getState().setTheme(snapshot.theme);
      useStore.getState().setUiScale(snapshot.uiScale);
      useStore.getState().setFontSize(snapshot.fontSize);
      if (snapshot.bodyUiVersion) {
        document.body.setAttribute('data-ui-version', snapshot.bodyUiVersion);
      } else {
        document.body.removeAttribute('data-ui-version');
      }
      if (snapshot.bodyTheme) {
        document.body.setAttribute('data-theme', snapshot.bodyTheme);
      } else {
        document.body.removeAttribute('data-theme');
      }
      document.body.style.fontSize = snapshot.bodyFontSize;
      DOCUMENT_ROOT_VAR_KEYS.forEach((key) => {
        const value = snapshot.rootVars[key];
        if (value) {
          document.documentElement.style.setProperty(key, value);
          return;
        }
        document.documentElement.style.removeProperty(key);
      });
      restoreSnapshotRef.current = null;
    };
  }, []);

  useEffect(() => {
    const currentState = useStore.getState();
    if (hasHarnessAppearanceDrift(currentState.appearance, uiVersion, density)) {
      setAppearance({
        uiVersion,
        dataTableDensity: density,
        dataTableFontSize: null,
        dataTableFontSizeFollowGlobal: true,
      });
    }
    if (currentState.theme !== initialConfig.theme) {
      setTheme(initialConfig.theme);
    }
    if (Math.abs(currentState.uiScale - initialConfig.uiScale) > 0.0001) {
      setUiScale(initialConfig.uiScale);
    }
    if (currentState.fontSize !== initialConfig.fontSize) {
      setFontSize(initialConfig.fontSize);
    }
  }, [
    density,
    initialConfig.fontSize,
    initialConfig.theme,
    initialConfig.uiScale,
    setAppearance,
    setFontSize,
    setTheme,
    setUiScale,
    uiVersion,
  ]);

  useEffect(() => {
    document.body.setAttribute('data-theme', initialConfig.theme);
    document.body.setAttribute('data-ui-version', uiVersion);
    document.body.style.fontSize = `${effectiveFontSize}px`;
    document.documentElement.style.setProperty('--gonavi-font-size', `${effectiveFontSize}px`);
    document.documentElement.style.setProperty('--gn-ui-scale', `${effectiveUiScale}`);
    document.documentElement.style.setProperty('--gn-font-size', `${effectiveFontSize}px`);
    document.documentElement.style.setProperty('--gn-font-size-sm', `${Math.max(10, Math.round(effectiveFontSize * 0.86))}px`);
    document.documentElement.style.setProperty('--gn-font-size-xs', `${Math.max(9, Math.round(effectiveFontSize * 0.76))}px`);
    document.documentElement.style.setProperty('--gn-font-size-mono', `${Math.max(10, Math.round(effectiveDataTableFontSize * 0.92))}px`);
    document.documentElement.style.setProperty('--gn-data-table-font-size', `${effectiveDataTableFontSize}px`);
    document.documentElement.style.setProperty('--gn-sidebar-tree-font-size', `${effectiveFontSize}px`);
  }, [effectiveDataTableFontSize, effectiveFontSize, effectiveUiScale, initialConfig.theme, uiVersion]);

  return (
    <div style={{ height: '100vh', overflow: 'hidden', background: '#0b1220', padding: 16, boxSizing: 'border-box' }}>
      <Card
        style={{
          height: '100%',
          borderRadius: 12,
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        }}
        bodyStyle={{
          flex: '1 1 auto',
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          padding: 12,
          gap: 12,
        }}
      >
        <Space wrap align="center" size={12}>
          <Text strong>{t('dev.perf_data_grid.title')}</Text>
          <Segmented
            value={uiVersion}
            onChange={(value) => setUiVersion(value as HarnessUiVersion)}
            options={[
              { label: t('dev.perf_data_grid.ui_version.legacy'), value: 'legacy' },
              { label: t('dev.perf_data_grid.ui_version.v2'), value: 'v2' },
            ]}
          />
          <InputNumber
            min={0}
            max={50000}
            step={500}
            value={rowCount}
            onChange={(value) => setRowCount(value === null ? 0 : Number(value))}
            addonBefore={t('dev.perf_data_grid.rows')}
          />
          <InputNumber
            min={8}
            max={64}
            step={2}
            value={columnCount}
            onChange={(value) => setColumnCount(Number(value) || 24)}
            addonBefore={t('dev.perf_data_grid.columns')}
          />
          <Select
            value={density}
            style={{ width: 140 }}
            onChange={(value) => setDensity(value)}
            options={[
              { value: 'comfortable', label: t('dev.perf_data_grid.density.comfortable') },
              { value: 'standard', label: t('dev.perf_data_grid.density.standard') },
              { value: 'compact', label: t('dev.perf_data_grid.density.compact') },
            ]}
          />
          <Button
            onClick={() => {
              window.dispatchEvent(new Event('resize'));
            }}
          >
            {t('dev.perf_data_grid.trigger_layout')}
          </Button>
        </Space>
        <Alert
          type="info"
          showIcon
          message={t('dev.perf_data_grid.notice.message')}
          description={t('dev.perf_data_grid.notice.description', {
            uiVersion: uiVersion === 'v2'
              ? t('dev.perf_data_grid.ui_version.v2_short')
              : t('dev.perf_data_grid.ui_version.legacy_short'),
            rows: data.length,
            columns: columnNames.length,
          })}
        />
        <div style={{ flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <DataGrid
            data={data}
            columnNames={columnNames}
            loading={false}
            tableName="perf_grid"
            dbName="perf_lab"
            connectionId="perf-conn"
            pkColumns={['id']}
            editLocator={HARNESS_EDIT_LOCATOR}
            pagination={{
              current: 1,
              pageSize: data.length,
              total: data.length,
              totalKnown: true,
            }}
            onPageChange={() => {}}
          />
        </div>
      </Card>
    </div>
  );
};

export default PerfDataGridHarness;
