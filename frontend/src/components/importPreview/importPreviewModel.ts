import * as AppBindings from '../../../wailsjs/go/app/App';
import {
  type DataImportPreferences,
  DEFAULT_DATA_IMPORT_PREFERENCES,
} from '../dataImportPreferences';

export interface PreviewData {
  columns: string[];
  totalRows: number;
  totalRowsKnown: boolean;
  fileSize: number;
  sourceIdentityToken: string;
  previewRows: any[];
}

type ImportParserOptions = Omit<DataImportPreferences, "nullToken" | "sheetName"> & {
  nullToken?: string;
  sheetName?: string;
};

export const previewImportFileWithOptions = (
  AppBindings as unknown as {
    PreviewImportFileWithOptions?: (filePath: string, options: ImportParserOptions) => Promise<any>;
  }
).PreviewImportFileWithOptions;

export const cancelImportJob = (
  AppBindings as unknown as {
    CancelImportJob?: (jobId: string) => Promise<any>;
  }
).CancelImportJob;

export const buildImportParserOptions = (
  importOptions: DataImportPreferences | undefined,
  continueOnError: boolean,
): ImportParserOptions => {
  const normalized = {
    ...DEFAULT_DATA_IMPORT_PREFERENCES,
    ...importOptions,
    continueOnError,
  };
  return {
    continueOnError: normalized.continueOnError,
    conflictPolicy: normalized.conflictPolicy,
    conflictKeyColumns: Array.from(new Set(
      normalized.conflictKeyColumns.map((column) => column.trim()).filter(Boolean),
    )),
    encoding: normalized.encoding,
    delimiter: normalized.delimiter,
    headerRow: normalized.headerRow,
    emptyStringAsNull: normalized.emptyStringAsNull,
    ...(normalized.nullToken !== "" ? { nullToken: normalized.nullToken } : {}),
    ...(normalized.sheetName !== "" ? { sheetName: normalized.sheetName } : {}),
  };
};

export interface ImportProgress {
  jobId?: string;
  current: number;
  total: number;
  success: number;
  errors: number;
  skipped?: number;
  totalRowsKnown?: boolean;
  bytesRead?: number;
  totalBytes?: number;
  bytesPerSecond?: number;
  etaSeconds?: number;
  stage?: string;
}

export const createImportJobId = (): string => {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return `import-${globalThis.crypto.randomUUID()}`;
  }
  return `import-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
};
