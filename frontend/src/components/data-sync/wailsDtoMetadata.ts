import type {
  DataSyncSavedConnectionView,
  DataSyncDatabaseMetadata,
  DataSyncObjectMetadata,
  DataSyncFieldMetadata,
} from './model';
import {
  record,
  optionalString,
  DataSyncGatewayProtocolError,
  array,
  isRecord,
  optionalBoolean,
  string,
  optionalMetadataNumber,
} from './wailsDtoPrimitives';
import { getDataSourceSpec } from '../../utils/dataSourceRegistry';

export type WailsQueryResultLike = {
  success?: unknown;
  message?: unknown;
  data?: unknown;
};

export const requireWailsQueryData = (
  result: WailsQueryResultLike,
  operation: string,
): unknown => {
  const response = record(result, operation);
  if (response.success !== true) {
    const message = optionalString(response.message, `${operation}.message`).trim();
    throw new DataSyncGatewayProtocolError(operation, message || 'backend rejected request');
  }
  if (!Object.prototype.hasOwnProperty.call(response, 'data')) {
    throw new DataSyncGatewayProtocolError(operation, 'successful response omitted data');
  }
  return response.data;
};

export const requireWailsCommandSuccess = (
  result: WailsQueryResultLike,
  operation: string,
): void => {
  const response = record(result, operation);
  if (response.success !== true) {
    const message = optionalString(response.message, `${operation}.message`).trim();
    throw new DataSyncGatewayProtocolError(operation, message || 'backend rejected request');
  }
};

export const decodeSavedConnectionViews = (
  value: unknown,
): DataSyncSavedConnectionView[] =>
  array(value, 'GetSavedConnections').map((item, index) => {
    const view = record(item, `GetSavedConnections[${index}]`);
    const config = record(view.config, `GetSavedConnections[${index}].config`);
    const protection = isRecord(config.protection) ? config.protection : {};
    const readOnly = optionalBoolean(
      config.readOnly,
      `GetSavedConnections[${index}].config.readOnly`,
    );
    const restrictWrite =
      optionalBoolean(
        protection.restrictDataEdit,
        `GetSavedConnections[${index}].config.protection.restrictDataEdit`,
      ) ||
      optionalBoolean(
        protection.restrictDataImport,
        `GetSavedConnections[${index}].config.protection.restrictDataImport`,
      );
    const type = string(config.type, `GetSavedConnections[${index}].config.type`, false);
    // 描述表类型按 sync 声明决定能否作为源 / 目标（后端同步内核同样据此放行），未声明的不提供选择。
    const registrySpec = getDataSourceSpec(type);
    return {
      id: string(view.id, `GetSavedConnections[${index}].id`, false),
      name: string(view.name, `GetSavedConnections[${index}].name`, false),
      type,
      readable: !registrySpec || registrySpec.sync?.source === true,
      writable: !readOnly && !restrictWrite && (!registrySpec || registrySpec.sync?.target === true),
    };
  });

export const decodeDatabaseMetadata = (value: unknown): DataSyncDatabaseMetadata[] =>
  array(value, 'DataSyncDatabaseList.data').map((item, index) => {
    const row = record(item, `DataSyncDatabaseList.data[${index}]`);
    const name = row.Database ?? row.database;
    return {
      name: string(name, `DataSyncDatabaseList.data[${index}].Database`, false),
    };
  });

export const decodeObjectMetadata = (
  value: unknown,
  connectionType: string,
): DataSyncObjectMetadata[] =>
  array(value, 'DataSyncObjectList.data').map((item, index) => {
    const row = record(item, `DataSyncObjectList.data[${index}]`);
    const name = row.Table ?? row.table ?? row.name;
    const rawKind = optionalString(row.type, `DataSyncObjectList.data[${index}].type`)
      .trim()
      .toLowerCase();
    const inferredKind = connectionType.toLowerCase().includes('mongo')
      ? 'collection'
      : 'table';
    const kind = rawKind === 'view' || rawKind === 'collection' ? rawKind : inferredKind;
    const rowCount = optionalMetadataNumber(
      row.Rows,
      `DataSyncObjectList.data[${index}].Rows`,
    );
    const dataBytes = optionalMetadataNumber(
      row.Data_length,
      `DataSyncObjectList.data[${index}].Data_length`,
    );
    const indexBytes = optionalMetadataNumber(
      row.Index_length,
      `DataSyncObjectList.data[${index}].Index_length`,
    );
    return {
      name: string(name, `DataSyncObjectList.data[${index}].Table`, false),
      kind,
      ...(rowCount === undefined ? {} : { rowCount }),
      ...(dataBytes === undefined ? {} : { dataBytes }),
      ...(indexBytes === undefined ? {} : { indexBytes }),
    };
  });

export const decodeFieldMetadata = (value: unknown): DataSyncFieldMetadata[] =>
  array(value, 'DataSyncFieldList.data').map((item, index) => {
    const field = record(item, `DataSyncFieldList.data[${index}]`);
    const nullable = string(
      field.nullable,
      `DataSyncFieldList.data[${index}].nullable`,
    ).toLowerCase();
    const key = optionalString(field.key, `DataSyncFieldList.data[${index}].key`)
      .trim()
      .toUpperCase();
    return {
      name: string(field.name, `DataSyncFieldList.data[${index}].name`, false),
      type: string(field.type, `DataSyncFieldList.data[${index}].type`, false),
      nullable: nullable === 'yes' || nullable === 'true',
      ordinal: index + 1,
      key: key === 'PRI' || key === 'UNI' || key === 'PRIMARY' || key === 'UNIQUE',
    };
  });
