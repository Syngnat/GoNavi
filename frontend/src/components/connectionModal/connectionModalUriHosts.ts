import { getConnectionTypeDefaultPort as getDefaultPortByType } from "../../utils/connectionTypeCatalog";
import { type OceanBaseProtocol, normalizeOceanBaseProtocol } from "../../utils/oceanBaseProtocol";

export type ClickHouseProtocolChoice = "auto" | "http" | "native";
export type OceanBaseProtocolChoice = OceanBaseProtocol;

export const MAX_URI_LENGTH = 4096;
export const MAX_CONNECTION_PARAMS_LENGTH = 4096;
export const MAX_URI_HOSTS = 32;
export const MAX_TIMEOUT_SECONDS = 3600;

export const getPulsarDefaultPort = (useSSL: boolean) =>
  useSSL ? 6651 : getDefaultPortByType("pulsar");

export const getPulsarPortAfterSSLChange = (
  currentPort: number,
  useSSL: boolean,
  manuallyEdited: boolean,
) =>
  manuallyEdited || currentPort !== getPulsarDefaultPort(!useSSL)
    ? currentPort
    : getPulsarDefaultPort(useSSL);

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

export const isValidUriHostEntry = (entry: string): boolean => {
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

export const safeDecode = (text: string) => {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
};

export const normalizeUriBool = (raw: unknown) => {
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

export const serializeConnectionParams = (params: URLSearchParams) => {
  const cloned = new URLSearchParams();
  params.forEach((value, key) => {
    if (String(key || "").trim()) {
      cloned.append(key, value);
    }
  });
  return cloned.toString().slice(0, MAX_CONNECTION_PARAMS_LENGTH);
};
