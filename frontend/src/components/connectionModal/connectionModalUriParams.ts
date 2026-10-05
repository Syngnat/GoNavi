import {
  resolveOceanBaseProtocolFromQueryText as resolveOceanBaseProtocolQueryText,
  describeUnsupportedOceanBaseProtocol,
  OCEANBASE_PROTOCOL_PARAM_KEYS,
} from "../../utils/oceanBaseProtocol";
import {
  normalizeConnectionParamsText,
  serializeConnectionParams,
  type OceanBaseProtocolChoice,
  MAX_CONNECTION_PARAMS_LENGTH,
} from "./connectionModalUriHosts";

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

export const mergeConnectionParams = (
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
