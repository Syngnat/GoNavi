export const NACOS_NAMESPACE_ID_PARAM = "namespaceId";

export type NacosConnectionScope = {
  configured: boolean;
  namespaceId: string;
  requestNamespaceId: string;
};

const normalizeNacosConnectionParamsText = (raw: unknown): string => {
  let text = String(raw ?? "").trim();
  const queryIndex = text.indexOf("?");
  if (queryIndex >= 0) {
    text = text.slice(queryIndex + 1);
  }
  const hashIndex = text.indexOf("#");
  if (hashIndex >= 0) {
    text = text.slice(0, hashIndex);
  }
  return text
    .replace(/^[?&]+/, "")
    .replace(/[;\r\n]+/g, "&")
    .trim();
};

const parseNacosConnectionParams = (raw: unknown): URLSearchParams =>
  new URLSearchParams(normalizeNacosConnectionParamsText(raw));

export const resolveNacosConnectionScope = (
  connectionParams: unknown,
): NacosConnectionScope => {
  const params = parseNacosConnectionParams(connectionParams);
  const namespaceId = String(
    params.get(NACOS_NAMESPACE_ID_PARAM) ?? "",
  ).trim();
  const configured = namespaceId !== "";
  return {
    configured,
    namespaceId,
    requestNamespaceId:
      configured && namespaceId.toLowerCase() !== "public"
        ? namespaceId
        : "",
  };
};

export const setNacosConnectionScope = (
  connectionParams: unknown,
  namespaceId: unknown,
): string => {
  const params = parseNacosConnectionParams(connectionParams);
  const normalizedNamespaceId = String(namespaceId ?? "").trim();
  if (normalizedNamespaceId) {
    params.set(NACOS_NAMESPACE_ID_PARAM, normalizedNamespaceId);
  } else {
    params.delete(NACOS_NAMESPACE_ID_PARAM);
  }
  return params.toString();
};

export const extractNacosConnectionScope = (
  connectionParams: unknown,
): {
  connectionParams: string;
  scope: NacosConnectionScope;
} => {
  const params = parseNacosConnectionParams(connectionParams);
  const scope = resolveNacosConnectionScope(params.toString());
  params.delete(NACOS_NAMESPACE_ID_PARAM);
  return {
    connectionParams: params.toString(),
    scope,
  };
};
