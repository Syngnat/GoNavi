import { gzipSync, strToU8 } from 'fflate';
import { t } from '../i18n';
import { ExportDataWithOptions } from '../../wailsjs/go/app/App';

const COMPRESSED_EXPORT_THRESHOLD_BYTES = 16 * 1024 * 1024;
const MAX_ENCODED_EXPORT_BYTES = 60 * 1024 * 1024;

export type ExportDataRowsInvoker = (
  rows: Array<Record<string, any>>,
  columns: string[],
  defaultName: string,
  options: Record<string, any>,
) => Promise<any>;

export type CompressedExportPayload = {
  encoded: string;
  rawBytes: number;
  compressedBytes: number;
};

export type ExportDataRowsLimits = {
  compressThresholdBytes?: number;
  maxEncodedBytes?: number;
};

export const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  const chunkSize = 0x4000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
};

export const buildCompressedExportPayload = (
  rows: Array<Record<string, any>>,
  thresholdBytes = COMPRESSED_EXPORT_THRESHOLD_BYTES,
): CompressedExportPayload | null => {
  const json = JSON.stringify(rows);
  const rawBytes = strToU8(json);
  if (rawBytes.byteLength < thresholdBytes) {
    return null;
  }
  const compressed = gzipSync(rawBytes, { level: 1 });
  return {
    encoded: bytesToBase64(compressed),
    rawBytes: rawBytes.byteLength,
    compressedBytes: compressed.byteLength,
  };
};

/**
 * Wails v3 rejects a single runtime request above 64 MiB. Query-result exports
 * can otherwise send hundreds of thousands of rows as one IPC argument, so
 * larger materialized row sets are compressed before crossing the bridge and
 * streamed back out in Go. Small exports keep the direct path.
 */
export const exportDataRowsWithOptions = async (
  rows: Array<Record<string, any>>,
  columns: string[],
  defaultName: string,
  options: Record<string, any>,
  invoke: ExportDataRowsInvoker = (nextRows, nextColumns, nextDefaultName, nextOptions) =>
    ExportDataWithOptions(nextRows, nextColumns, nextDefaultName, nextOptions as any),
  limits: ExportDataRowsLimits = {},
): Promise<any> => {
  const payload = buildCompressedExportPayload(rows, limits.compressThresholdBytes);
  if (!payload) {
    return invoke(rows, columns, defaultName, options);
  }
  if (payload.encoded.length > (limits.maxEncodedBytes ?? MAX_ENCODED_EXPORT_BYTES)) {
    throw new Error(t('data_export.message.request_too_large'));
  }
  return invoke([], columns, defaultName, {
    ...options,
    dataGzipBase64: payload.encoded,
  });
};
