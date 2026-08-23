import { t } from "../../i18n";
import {
  getConnectionTypeDefaultPort as getDefaultPortByType,
} from "../../utils/connectionTypeCatalog";
import {
  isFileDatabaseType,
  isMySQLCompatibleType,
  isPostgresCompatibleSSLType,
  singleHostUriSchemesByType,
  supportsConnectionParamsForType,
  supportsSSLCAPathForType,
  supportsSSLClientCertificateForType,
  supportsSSLForType,
} from "../../utils/connectionTypeCapabilities";
import {
  describeUnsupportedOceanBaseProtocol,
  normalizeOceanBaseProtocol,
  OCEANBASE_PROTOCOL_PARAM_KEYS,
  resolveOceanBaseProtocolFromQueryText as resolveOceanBaseProtocolQueryText,
  type OceanBaseProtocol,
} from "../../utils/oceanBaseProtocol";
import {
  buildRedisUriFromValues,
  parseRedisUriToFormValues,
} from "../../utils/redisConnectionUri";
import {
  extractNacosConnectionScope,
} from "../../utils/nacosConnectionScope";

export type ClickHouseProtocolChoice = "auto" | "http" | "native";
export type OceanBaseProtocolChoice = OceanBaseProtocol;

const MAX_URI_LENGTH = 4096;
const MAX_CONNECTION_PARAMS_LENGTH = 4096;
const MAX_URI_HOSTS = 32;
const MAX_TIMEOUT_SECONDS = 3600;

export const normalizeClickHouseProtocolValue = (
  value: unknown,
): ClickHouseProtocolChoice => {
  const text = String(value || "")
    .trim()
    .toLowerCase();
  if (text === "http" || text === "https") return "http";
  if (text === "native" || text === "tcp") return "native";
  return "auto";
};
export const normalizeOceanBaseProtocolValue = (
  value: unknown,
): OceanBaseProtocolChoice => {
  return normalizeOceanBaseProtocol(value) || "mysql";
};

export const parseHostPort = (
  raw: string,
  defaultPort: number,
): { host: string; port: number } | null => {
  let text = String(raw || "").trim();
  if (!text) {
    return null;
  }

  const schemeMatch = text.match(/^(?:mqtt|tcp):\/\//i);
  if (schemeMatch) {
    text = text.slice(schemeMatch[0].length);
    const authorityEnd = text.search(/[/?#]/);
    if (authorityEnd >= 0) {
      text = text.slice(0, authorityEnd);
    }
    const userInfoEnd = text.lastIndexOf("@");
    if (userInfoEnd >= 0) {
      text = text.slice(userInfoEnd + 1);
    }
    text = text.trim();
  }
  if (!text) {
    return null;
  }

  if (text.startsWith("[")) {
    const closingBracket = text.indexOf("]");
    if (closingBracket > 0) {
      const host = text.slice(1, closingBracket).trim();
      const portText = text
        .slice(closingBracket + 1)
        .trim()
        .replace(/^:/, "");
      const parsedPort = Number(portText);
      return {
        host: host || "localhost",
        port:
          Number.isFinite(parsedPort) && parsedPort > 0 && parsedPort <= 65535
            ? parsedPort
            : defaultPort,
      };
    }
  }

  const colonCount = (text.match(/:/g) || []).length;
  const colonParts = text.split(":");
  const isIPv6Address =
    text.includes("::") ||
    (colonParts.length === 8 &&
      colonParts.every((part) => /^[0-9a-f]{1,4}$/i.test(part)));
  if (colonCount > 1 && !isIPv6Address) {
    const parts = colonParts;
    let suffixStart = parts.length;
    while (
      suffixStart > 1 &&
      /^\d+$/.test(String(parts[suffixStart - 1] || "").trim())
    ) {
      suffixStart -= 1;
    }
    const host = parts.slice(0, suffixStart).join(":").trim();
    if (suffixStart < parts.length && host && !host.includes(":")) {
      const parsedPort = Number(String(parts[suffixStart] || "").trim());
      return {
        host,
        port:
          Number.isFinite(parsedPort) && parsedPort > 0 && parsedPort <= 65535
            ? parsedPort
            : defaultPort,
      };
    }
  }
  if (colonCount === 1) {
    const splitIndex = text.lastIndexOf(":");
    const host = text.slice(0, splitIndex).trim();
    const portText = text.slice(splitIndex + 1).trim();
    const parsedPort = Number(portText);
    return {
      host: host || "localhost",
      port:
        Number.isFinite(parsedPort) && parsedPort > 0 && parsedPort <= 65535
          ? parsedPort
          : defaultPort,
    };
  }

  return { host: text, port: defaultPort };
};

export const toAddress = (host: string, port: number, defaultPort: number) => {
  const safeHost = String(host || "").trim() || "localhost";
  const safePort =
    Number.isFinite(Number(port)) && Number(port) > 0
      ? Number(port)
      : defaultPort;
  const parsed = parseHostPort(safeHost, safePort);
  const normalizedHost = parsed?.host || "localhost";
  const normalizedPort = parsed?.port || safePort;
  const formattedHost =
    normalizedHost.includes(":") && !normalizedHost.startsWith("[")
      ? `[${normalizedHost}]`
      : normalizedHost;
  return `${formattedHost}:${normalizedPort}`;
};

export const normalizeAddressList = (
  rawList: unknown,
  defaultPort: number,
): string[] => {
  const list = Array.isArray(rawList) ? rawList : [];
  const seen = new Set<string>();
  const result: string[] = [];
  list.forEach((entry) => {
    const parsed = parseHostPort(String(entry || ""), defaultPort);
    if (!parsed) {
      return;
    }
    const normalized = toAddress(parsed.host, parsed.port, defaultPort);
    if (seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    result.push(normalized);
  });
  return result;
};

const isValidUriHostEntry = (entry: string): boolean => {
  const text = String(entry || "").trim();
  if (!text) return false;
  if (text.length > 255) return false;
  // 拒绝明显的 DSN 片段或路径/空白，避免把非 URI 主机段误判为合法地址。
  if (/[()\\/\s]/.test(text)) return false;
  return true;
};

export const normalizeMongoSrvHostList = (
  rawList: unknown,
  defaultPort: number,
): string[] => {
  const list = Array.isArray(rawList) ? rawList : [];
  const seen = new Set<string>();
  const result: string[] = [];
  list.forEach((entry) => {
    const parsed = parseHostPort(String(entry || ""), defaultPort);
    if (!parsed?.host) {
      return;
    }
    const host = String(parsed.host).trim();
    if (!host || seen.has(host)) {
      return;
    }
    seen.add(host);
    result.push(host);
  });
  return result;
};

const safeDecode = (text: string) => {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
};

const normalizeUriBool = (raw: unknown) => {
  const text = String(raw ?? "")
    .trim()
    .toLowerCase();
  return text === "1" || text === "true" || text === "yes" || text === "on";
};

export const normalizeConnectionParamsText = (raw: unknown) => {
  let text = String(raw || "").trim();
  if (!text) return "";
  const queryIndex = text.indexOf("?");
  if (queryIndex >= 0) {
    text = text.slice(queryIndex + 1);
  }
  const hashIndex = text.indexOf("#");
  if (hashIndex >= 0) {
    text = text.slice(0, hashIndex);
  }
  return text.replace(/^[?&]+/, "").trim().slice(0, MAX_CONNECTION_PARAMS_LENGTH);
};

const serializeConnectionParams = (params: URLSearchParams) => {
  const cloned = new URLSearchParams();
  params.forEach((value, key) => {
    if (String(key || "").trim()) {
      cloned.append(key, value);
    }
  });
  return cloned.toString().slice(0, MAX_CONNECTION_PARAMS_LENGTH);
};

// Oracle 连接定位模式：SID 查询参数。后端白名单与 go-ora 驱动均对参数名做
// 大小写归一化（oracleConnectionParamNames / ParseConfig 中 strings.ToUpper），
// 因此这里按大小写不敏感方式读写，避免表单与历史数据大小写不一致导致重复参数。

type OracleConnectionMode = "service" | "sid";

type OracleSIDParamState = {
  present: boolean;
  value: string;
};

const isOracleSIDKey = (key: unknown): boolean =>
  String(key || "").trim().toUpperCase() === "SID";

const readOracleSIDParam = (rawParams: unknown): OracleSIDParamState => {
  const text = normalizeConnectionParamsText(rawParams);
  const params = new URLSearchParams(text);
  const state: OracleSIDParamState = { present: false, value: "" };
  params.forEach((value, key) => {
    if (isOracleSIDKey(key)) {
      state.present = true;
      state.value = String(value || "").trim();
    }
  });
  return state;
};

export const resolveOracleConnectionTarget = (
  uriParams: unknown,
  connectionParams?: unknown,
): { mode: OracleConnectionMode; sid: string } => {
  const uriSID = readOracleSIDParam(uriParams);
  const connectionSID = readOracleSIDParam(connectionParams);
  // 与后端 mergeConnectionParamsFromConfigWithAllowlist 保持一致：
  // URI 参数先加载，ConnectionParams 中显式存在的 SID（包括空值）后覆盖。
  const resolvedSID = connectionSID.present ? connectionSID : uriSID;
  return {
    mode: resolvedSID.value ? "sid" : "service",
    sid: resolvedSID.value,
  };
};

export const extractOracleSIDParam = (rawParams: unknown): string => {
  return readOracleSIDParam(rawParams).value;
};

export const withOracleSIDParam = (
  rawParams: unknown,
  sidValue: string,
): string => {
  const text = normalizeConnectionParamsText(rawParams);
  const params = new URLSearchParams(text);
  const sid = String(sidValue || "").trim();
  const hasExistingSID = readOracleSIDParam(text).present;
  if (!hasExistingSID && !sid) return text;
  const rebuilt = new URLSearchParams();
  let sidWritten = false;
  params.forEach((value, key) => {
    if (isOracleSIDKey(key)) {
      if (sid && !sidWritten) {
        rebuilt.append("SID", sid);
        sidWritten = true;
      }
    } else {
      rebuilt.append(key, value);
    }
  });
  if (!sidWritten && sid) rebuilt.append("SID", sid);
  return serializeConnectionParams(rebuilt);
};

export const withoutOracleSIDParam = (rawParams: unknown): string => {
  const text = normalizeConnectionParamsText(rawParams);
  if (!text) return "";
  const params = new URLSearchParams(text);
  const rebuilt = new URLSearchParams();
  params.forEach((value, key) => {
    if (!isOracleSIDKey(key)) {
      rebuilt.append(key, value);
    }
  });
  return serializeConnectionParams(rebuilt);
};

// 服务名模式下从连接 URI 中剥离 SID 查询参数（大小写不敏感）。
// 直接基于 query 分段处理而不是重建 URL 对象，避免对用户粘贴的 URI
// 引入协议规范化/重新编码等意外差异。
export const withoutOracleSIDFromURI = (uriText: unknown): string => {
  const text = String(uriText || "").trim();
  if (!text) return text;
  const hashIndex = text.indexOf("#");
  const beforeHash = hashIndex >= 0 ? text.slice(0, hashIndex) : text;
  const hash = hashIndex >= 0 ? text.slice(hashIndex) : "";
  const queryIndex = beforeHash.indexOf("?");
  if (queryIndex < 0) return text;
  const base = beforeHash.slice(0, queryIndex);
  const query = beforeHash.slice(queryIndex + 1);
  const kept = query.split("&").filter((pair) => {
    const eq = pair.indexOf("=");
    const rawKey = (eq >= 0 ? pair.slice(0, eq) : pair).trim();
    let decodedKey = rawKey;
    try {
      decodedKey = decodeURIComponent(rawKey.replace(/\+/g, " "));
    } catch {
      // 保留格式异常的原始参数；后端同样不会把无法解析的 query 识别为 SID。
    }
    return !isOracleSIDKey(decodedKey);
  });
  const rebuilt = kept.length > 0 ? `${base}?${kept.join("&")}` : base;
  return rebuilt + hash;
};

export const normalizeOceanBaseConnectionParamsText = (
  rawParams: unknown,
  selectedProtocol: OceanBaseProtocolChoice,
) => {
  const normalizedParamsText = normalizeConnectionParamsText(rawParams);
  const protocolFromParams = resolveOceanBaseProtocolQueryText(normalizedParamsText);
  if (protocolFromParams.unsupportedValue) {
    throw new Error(describeUnsupportedOceanBaseProtocol(protocolFromParams.unsupportedValue));
  }
  const params = new URLSearchParams(normalizedParamsText);
  for (const key of OCEANBASE_PROTOCOL_PARAM_KEYS) {
    params.delete(key);
  }
  params.set("protocol", selectedProtocol);
  return params.toString().slice(0, MAX_CONNECTION_PARAMS_LENGTH);
};

const mergeConnectionParams = (
  params: URLSearchParams,
  rawParams: unknown,
) => {
  const text = normalizeConnectionParamsText(rawParams);
  if (!text) return;
  const extra = new URLSearchParams(text);
  extra.forEach((value, key) => {
    if (String(key || "").trim()) {
      params.set(key, value);
    }
  });
};

export const normalizeFileDbPath = (rawPath: string): string => {
  let pathText = String(rawPath || "").trim();
  if (!pathText) {
    return "";
  }
  // 兼容 sqlite:///C:/... 或 sqlite:///C:\... 解析后多出的前导斜杠。
  if (/^\/[a-zA-Z]:[\\/]/.test(pathText)) {
    pathText = pathText.slice(1);
  }
  // 兼容历史版本把 Windows 文件路径误拼成 :3306:3306。
  const legacyMatch = pathText.match(/^([a-zA-Z]:[\\/].*?)(?::\d+)+$/);
  if (legacyMatch?.[1]) {
    return legacyMatch[1];
  }
  return pathText;
};

const parseMultiHostUri = (uriText: string, expectedScheme: string) => {
  const prefix = `${expectedScheme}://`;
  if (!uriText.toLowerCase().startsWith(prefix)) {
    return null;
  }
  let rest = uriText.slice(prefix.length);
  const hashIndex = rest.indexOf("#");
  if (hashIndex >= 0) {
    rest = rest.slice(0, hashIndex);
  }
  let queryText = "";
  const queryIndex = rest.indexOf("?");
  if (queryIndex >= 0) {
    queryText = rest.slice(queryIndex + 1);
    rest = rest.slice(0, queryIndex);
  }

  let pathText = "";
  const slashIndex = rest.indexOf("/");
  const hasExplicitPath = slashIndex >= 0;
  if (slashIndex >= 0) {
    pathText = rest.slice(slashIndex + 1);
    rest = rest.slice(0, slashIndex);
  }

  let hostText = rest;
  let username = "";
  let password = "";
  const atIndex = rest.lastIndexOf("@");
  if (atIndex >= 0) {
    const userInfo = rest.slice(0, atIndex);
    hostText = rest.slice(atIndex + 1);
    const colonIndex = userInfo.indexOf(":");
    if (colonIndex >= 0) {
      username = safeDecode(userInfo.slice(0, colonIndex));
      password = safeDecode(userInfo.slice(colonIndex + 1));
    } else {
      username = safeDecode(userInfo);
    }
  }

  const hosts = hostText
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  return {
    username,
    password,
    hosts,
    database: safeDecode(pathText),
    hasExplicitPath,
    params: new URLSearchParams(queryText),
  };
};

const parseSingleHostUri = (
  uriText: string,
  expectedSchemes: string[],
  defaultPort: number,
): {
  host: string;
  port: number;
  username: string;
  password: string;
  database: string;
  hasExplicitPath: boolean;
  params: URLSearchParams;
} | null => {
  let parsed: ReturnType<typeof parseMultiHostUri> | null = null;
  for (const scheme of expectedSchemes) {
    parsed = parseMultiHostUri(uriText, scheme);
    if (parsed) {
      break;
    }
  }
  if (!parsed) {
    return null;
  }
  if (!parsed.hosts.length || parsed.hosts.length > MAX_URI_HOSTS) {
    return null;
  }
  if (parsed.hosts.some((entry) => !isValidUriHostEntry(entry))) {
    return null;
  }
  const hostList = normalizeAddressList(parsed.hosts, defaultPort);
  if (!hostList.length) {
    return null;
  }
  const primary = parseHostPort(
    hostList[0] || `localhost:${defaultPort}`,
    defaultPort,
  );
  return {
    host: primary?.host || "localhost",
    port: primary?.port || defaultPort,
    username: parsed.username,
    password: parsed.password,
    database: parsed.database || "",
    hasExplicitPath: parsed.hasExplicitPath,
    params: parsed.params,
  };
};

export const parseClickHouseHTTPUriToValues = (
  uriText: string,
  fallbackPort?: number,
): Record<string, any> | null => {
  const trimmed = String(uriText || "").trim();
  const lower = trimmed.toLowerCase();
  const isHttps = lower.startsWith("https://");
  const isHttp = lower.startsWith("http://");
  if (!isHttp && !isHttps) {
    return null;
  }
  const defaultPort =
    Number.isFinite(Number(fallbackPort)) && Number(fallbackPort) > 0
      ? Number(fallbackPort)
      : isHttps
        ? 8443
        : 8123;
  const parsed = parseSingleHostUri(
    trimmed,
    [isHttps ? "https" : "http"],
    defaultPort,
  );
  if (!parsed) {
    return null;
  }
  const skipVerify = normalizeUriBool(parsed.params.get("skip_verify"));
  return {
    host: parsed.host,
    port: parsed.port,
    user: parsed.username,
    password: parsed.password,
    database: parsed.database || "",
    clickHouseProtocol: "http",
    useSSL: isHttps,
    sslMode: isHttps ? (skipVerify ? "skip-verify" : "required") : "disable",
    ...extractSSLPathValuesFromParams(parsed.params, "clickhouse"),
    connectionParams: serializeConnectionParams(parsed.params),
  };
};

const normalizeNacosContextPath = (raw: unknown): string => {
  const text = String(raw ?? "").trim();
  if (!text || text === "/") {
    return text === "/" ? "/" : "/nacos";
  }
  return `/${text.replace(/^\/+|\/+$/g, "")}`;
};

const encodeNacosContextPath = (raw: unknown): string => {
  const normalized = normalizeNacosContextPath(raw);
  if (normalized === "/") {
    return "/";
  }
  return normalized
    .split("/")
    .map((segment, index) => (index === 0 ? "" : encodeURIComponent(segment)))
    .join("/");
};

const splitTrinoNamespace = (
  raw: unknown,
): { catalog: string; schema: string } => {
  const text = String(raw || "").trim();
  if (!text) {
    return { catalog: "", schema: "" };
  }
  const [catalog, schema = ""] = text.split(".", 2);
  return {
    catalog: String(catalog || "").trim(),
    schema: String(schema || "").trim(),
  };
};

const joinTrinoNamespace = (catalog: string, schema: string) => {
  const safeCatalog = String(catalog || "").trim();
  const safeSchema = String(schema || "").trim();
  if (!safeCatalog) return safeSchema;
  if (!safeSchema) return safeCatalog;
  return `${safeCatalog}.${safeSchema}`;
};

export const parseTrinoUriToValues = (
  uriText: string,
): Record<string, any> | null => {
  const trimmed = String(uriText || "").trim();
  const parsed = parseSingleHostUri(
    trimmed,
    ["trino", "http", "https"],
    getDefaultPortByType("trino"),
  );
  if (!parsed) {
    return null;
  }
  const params = new URLSearchParams(parsed.params);
  const catalog = String(params.get("catalog") || "").trim();
  const schema = String(params.get("schema") || "").trim();
  params.delete("catalog");
  params.delete("schema");

  const skipVerify = normalizeUriBool(
    params.get("skip_verify") || params.get("skipVerify"),
  );
  params.delete("skip_verify");
  params.delete("skipVerify");

  const namespace =
    joinTrinoNamespace(catalog, schema) || String(parsed.database || "").trim();
  return {
    host: parsed.host,
    port: parsed.port,
    user: parsed.username,
    password: parsed.password,
    database: namespace,
    useSSL: trimmed.toLowerCase().startsWith("https://"),
    sslMode: trimmed.toLowerCase().startsWith("https://")
      ? (skipVerify ? "skip-verify" : "required")
      : "disable",
    ...extractSSLPathValuesFromParams(params, "trino"),
    connectionParams: serializeConnectionParams(params),
  };
};

const firstConnectionParamValue = (
  params: URLSearchParams,
  names: string[],
): string => {
  for (const name of names) {
    const value = String(params.get(name) || "").trim();
    if (value) return value;
  }
  return "";
};

const extractSSLPathValuesFromParams = (
  params: URLSearchParams,
  type: string,
): Record<string, string> => {
  const caPath = firstConnectionParamValue(params, [
    "sslCAPath",
    "ssl_ca_path",
    "sslrootcert",
    "sslRootCert",
    "tlsCAFile",
    "caFile",
    "certificate",
    "servercertificate",
    "serverCertificate",
  ]);
  const certPath = firstConnectionParamValue(params, [
    "sslCertPath",
    "ssl_cert_path",
    "SSL_CERT_PATH",
    "sslcert",
    "sslCert",
    "tlsCertificateFile",
  ]);
  const keyPath = firstConnectionParamValue(params, [
    "sslKeyPath",
    "ssl_key_path",
    "SSL_KEY_PATH",
    "sslkey",
    "sslKey",
    "tlsKeyFile",
  ]);
  return {
    ...(supportsSSLCAPathForType(type) && caPath ? { sslCAPath: caPath } : {}),
    ...(supportsSSLClientCertificateForType(type) && certPath ? { sslCertPath: certPath } : {}),
    ...(supportsSSLClientCertificateForType(type) && keyPath ? { sslKeyPath: keyPath } : {}),
  };
};

const appendSSLPathParamsForUri = (
  params: URLSearchParams,
  type: string,
  values: Record<string, any>,
) => {
  const caPath = String(values.sslCAPath || "").trim();
  const certPath = String(values.sslCertPath || "").trim();
  const keyPath = String(values.sslKeyPath || "").trim();
  const mode = String(values.sslMode || "preferred")
    .trim()
    .toLowerCase();
  if (supportsSSLCAPathForType(type) && caPath) {
    if (isPostgresCompatibleSSLType(type)) {
      if (mode !== "skip-verify" && mode !== "disable") {
        params.set("sslrootcert", caPath);
      }
    } else if (type === "sqlserver") {
      params.set("certificate", caPath);
    } else {
      params.set("sslCAPath", caPath);
    }
  }
  if (supportsSSLClientCertificateForType(type) && certPath) {
    if (type === "dameng") {
      params.set("SSL_CERT_PATH", certPath);
    } else if (isPostgresCompatibleSSLType(type)) {
      params.set("sslcert", certPath);
    } else {
      params.set("sslCertPath", certPath);
    }
  }
  if (supportsSSLClientCertificateForType(type) && keyPath) {
    if (type === "dameng") {
      params.set("SSL_KEY_PATH", keyPath);
    } else if (isPostgresCompatibleSSLType(type)) {
      params.set("sslkey", keyPath);
    } else {
      params.set("sslKeyPath", keyPath);
    }
  }
};

export const parseUriToValues = (
  uriText: string,
  type: string,
): Record<string, any> | null => {
  const trimmedUri = String(uriText || "").trim();
  if (!trimmedUri) {
    return null;
  }
  if (trimmedUri.length > MAX_URI_LENGTH) {
    return null;
  }

  if (isMySQLCompatibleType(type)) {
    const mysqlDefaultPort = getDefaultPortByType(type);
    const parsed =
      parseMultiHostUri(trimmedUri, "mysql") ||
      parseMultiHostUri(trimmedUri, "goldendb") ||
      parseMultiHostUri(trimmedUri, "greatdb") ||
      parseMultiHostUri(trimmedUri, "gdb") ||
      parseMultiHostUri(trimmedUri, "jdbc:mysql") ||
      parseMultiHostUri(trimmedUri, "oceanbase") ||
      parseMultiHostUri(trimmedUri, "jdbc:oceanbase") ||
      parseMultiHostUri(trimmedUri, "starrocks") ||
      parseMultiHostUri(trimmedUri, "jdbc:starrocks") ||
      parseMultiHostUri(trimmedUri, "diros") ||
      parseMultiHostUri(trimmedUri, "doris");
    if (!parsed) {
      return null;
    }
    if (!parsed.hosts.length || parsed.hosts.length > MAX_URI_HOSTS) {
      return null;
    }
    if (parsed.hosts.some((entry) => !isValidUriHostEntry(entry))) {
      return null;
    }
    const hostList = normalizeAddressList(parsed.hosts, mysqlDefaultPort);
    if (!hostList.length) {
      return null;
    }
    const primary = parseHostPort(
      hostList[0] || `localhost:${mysqlDefaultPort}`,
      mysqlDefaultPort,
    );
    const timeoutValue = Number(parsed.params.get("timeout"));
    const topology = String(
      parsed.params.get("topology") || "",
    ).toLowerCase();
    const tlsValue = String(
      parsed.params.get("tls") || parsed.params.get("useSSL") || "",
    )
      .trim()
      .toLowerCase();
    const parsedOceanBaseProtocol =
      type === "oceanbase"
        ? normalizeOceanBaseProtocolValue(
            parsed.params.get("protocol") ||
              parsed.params.get("oceanBaseProtocol") ||
              parsed.params.get("oceanbaseProtocol") ||
              parsed.params.get("tenantMode") ||
              parsed.params.get("compatMode") ||
              parsed.params.get("mode"),
          )
        : undefined;
    const sslMode =
      tlsValue === "true"
        ? "required"
        : tlsValue === "skip-verify"
          ? "skip-verify"
          : tlsValue === "preferred"
            ? "preferred"
            : "disable";
    return {
      host: primary?.host || "localhost",
      port: primary?.port || mysqlDefaultPort,
      user: parsed.username,
      password: parsed.password,
      database: parsed.database || "",
      useSSL: sslMode !== "disable",
      sslMode,
      ...extractSSLPathValuesFromParams(parsed.params, type),
      oceanBaseProtocol: parsedOceanBaseProtocol,
      mysqlTopology:
        parsedOceanBaseProtocol === "oracle"
          ? "single"
          : hostList.length > 1 || topology === "replica"
            ? "replica"
            : "single",
      mysqlReplicaHosts: hostList.slice(1),
      connectionParams: serializeConnectionParams(parsed.params),
      timeout:
        Number.isFinite(timeoutValue) && timeoutValue > 0
          ? Math.min(3600, Math.trunc(timeoutValue))
          : undefined,
    };
  }

  if (isFileDatabaseType(type)) {
    const rawPath = trimmedUri
      .replace(/^sqlite:\/\//i, "")
      .replace(/^duckdb:\/\//i, "")
      .trim();
    if (!rawPath) {
      return null;
    }
    return { host: normalizeFileDbPath(safeDecode(rawPath)) };
  }

  if (type === "redis") {
    return parseRedisUriToFormValues(trimmedUri);
  }

  if (type === "mongodb") {
    const parsed =
      parseMultiHostUri(trimmedUri, "mongodb") ||
      parseMultiHostUri(trimmedUri, "mongodb+srv");
    if (!parsed) {
      return null;
    }
    if (!parsed.hosts.length || parsed.hosts.length > MAX_URI_HOSTS) {
      return null;
    }
    if (parsed.hosts.some((entry) => !isValidUriHostEntry(entry))) {
      return null;
    }
    const isSrv = trimmedUri.toLowerCase().startsWith("mongodb+srv://");
    const hostList = isSrv
      ? normalizeMongoSrvHostList(parsed.hosts, 27017)
      : normalizeAddressList(parsed.hosts, 27017);
    if (!hostList.length) {
      return null;
    }
    const primary = isSrv
      ? { host: hostList[0] || "localhost", port: 27017 }
      : parseHostPort(hostList[0] || "localhost:27017", 27017);
    const timeoutMs = Number(
      parsed.params.get("connectTimeoutMS") ||
        parsed.params.get("serverSelectionTimeoutMS"),
    );
    const tlsText = String(
      parsed.params.get("tls") || parsed.params.get("ssl") || "",
    )
      .trim()
      .toLowerCase();
    const tlsInsecureText = String(
      parsed.params.get("tlsInsecure") ||
        parsed.params.get("sslInsecure") ||
        "",
    )
      .trim()
      .toLowerCase();
    const tlsEnabled =
      tlsText === "1" ||
      tlsText === "true" ||
      tlsText === "yes" ||
      tlsText === "on";
    const tlsInsecure =
      tlsInsecureText === "1" ||
      tlsInsecureText === "true" ||
      tlsInsecureText === "yes" ||
      tlsInsecureText === "on";
    return {
      host: primary?.host || "localhost",
      port: primary?.port || 27017,
      user: parsed.username,
      password: parsed.password,
      database: parsed.database || "",
      useSSL: tlsEnabled,
      sslMode: tlsEnabled
        ? tlsInsecure
          ? "skip-verify"
          : "required"
        : "disable",
      ...extractSSLPathValuesFromParams(parsed.params, type),
      mongoTopology:
        hostList.length > 1 || !!parsed.params.get("replicaSet")
          ? "replica"
          : "single",
      mongoHosts: hostList.slice(1),
      mongoSrv: isSrv,
      mongoReplicaSet: parsed.params.get("replicaSet") || "",
      mongoAuthSource: parsed.params.get("authSource") || "",
      mongoReadPreference: parsed.params.get("readPreference") || "primary",
      mongoAuthMechanism: parsed.params.get("authMechanism") || "",
      connectionParams: serializeConnectionParams(parsed.params),
      timeout:
        Number.isFinite(timeoutMs) && timeoutMs > 0
          ? Math.min(MAX_TIMEOUT_SECONDS, Math.ceil(timeoutMs / 1000))
          : undefined,
      savePassword: true,
    };
  }

  if (type === "kafka") {
    const defaultPort = getDefaultPortByType(type);
    const parsed =
      parseMultiHostUri(trimmedUri, "kafka") ||
      parseMultiHostUri(trimmedUri, "apache-kafka") ||
      parseMultiHostUri(trimmedUri, "apache_kafka");
    if (!parsed) {
      return null;
    }
    if (!parsed.hosts.length || parsed.hosts.length > MAX_URI_HOSTS) {
      return null;
    }
    if (parsed.hosts.some((entry) => !isValidUriHostEntry(entry))) {
      return null;
    }
    const hostList = normalizeAddressList(parsed.hosts, defaultPort);
    if (!hostList.length) {
      return null;
    }
    const primary = parseHostPort(
      hostList[0] || `localhost:${defaultPort}`,
      defaultPort,
    );
    const tlsEnabled = normalizeUriBool(
      parsed.params.get("tls") ||
        parsed.params.get("ssl") ||
        parsed.params.get("useSSL") ||
        parsed.params.get("use_ssl"),
    );
    const skipVerify = normalizeUriBool(
      parsed.params.get("skip_verify") || parsed.params.get("skipVerify"),
    );
    const topology = String(parsed.params.get("topology") || "")
      .trim()
      .toLowerCase();
    const timeoutValue = Number(parsed.params.get("timeout"));
    return {
      host: primary?.host || "localhost",
      port: primary?.port || defaultPort,
      user: parsed.username,
      password: parsed.password,
      database: parsed.database || "",
      useSSL: tlsEnabled,
      sslMode: tlsEnabled ? (skipVerify ? "skip-verify" : "required") : "disable",
      ...extractSSLPathValuesFromParams(parsed.params, type),
      kafkaTopology:
        topology === "cluster" || hostList.length > 1 ? "cluster" : "single",
      kafkaHosts: hostList.slice(1),
      connectionParams: serializeConnectionParams(parsed.params),
      timeout:
        Number.isFinite(timeoutValue) && timeoutValue > 0
          ? Math.min(MAX_TIMEOUT_SECONDS, Math.trunc(timeoutValue))
          : undefined,
    };
  }

  if (type === "mqtt") {
    const defaultPort = getDefaultPortByType(type);
    const parsed =
      parseMultiHostUri(trimmedUri, "mqtt") ||
      parseMultiHostUri(trimmedUri, "mqtts") ||
      parseMultiHostUri(trimmedUri, "tcp") ||
      parseMultiHostUri(trimmedUri, "ssl") ||
      parseMultiHostUri(trimmedUri, "tls");
    if (!parsed) {
      return null;
    }
    if (!parsed.hosts.length || parsed.hosts.length > MAX_URI_HOSTS) {
      return null;
    }
    if (parsed.hosts.some((entry) => !isValidUriHostEntry(entry))) {
      return null;
    }
    const hostList = normalizeAddressList(parsed.hosts, defaultPort);
    if (!hostList.length) {
      return null;
    }
    const primary = parseHostPort(
      hostList[0] || `localhost:${defaultPort}`,
      defaultPort,
    );
    const lowerUri = trimmedUri.toLowerCase();
    const tlsEnabled =
      lowerUri.startsWith("mqtts://") ||
      lowerUri.startsWith("ssl://") ||
      lowerUri.startsWith("tls://") ||
      normalizeUriBool(
        parsed.params.get("tls") ||
          parsed.params.get("ssl") ||
          parsed.params.get("useSSL") ||
          parsed.params.get("use_ssl"),
      );
    const skipVerify = normalizeUriBool(
      parsed.params.get("skip_verify") || parsed.params.get("skipVerify"),
    );
    const topology = String(parsed.params.get("topology") || "")
      .trim()
      .toLowerCase();
    const timeoutValue = Number(parsed.params.get("timeout"));
    return {
      host: primary?.host || "localhost",
      port: primary?.port || defaultPort,
      user: parsed.username,
      password: parsed.password,
      database: parsed.database || "",
      useSSL: tlsEnabled,
      sslMode: tlsEnabled ? (skipVerify ? "skip-verify" : "required") : "disable",
      ...extractSSLPathValuesFromParams(parsed.params, type),
      mqttTopology:
        topology === "cluster" || hostList.length > 1 ? "cluster" : "single",
      mqttHosts: hostList.slice(1),
      connectionParams: serializeConnectionParams(parsed.params),
      timeout:
        Number.isFinite(timeoutValue) && timeoutValue > 0
          ? Math.min(MAX_TIMEOUT_SECONDS, Math.trunc(timeoutValue))
          : undefined,
    };
  }

  if (type === "rocketmq") {
    const defaultPort = getDefaultPortByType(type);
    const parsed =
      parseMultiHostUri(trimmedUri, "rocketmq") ||
      parseMultiHostUri(trimmedUri, "rmq");
    if (!parsed) {
      return null;
    }
    if (!parsed.hosts.length || parsed.hosts.length > MAX_URI_HOSTS) {
      return null;
    }
    if (parsed.hosts.some((entry) => !isValidUriHostEntry(entry))) {
      return null;
    }
    const hostList = normalizeAddressList(parsed.hosts, defaultPort);
    if (!hostList.length) {
      return null;
    }
    const primary = parseHostPort(
      hostList[0] || `localhost:${defaultPort}`,
      defaultPort,
    );
    const topology = String(parsed.params.get("topology") || "")
      .trim()
      .toLowerCase();
    const timeoutValue = Number(parsed.params.get("timeout"));
    return {
      host: primary?.host || "localhost",
      port: primary?.port || defaultPort,
      user: parsed.username,
      password: parsed.password,
      database: parsed.database || "",
      rocketmqTopology:
        topology === "cluster" || hostList.length > 1 ? "cluster" : "single",
      rocketmqHosts: hostList.slice(1),
      connectionParams: serializeConnectionParams(parsed.params),
      timeout:
        Number.isFinite(timeoutValue) && timeoutValue > 0
          ? Math.min(MAX_TIMEOUT_SECONDS, Math.trunc(timeoutValue))
          : undefined,
    };
  }

  if (type === "rabbitmq") {
    const defaultPort = getDefaultPortByType(type);
    const parsed = parseSingleHostUri(
      trimmedUri,
      ["rabbitmq", "http", "https"],
      defaultPort,
    );
    if (!parsed) {
      return null;
    }
    const lowerUri = trimmedUri.toLowerCase();
    const tlsEnabled =
      lowerUri.startsWith("https://") ||
      normalizeUriBool(
        parsed.params.get("tls") ||
          parsed.params.get("ssl") ||
          parsed.params.get("useSSL") ||
          parsed.params.get("use_ssl"),
      );
    const skipVerify = normalizeUriBool(
      parsed.params.get("skip_verify") || parsed.params.get("skipVerify"),
    );
    const timeoutValue = Number(parsed.params.get("timeout"));
    return {
      host: parsed.host,
      port: parsed.port,
      user: parsed.username,
      password: parsed.password,
      database: parsed.database || "",
      useSSL: tlsEnabled,
      sslMode: tlsEnabled ? (skipVerify ? "skip-verify" : "required") : "disable",
      ...extractSSLPathValuesFromParams(parsed.params, type),
      connectionParams: serializeConnectionParams(parsed.params),
      timeout:
        Number.isFinite(timeoutValue) && timeoutValue > 0
          ? Math.min(MAX_TIMEOUT_SECONDS, Math.trunc(timeoutValue))
          : undefined,
    };
  }

  if (type === "trino") {
    return parseTrinoUriToValues(trimmedUri);
  }

  if (type === "clickhouse") {
    const httpValues = parseClickHouseHTTPUriToValues(trimmedUri);
    if (httpValues) {
      return httpValues;
    }
  }

  if (type === "nacos") {
    const parsed = parseSingleHostUri(
      trimmedUri,
      ["http", "https", "nacos"],
      getDefaultPortByType(type),
    );
    if (!parsed) {
      return null;
    }
    const {
      connectionParams: paramsWithoutScope,
      scope,
    } = extractNacosConnectionScope(parsed.params.toString());
    const params = new URLSearchParams(paramsWithoutScope);
    const contextPath = normalizeNacosContextPath(
      parsed.database
        ? `/${parsed.database}`
        : parsed.hasExplicitPath
          ? "/"
          : params.get("contextPath") || "/nacos",
    );
    params.set("contextPath", contextPath);
    const useSSL = trimmedUri.toLowerCase().startsWith("https://");
    return {
      host: parsed.host,
      port: parsed.port,
      user: parsed.username,
      password: parsed.password,
      useSSL,
      sslMode: useSSL ? "required" : "disable",
      nacosNamespaceId: scope.namespaceId,
      connectionParams: params.toString(),
    };
  }

  const singleHostSchemes = singleHostUriSchemesByType[type];
  if (singleHostSchemes && singleHostSchemes.length > 0) {
    const parsed = parseSingleHostUri(
      trimmedUri,
      singleHostSchemes,
      getDefaultPortByType(type),
    );
    if (!parsed) {
      return null;
    }
    const oracleTarget =
      type === "oracle"
        ? resolveOracleConnectionTarget(parsed.params.toString())
        : null;
    if (
      type === "oracle" &&
      !String(parsed.database || "").trim() &&
      !oracleTarget?.sid
    ) {
      // Oracle 必须提供 Service Name path 或 SID 查询参数之一。
      return null;
    }
    const parsedValues: Record<string, any> = {
      host: parsed.host,
      port: parsed.port,
      user: parsed.username,
      password: parsed.password,
      database:
        oracleTarget?.mode === "sid" ? oracleTarget.sid : parsed.database,
      ...(oracleTarget ? { oracleMode: oracleTarget.mode } : {}),
    };
    if (supportsConnectionParamsForType(type)) {
      parsedValues.connectionParams = serializeConnectionParams(parsed.params);
    }

    if (supportsSSLForType(type)) {
      Object.assign(parsedValues, extractSSLPathValuesFromParams(parsed.params, type));
      const normalizeBool = (raw: unknown) => {
        const text = String(raw ?? "")
          .trim()
          .toLowerCase();
        return (
          text === "1" || text === "true" || text === "yes" || text === "on"
        );
      };
      if (
        type === "postgres" ||
        type === "kingbase" ||
        type === "highgo" ||
        type === "vastbase" ||
        type === "opengauss" ||
        type === "gaussdb"
      ) {
        const sslMode = String(parsed.params.get("sslmode") || "")
          .trim()
          .toLowerCase();
        if (sslMode) {
          parsedValues.useSSL = sslMode !== "disable" && sslMode !== "false";
          parsedValues.sslMode =
            sslMode === "disable" || sslMode === "false"
              ? "disable"
              : "required";
        }
      } else if (type === "sqlserver") {
        const encrypt = String(parsed.params.get("encrypt") || "")
          .trim()
          .toLowerCase();
        const trust = String(
          parsed.params.get("TrustServerCertificate") ||
            parsed.params.get("trustservercertificate") ||
            "",
        )
          .trim()
          .toLowerCase();
        const encrypted =
          encrypt === "true" ||
          encrypt === "mandatory" ||
          encrypt === "yes" ||
          encrypt === "1" ||
          encrypt === "strict";
        if (encrypted) {
          parsedValues.useSSL = true;
          parsedValues.sslMode =
            trust === "true" || trust === "1" || trust === "yes"
              ? "skip-verify"
              : "required";
        } else if (encrypt) {
          parsedValues.useSSL = false;
          parsedValues.sslMode = "disable";
        }
      } else if (type === "clickhouse") {
        parsedValues.clickHouseProtocol = normalizeClickHouseProtocolValue(
          parsed.params.get("protocol"),
        );
        const secure = String(
          parsed.params.get("secure") || parsed.params.get("tls") || "",
        )
          .trim()
          .toLowerCase();
        const skipVerify = normalizeBool(parsed.params.get("skip_verify"));
        if (secure) {
          parsedValues.useSSL = normalizeBool(secure);
          parsedValues.sslMode = skipVerify
            ? "skip-verify"
            : parsedValues.useSSL
              ? "required"
              : "disable";
        }
      } else if (type === "dameng") {
        const certPath = String(
          parsed.params.get("SSL_CERT_PATH") ||
            parsed.params.get("ssl_cert_path") ||
            parsed.params.get("sslCertPath") ||
            "",
        ).trim();
        const keyPath = String(
          parsed.params.get("SSL_KEY_PATH") ||
            parsed.params.get("ssl_key_path") ||
            parsed.params.get("sslKeyPath") ||
            "",
        ).trim();
        parsedValues.sslCertPath = certPath;
        parsedValues.sslKeyPath = keyPath;
        if (certPath || keyPath) {
          parsedValues.useSSL = true;
          parsedValues.sslMode = "required";
        }
      } else if (type === "oracle") {
        const ssl = String(
          parsed.params.get("SSL") || parsed.params.get("ssl") || "",
        )
          .trim()
          .toLowerCase();
        const sslVerify = String(
          parsed.params.get("SSL VERIFY") ||
            parsed.params.get("ssl verify") ||
            parsed.params.get("SSL_VERIFY") ||
            parsed.params.get("ssl_verify") ||
            "",
        )
          .trim()
          .toLowerCase();
        if (ssl) {
          parsedValues.useSSL = normalizeBool(ssl);
          if (!parsedValues.useSSL) {
            parsedValues.sslMode = "disable";
          } else {
            parsedValues.sslMode = normalizeBool(sslVerify || "true")
              ? "required"
              : "skip-verify";
          }
        }
      } else if (type === "tdengine") {
        const protocol = String(parsed.params.get("protocol") || "")
          .trim()
          .toLowerCase();
        const skipVerify = normalizeBool(parsed.params.get("skip_verify"));
        if (protocol === "wss") {
          parsedValues.useSSL = true;
          parsedValues.sslMode = skipVerify ? "skip-verify" : "required";
        } else if (protocol === "ws") {
          parsedValues.useSSL = false;
          parsedValues.sslMode = "disable";
        }
      } else if (type === "chroma" || type === "qdrant" || type === "milvus") {
        const tls = String(
          parsed.params.get("tls") ||
            parsed.params.get("ssl") ||
            parsed.params.get("useSSL") ||
            parsed.params.get("use_ssl") ||
            "",
        )
          .trim()
          .toLowerCase();
        const skipVerify = normalizeBool(
          parsed.params.get("skip_verify") || parsed.params.get("skipVerify"),
        );
        const enabled = tls ? normalizeBool(tls) : trimmedUri.toLowerCase().startsWith("https://");
        parsedValues.useSSL = enabled;
        parsedValues.sslMode = enabled ? (skipVerify ? "skip-verify" : "required") : "disable";
      }
    }
    return parsedValues;
  }

  return null;
};

export const getUriPlaceholder = (dbType: string) => {
  if (isMySQLCompatibleType(dbType)) {
    const defaultPort = getDefaultPortByType(dbType);
    const scheme =
      dbType === "diros" ? "doris" : dbType === "starrocks" ? "starrocks" : dbType === "oceanbase" ? "oceanbase" : dbType === "goldendb" ? "goldendb" : "mysql";
    if (dbType === "oceanbase") {
      return `${scheme}://sys%40oracle001:pass@127.0.0.1:${defaultPort}?protocol=oracle`;
    }
    return `${scheme}://user:pass@127.0.0.1:${defaultPort},127.0.0.2:${defaultPort}/db_name?topology=replica`;
  }
  if (isFileDatabaseType(dbType)) {
    return dbType === "duckdb"
      ? "duckdb:///Users/name/demo.duckdb"
      : "sqlite:///Users/name/demo.sqlite";
  }
  if (dbType === "mongodb") {
    return "mongodb+srv://user:pass@cluster0.example.com/db_name?authSource=admin&authMechanism=SCRAM-SHA-256";
  }
  if (dbType === "clickhouse") {
    return "clickhouse://default:pass@127.0.0.1:9000/default";
  }
  if (dbType === "trino") {
    return "http://user@127.0.0.1:8080?catalog=hive&schema=default&source=GoNavi";
  }
  if (dbType === "chroma") {
    return "http://127.0.0.1:8000/default_database?tenant=default_tenant";
  }
  if (dbType === "qdrant") {
    return "http://127.0.0.1:6333";
  }
  if (dbType === "milvus") {
    return "http://127.0.0.1:19530/default";
  }
  if (dbType === "iotdb") {
    return "iotdb://root:root@127.0.0.1:6667/root.sg";
  }
  if (dbType === "rocketmq") {
    return "rocketmq://accessKey:secretKey@127.0.0.1:9876,127.0.0.2:9876/orders.events?topology=cluster&groupId=gonavi&namespace=prod&tag=TagA&pullBatchSize=32&startOffset=latest";
  }
  if (dbType === "mqtt") {
    return "mqtt://user:pass@127.0.0.1:1883/devices%2F%2B%2Ftelemetry?topology=cluster&clientId=gonavi-desktop&qos=1";
  }
  if (dbType === "kafka") {
    return "kafka://user:pass@127.0.0.1:9092,127.0.0.2:9092/orders.events?topology=cluster&groupId=analytics&mechanism=scram-sha-256";
  }
  if (dbType === "rabbitmq") {
    return "rabbitmq://guest:guest@127.0.0.1:15672/%2F?defaultQueue=orders.queue&exchange=events.topic&timeout=30";
  }
  if (dbType === "redis") {
    return t("connection.modal.example.or", {
      first:
        "redis://:pass@127.0.0.1:6379,127.0.0.2:6379/0?topology=cluster",
      second:
        "redis://:pass@10.0.0.1:26379,10.0.0.2:26379/0?topology=sentinel&master=mymaster",
    });
  }
  if (dbType === "nacos") {
    return "http://nacos:nacos@127.0.0.1:8848/nacos?namespaceId=dev";
  }
  if (dbType === "oracle") {
    return "oracle://user:pass@127.0.0.1:1521/ORCLPDB1";
  }
  if (dbType === "iris") {
    return "iris://user:pass@127.0.0.1:1972/USER";
  }
  if (dbType === "opengauss") {
    return "opengauss://user:pass@127.0.0.1:5432/db_name";
  }
  if (dbType === "gaussdb") {
    return "gaussdb://user:pass@127.0.0.1:5432/db_name";
  }
  return t("connection.modal.example", {
    value: "postgres://user:pass@127.0.0.1:5432/db_name",
  });
};

export const getConnectionParamsPlaceholder = (
  dbType: string,
  oceanBaseProtocol: OceanBaseProtocolChoice,
) => {
  if (dbType === "oceanbase") {
    return oceanBaseProtocol === "oracle"
      ? "PREFETCH_ROWS=5000"
      : "useUnicode=true&characterEncoding=utf8&autoReconnect=true&useSSL=false";
  }
  if (isMySQLCompatibleType(dbType)) {
    return "useUnicode=true&characterEncoding=utf8&autoReconnect=true&useSSL=false";
  }
  switch (dbType) {
    case "postgres":
    case "kingbase":
    case "highgo":
    case "vastbase":
    case "opengauss":
    case "gaussdb":
      return "application_name=GoNavi&statement_timeout=30000";
    case "oracle":
      return "PREFETCH_ROWS=5000&TRACE FILE=/tmp/go-ora.trc";
    case "sqlserver":
      return "app name=GoNavi&packet size=32767";
    case "iris":
      return "timeout=30";
    case "clickhouse":
      return "max_execution_time=60&compress=lz4";
    case "trino":
      return "session_properties=query_max_execution_time:30m&query_timeout=30s";
    case "mongodb":
      return "retryWrites=true&readPreference=secondaryPreferred";
    case "chroma":
      return "tenant=default_tenant&apiKey=...";
    case "qdrant":
      return "apiKey=...";
    case "milvus":
      return "token=...";
    case "dameng":
      return "schema=SYSDBA";
    case "tdengine":
      return "timezone=Asia%2FShanghai";
    case "iotdb":
      return "fetchSize=1024&timeZone=Asia%2FShanghai";
    case "rocketmq":
      return "groupId=gonavi&namespace=prod&tag=TagA&pullBatchSize=32&startOffset=latest";
    case "mqtt":
      return "topics=devices%2F%2B%2Ftelemetry,%24SYS%2F%23&clientId=gonavi-desktop&qos=1&cleanSession=true&fetchWaitMs=4000";
    case "kafka":
      return "groupId=gonavi&mechanism=scram-sha-256&clientId=gonavi-desktop&startOffset=latest";
    case "rabbitmq":
      return "defaultQueue=orders.queue&exchange=events.topic&managementPathPrefix=/rabbitmq";
    case "nacos":
      return "contextPath=/nacos";
    default:
      return "key=value&another=value";
  }
};

export const buildUriFromValues = (values: any) => {
  const type = String(values.type || "")
    .trim()
    .toLowerCase();
  const defaultPort = getDefaultPortByType(type);
  const host = String(values.host || "localhost").trim();
  const port = Number(values.port || defaultPort);
  const user = String(values.user || "").trim();
  const password = String(values.password || "");
  const database = String(values.database || "").trim();
  const timeout = Number(values.timeout || 30);
  const encodedAuth = user
    ? `${encodeURIComponent(user)}${password ? `:${encodeURIComponent(password)}` : ""}@`
    : "";

  if (type === "trino") {
    const params = new URLSearchParams();
    mergeConnectionParams(params, values.connectionParams);

    const { catalog, schema } = splitTrinoNamespace(values.database);
    if (catalog) {
      params.set("catalog", catalog);
    } else {
      params.delete("catalog");
    }
    if (schema) {
      params.set("schema", schema);
    } else {
      params.delete("schema");
    }
    if (!String(params.get("source") || "").trim()) {
      params.set("source", "GoNavi");
    }

    if (values.useSSL) {
      const mode = String(values.sslMode || "required")
        .trim()
        .toLowerCase();
      if (mode === "skip-verify" || mode === "preferred") {
        params.set("skip_verify", "true");
      } else {
        params.delete("skip_verify");
      }
      appendSSLPathParamsForUri(params, type, values);
    } else {
      params.delete("skip_verify");
    }

    const query = params.toString();
    const scheme = values.useSSL ? "https" : "http";
    return `${scheme}://${encodedAuth}${toAddress(host, port, defaultPort)}${query ? `?${query}` : ""}`;
  }

  if (type === "nacos") {
    const {
      connectionParams: paramsWithoutStoredScope,
      scope: storedScope,
    } = extractNacosConnectionScope(values.connectionParams);
    const params = new URLSearchParams(paramsWithoutStoredScope);
    const contextPath = encodeNacosContextPath(
      params.get("contextPath") || "/nacos",
    );
    params.delete("contextPath");
    const hasDedicatedNamespaceId =
      Object.prototype.hasOwnProperty.call(values, "nacosNamespaceId") &&
      values.nacosNamespaceId !== undefined;
    const namespaceId = String(
      hasDedicatedNamespaceId
        ? values.nacosNamespaceId
        : storedScope.namespaceId,
    ).trim();
    if (namespaceId) {
      params.set("namespaceId", namespaceId);
    }
    const query = params.toString();
    const scheme = values.useSSL ? "https" : "http";
    return `${scheme}://${encodedAuth}${toAddress(host, port, defaultPort)}${contextPath}${query ? `?${query}` : ""}`;
  }

  if (isMySQLCompatibleType(type)) {
    const selectedOceanBaseProtocol =
      type === "oceanbase"
        ? normalizeOceanBaseProtocolValue(values.oceanBaseProtocol)
        : "mysql";
    const primary = toAddress(host, port, defaultPort);
    const replicas =
      selectedOceanBaseProtocol !== "oracle" && values.mysqlTopology === "replica"
        ? normalizeAddressList(values.mysqlReplicaHosts, defaultPort)
        : [];
    const hosts = normalizeAddressList([primary, ...replicas], defaultPort);
    const params = new URLSearchParams();
    if (hosts.length > 1 || values.mysqlTopology === "replica") {
      params.set("topology", "replica");
    }
    if (values.useSSL) {
      const mode = String(values.sslMode || "preferred")
        .trim()
        .toLowerCase();
      if (mode === "required") {
        params.set("tls", "true");
      } else if (mode === "skip-verify") {
        params.set("tls", "skip-verify");
      } else {
        params.set("tls", "preferred");
      }
    }
    appendSSLPathParamsForUri(params, type, values);
    if (Number.isFinite(timeout) && timeout > 0) {
      params.set("timeout", String(timeout));
    }
    mergeConnectionParams(params, values.connectionParams);
    if (type === "oceanbase") {
      params.set("protocol", selectedOceanBaseProtocol);
    }
    const dbPath = database ? `/${encodeURIComponent(database)}` : "/";
    const query = params.toString();
    const scheme =
      type === "diros" ? "doris" : type === "starrocks" ? "starrocks" : type === "oceanbase" ? "oceanbase" : type === "goldendb" ? "goldendb" : "mysql";
    return `${scheme}://${encodedAuth}${hosts.join(",")}${dbPath}${query ? `?${query}` : ""}`;
  }

  if (type === "kafka") {
    const primary = toAddress(host, port, defaultPort);
    const brokers =
      values.kafkaTopology === "cluster"
        ? normalizeAddressList(values.kafkaHosts, defaultPort)
        : [];
    const allBrokers = normalizeAddressList([primary, ...brokers], defaultPort);
    const params = new URLSearchParams();
    if (allBrokers.length > 1 || values.kafkaTopology === "cluster") {
      params.set("topology", "cluster");
    }
    if (values.useSSL) {
      const mode = String(values.sslMode || "preferred")
        .trim()
        .toLowerCase();
      params.set("tls", "true");
      if (mode === "skip-verify" || mode === "preferred") {
        params.set("skip_verify", "true");
      }
      appendSSLPathParamsForUri(params, type, values);
    }
    if (Number.isFinite(timeout) && timeout > 0) {
      params.set("timeout", String(timeout));
    }
    mergeConnectionParams(params, values.connectionParams);
    const topicPath = database ? `/${encodeURIComponent(database)}` : "";
    const query = params.toString();
    return `kafka://${encodedAuth}${allBrokers.join(",")}${topicPath}${query ? `?${query}` : ""}`;
  }

  if (type === "mqtt") {
    const primary = toAddress(host, port, defaultPort);
    const brokers =
      values.mqttTopology === "cluster"
        ? normalizeAddressList(values.mqttHosts, defaultPort)
        : [];
    const allBrokers = normalizeAddressList([primary, ...brokers], defaultPort);
    const params = new URLSearchParams();
    if (allBrokers.length > 1 || values.mqttTopology === "cluster") {
      params.set("topology", "cluster");
    }
    if (values.useSSL) {
      const mode = String(values.sslMode || "preferred")
        .trim()
        .toLowerCase();
      params.set("tls", "true");
      if (mode === "skip-verify" || mode === "preferred") {
        params.set("skip_verify", "true");
      }
      appendSSLPathParamsForUri(params, type, values);
    }
    if (Number.isFinite(timeout) && timeout > 0) {
      params.set("timeout", String(timeout));
    }
    mergeConnectionParams(params, values.connectionParams);
    const topicPath = database ? `/${encodeURIComponent(database)}` : "";
    const query = params.toString();
    return `mqtt://${encodedAuth}${allBrokers.join(",")}${topicPath}${query ? `?${query}` : ""}`;
  }

  if (type === "rocketmq") {
    const primary = toAddress(host, port, defaultPort);
    const nameservers =
      values.rocketmqTopology === "cluster"
        ? normalizeAddressList(values.rocketmqHosts, defaultPort)
        : [];
    const allNameServers = normalizeAddressList([primary, ...nameservers], defaultPort);
    const params = new URLSearchParams();
    if (allNameServers.length > 1 || values.rocketmqTopology === "cluster") {
      params.set("topology", "cluster");
    }
    if (Number.isFinite(timeout) && timeout > 0) {
      params.set("timeout", String(timeout));
    }
    mergeConnectionParams(params, values.connectionParams);
    const topicPath = database ? `/${encodeURIComponent(database)}` : "";
    const query = params.toString();
    return `rocketmq://${encodedAuth}${allNameServers.join(",")}${topicPath}${query ? `?${query}` : ""}`;
  }

  if (type === "rabbitmq") {
    const address = toAddress(host, port, defaultPort);
    const params = new URLSearchParams();
    if (values.useSSL) {
      const mode = String(values.sslMode || "preferred")
        .trim()
        .toLowerCase();
      params.set("tls", "true");
      if (mode === "skip-verify" || mode === "preferred") {
        params.set("skip_verify", "true");
      }
      appendSSLPathParamsForUri(params, type, values);
    }
    if (Number.isFinite(timeout) && timeout > 0) {
      params.set("timeout", String(timeout));
    }
    mergeConnectionParams(params, values.connectionParams);
    const vhostPath = database ? `/${encodeURIComponent(database)}` : "";
    const query = params.toString();
    return `rabbitmq://${encodedAuth}${address}${vhostPath}${query ? `?${query}` : ""}`;
  }

  if (type === "redis") {
    return buildRedisUriFromValues(values);
  }

  if (isFileDatabaseType(type)) {
    const pathText = normalizeFileDbPath(String(values.host || "").trim());
    if (!pathText) {
      return `${type}://`;
    }
    return `${type}://${encodeURI(pathText)}`;
  }

  if (type === "mongodb") {
    const useSrv = !!values.mongoSrv;
    const primaryAddress = useSrv
      ? parseHostPort(host, 27017)?.host || host || "localhost"
      : toAddress(host, port, 27017);
    const extraNodes =
      values.mongoTopology === "replica"
        ? useSrv
          ? normalizeMongoSrvHostList(values.mongoHosts, 27017)
          : normalizeAddressList(values.mongoHosts, 27017)
        : [];
    const hosts = useSrv
      ? normalizeMongoSrvHostList([primaryAddress, ...extraNodes], 27017)
      : normalizeAddressList([primaryAddress, ...extraNodes], 27017);
    const scheme = useSrv ? "mongodb+srv" : "mongodb";
    const params = new URLSearchParams();
    const authSource = String(
      values.mongoAuthSource || database || "admin",
    ).trim();
    if (authSource) {
      params.set("authSource", authSource);
    }
    const replicaSet = String(values.mongoReplicaSet || "").trim();
    if (replicaSet) {
      params.set("replicaSet", replicaSet);
    }
    const readPreference = String(values.mongoReadPreference || "").trim();
    if (readPreference) {
      params.set("readPreference", readPreference);
    }
    const authMechanism = String(values.mongoAuthMechanism || "").trim();
    if (authMechanism) {
      params.set("authMechanism", authMechanism);
    }
    if (values.useSSL) {
      const mode = String(values.sslMode || "preferred")
        .trim()
        .toLowerCase();
      params.set("tls", "true");
      if (mode === "skip-verify" || mode === "preferred") {
        params.set("tlsInsecure", "true");
      } else {
        params.delete("tlsInsecure");
      }
    }
    appendSSLPathParamsForUri(params, type, values);
    if (Number.isFinite(timeout) && timeout > 0) {
      params.set("connectTimeoutMS", String(timeout * 1000));
      params.set("serverSelectionTimeoutMS", String(timeout * 1000));
    }
    mergeConnectionParams(params, values.connectionParams);
    const dbPath = database ? `/${encodeURIComponent(database)}` : "/";
    const query = params.toString();
    return `${scheme}://${encodedAuth}${hosts.join(",")}${dbPath}${query ? `?${query}` : ""}`;
  }

  const clickHouseProtocol =
    type === "clickhouse"
      ? normalizeClickHouseProtocolValue(values.clickHouseProtocol)
      : "auto";
  const scheme =
    type === "gaussdb"
      ? "gaussdb"
      : type === "postgres"
      ? "postgresql"
      : type === "chroma" || type === "qdrant" || type === "milvus"
        ? values.useSSL
          ? "https"
          : "http"
      : type === "clickhouse" && clickHouseProtocol === "http"
        ? values.useSSL
          ? "https"
          : "http"
        : type;
  const oracleSIDMode =
    type === "oracle" &&
    String(values.oracleMode || "service")
      .trim()
      .toLowerCase() === "sid";
  const dbPath =
    !oracleSIDMode && database ? `/${encodeURIComponent(database)}` : "";
  const params = new URLSearchParams();
  if (supportsSSLForType(type) && values.useSSL) {
    const mode = String(values.sslMode || "preferred")
      .trim()
      .toLowerCase();
    if (isPostgresCompatibleSSLType(type)) {
      params.set(
        "sslmode",
        mode === "skip-verify"
          ? "require"
          : String(values.sslCAPath || "").trim()
            ? "verify-ca"
            : "require",
      );
      appendSSLPathParamsForUri(params, type, values);
    } else if (type === "sqlserver") {
      params.set("encrypt", "true");
      params.set(
        "TrustServerCertificate",
        mode === "skip-verify" || mode === "preferred" ? "true" : "false",
      );
      appendSSLPathParamsForUri(params, type, values);
    } else if (type === "clickhouse") {
      if (clickHouseProtocol === "http") {
        if (mode === "skip-verify" || mode === "preferred") {
          params.set("skip_verify", "true");
        }
      } else {
        params.set("secure", "true");
        if (mode === "skip-verify" || mode === "preferred") {
          params.set("skip_verify", "true");
        }
      }
      appendSSLPathParamsForUri(params, type, values);
    } else if (type === "dameng") {
      appendSSLPathParamsForUri(params, type, values);
    } else if (type === "oracle") {
      params.set("SSL", "TRUE");
      params.set("SSL VERIFY", mode === "required" ? "TRUE" : "FALSE");
    } else if (type === "tdengine") {
      params.set("protocol", "wss");
      if (mode === "skip-verify" || mode === "preferred") {
        params.set("skip_verify", "true");
      }
    } else if (type === "chroma" || type === "qdrant" || type === "milvus") {
      if (mode === "skip-verify" || mode === "preferred") {
        params.set("skip_verify", "true");
      }
      appendSSLPathParamsForUri(params, type, values);
    }
  } else if (supportsSSLForType(type)) {
    if (isPostgresCompatibleSSLType(type)) {
      params.set("sslmode", "disable");
    } else if (type === "sqlserver") {
      params.set("encrypt", "disable");
      params.set("TrustServerCertificate", "true");
    } else if (type === "tdengine") {
      params.set("protocol", "ws");
    }
  }
  if (type === "clickhouse" && clickHouseProtocol !== "auto") {
    params.set("protocol", clickHouseProtocol);
  }
  if (supportsConnectionParamsForType(type)) {
    mergeConnectionParams(params, values.connectionParams);
  }
  let query = params.toString();
  if (type === "oracle") {
    query = oracleSIDMode
      ? withOracleSIDParam(query, database)
      : withoutOracleSIDParam(query);
  }
  return `${scheme}://${encodedAuth}${toAddress(host, port, defaultPort)}${dbPath}${query ? `?${query}` : ""}`;
};
