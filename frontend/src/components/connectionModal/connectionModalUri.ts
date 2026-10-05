export {
  getPulsarDefaultPort,
  getPulsarPortAfterSSLChange,
  normalizeClickHouseProtocolValue,
  normalizeOceanBaseProtocolValue,
  parseHostPort,
  toAddress,
  normalizeAddressList,
  normalizeMongoSrvHostList,
  normalizeConnectionParamsText,
} from "./connectionModalUriHosts";
export type { ClickHouseProtocolChoice, OceanBaseProtocolChoice } from "./connectionModalUriHosts";
export {
  resolveOracleConnectionTarget,
  extractOracleSIDParam,
  withOracleSIDParam,
  withoutOracleSIDParam,
  withoutOracleSIDFromURI,
  normalizeOceanBaseConnectionParamsText,
  normalizeFileDbPath,
} from "./connectionModalUriParams";
export { parseClickHouseHTTPUriToValues, parseTrinoUriToValues } from "./connectionModalUriSchemes";
export { parseUriToValues } from "./connectionModalUriParse";
export { buildUriFromValues } from "./connectionModalUriBuild";

export { getUriPlaceholder, getConnectionParamsPlaceholder } from './connectionModalPlaceholders';
