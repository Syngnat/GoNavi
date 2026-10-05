import { getDataSourceSpec } from './index';

const normalize = (value: unknown): string => String(value ?? '').trim().toLowerCase();

/** 描述表声明的全部连接串 scheme（首项为该数据源自己的 scheme，如 tidb、cockroachdb）。 */
export const listRegistryUriSchemes = (type: unknown): readonly string[] =>
  getDataSourceSpec(type)?.ui?.uriSchemes ?? [];

/** 生成连接串与占位示例时使用的 scheme；不是描述表类型或未声明时返回 undefined。 */
export const getRegistryUriScheme = (type: unknown): string | undefined => listRegistryUriSchemes(type)[0];

/** HTTP 协议的描述表类型（同时声明 http 与 https）按是否启用 SSL 生成 http:// 或 https:// 连接串。 */
export const usesHttpRegistryUri = (type: unknown): boolean => {
  const spec = getDataSourceSpec(type);
  const schemes = spec?.ui?.uriSchemes ?? [];
  return spec?.wire === 'http' && schemes.includes('http') && schemes.includes('https');
};

/** 连接串里第一个之外的节点存放的连接参数（ui.extraHostsParam，如 ZooKeeper 的 servers）；未声明时返回 undefined。 */
export const getRegistryExtraHostsParam = (type: unknown): string | undefined =>
  getDataSourceSpec(type)?.ui?.extraHostsParam || undefined;

/** 声明了 extraHostsParam 的类型接受不带 scheme 的原生节点串（如 zk1:2181,zk2:2181/kafka），解析前补上自己的 scheme。 */
export const withRegistryUriScheme = (type: unknown, uri: string): string => {
  const scheme = getRegistryUriScheme(type);
  return uri && scheme && getRegistryExtraHostsParam(type) && !uri.includes('://') ? `${scheme}://${uri}` : uri;
};

/** 连接串使用了描述表声明的哪个 scheme，供借用家族解析的分支（如 MySQL 多主机解析）追加识别。 */
export const findRegistryUriScheme = (type: unknown, uri: unknown): string | undefined => {
  const text = normalize(uri);
  return listRegistryUriSchemes(type).find((scheme) => text.startsWith(`${scheme}://`));
};

/** 使用 Trino 连接表单的类型（Trino 本身与 ui.layout 为 trino 的描述表类型，如 Presto）：默认库是 catalog.schema，
 * 连接串用 http(s):// 加 catalog / schema 参数。 */
export const usesTrinoStyleConnection = (type: unknown): boolean =>
  normalize(type) === 'trino' || getDataSourceSpec(type)?.ui?.layout === 'trino';
