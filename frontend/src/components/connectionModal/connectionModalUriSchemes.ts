import { getConnectionTypeDefaultPort as getDefaultPortByType } from "../../utils/connectionTypeCatalog";
import { listRegistryUriSchemes } from "../../utils/dataSourceRegistry/uriScheme";
import {
  supportsSSLCAPathForType,
  supportsSSLClientCertificateForType,
  isPostgresCompatibleSSLType,
} from "../../utils/connectionTypeCapabilities";
import {
  safeDecode,
  MAX_URI_HOSTS,
  isValidUriHostEntry,
  normalizeAddressList,
  parseHostPort,
  normalizeUriBool,
  serializeConnectionParams,
} from "./connectionModalUriHosts";

export const parseMultiHostUri = (uriText: string, expectedScheme: string) => {
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

export const parseSingleHostUri = (
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
  hosts: string[];
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
    hosts: hostList,
  };
};

const splitHostList = (raw: unknown): string[] =>
  String(raw ?? "").split(",").map((item) => item.trim()).filter(Boolean);

/** 把连接串里第一个之外的节点并入 extraHostsParam 参数（与参数里已有的节点合并去重）。 */
export const mergeRegistryExtraHosts = (
  params: URLSearchParams,
  param: string | undefined,
  hosts: string[],
  defaultPort: number,
) => {
  if (!param || hosts.length <= 1) {
    return;
  }
  const merged = normalizeAddressList([...hosts.slice(1), ...splitHostList(params.get(param))], defaultPort);
  params.set(param, merged.join(","));
};

/** 生成连接串时取出 extraHostsParam 参数里的节点（并回主机段），参数本身从查询串里去掉。 */
export const takeRegistryExtraHosts = (
  params: URLSearchParams,
  param: string | undefined,
  defaultPort: number,
): string[] => {
  if (!param || !params.has(param)) {
    return [];
  }
  const hosts = normalizeAddressList(splitHostList(params.get(param)), defaultPort);
  params.delete(param);
  return hosts;
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

export const normalizeNacosContextPath = (raw: unknown): string => {
  const text = String(raw ?? "").trim();
  if (!text || text === "/") {
    return text === "/" ? "/" : "/nacos";
  }
  return `/${text.replace(/^\/+|\/+$/g, "")}`;
};

export const encodeNacosContextPath = (raw: unknown): string => {
  const normalized = normalizeNacosContextPath(raw);
  if (normalized === "/") {
    return "/";
  }
  return normalized
    .split("/")
    .map((segment, index) => (index === 0 ? "" : encodeURIComponent(segment)))
    .join("/");
};

export const splitTrinoNamespace = (
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

// Trino 与使用 Trino 表单的描述表类型（Presto）共用：catalog / schema 可写在参数里，
// 也可写成路径 /catalog.schema 或 JDBC 风格的 /catalog/schema（jdbc: 前缀可省略）。
export const parseTrinoUriToValues = (
  uriText: string,
  type = "trino",
): Record<string, any> | null => {
  const trimmed = String(uriText || "").trim().replace(/^jdbc:/i, "");
  const schemes = type === "trino" ? ["trino", "http", "https"] : [...listRegistryUriSchemes(type)];
  const parsed = parseSingleHostUri(
    trimmed,
    schemes,
    getDefaultPortByType(type),
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

  const pathNamespace = String(parsed.database || "")
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean)
    .join(".");
  const namespace = joinTrinoNamespace(catalog, schema) || pathNamespace;
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
    ...extractSSLPathValuesFromParams(params, type),
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

export const extractSSLPathValuesFromParams = (
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

export const appendSSLPathParamsForUri = (
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
