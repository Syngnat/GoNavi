const ROCKETMQ_URI_SCHEMES = new Set([
  'rocketmq',
  'rocket-mq',
  'rocket_mq',
  'apache-rocketmq',
  'apache_rocketmq',
  'rmq',
]);

const ROCKETMQ_TYPES = new Set(ROCKETMQ_URI_SCHEMES);

const ROCKETMQ_TAG_PARAM_NAMES = [
  'tag',
  'tags',
  'tagExpression',
  'tag_expression',
  'selector',
  'selectorExpression',
  'selector_expression',
] as const;

export type RocketMQTagFilterConfig = {
  type?: unknown;
  uri?: unknown;
  URI?: unknown;
  connectionParams?: unknown;
};

const toText = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const parseRocketMQUriParams = (value: unknown): URLSearchParams => {
  let text = toText(value);
  if (!text) return new URLSearchParams();
  if (text.toLowerCase().startsWith('jdbc:')) text = text.slice('jdbc:'.length).trim();

  try {
    const parsed = new URL(text);
    if (!ROCKETMQ_URI_SCHEMES.has(parsed.protocol.replace(/:$/, '').toLowerCase())) {
      return new URLSearchParams();
    }
    return parsed.searchParams;
  } catch {
    return new URLSearchParams();
  }
};

const parseConnectionParams = (value: unknown): URLSearchParams => {
  let text = toText(value);
  if (!text) return new URLSearchParams();

  const queryIndex = text.indexOf('?');
  if (queryIndex >= 0) text = text.slice(queryIndex + 1);
  const hashIndex = text.indexOf('#');
  if (hashIndex >= 0) text = text.slice(0, hashIndex);
  text = text.trim().replace(/^[?&]+/, '');
  return new URLSearchParams(text);
};

const mergeParams = (target: URLSearchParams, source: URLSearchParams): void => {
  source.forEach((value, key) => target.set(key, value));
};

export const resolveRocketMQTagExpression = (config: RocketMQTagFilterConfig | null | undefined): string => {
  if (!config) return '';

  const params = new URLSearchParams();
  mergeParams(params, parseRocketMQUriParams(config.uri ?? config.URI));
  mergeParams(params, parseConnectionParams(config.connectionParams));

  for (const name of ROCKETMQ_TAG_PARAM_NAMES) {
    const value = toText(params.get(name));
    if (value) return value;
  }
  return '';
};

export const isRocketMQTagExpressionDefault = (value: unknown): boolean => {
  const text = toText(value);
  return text === '' || text === '*' || text.toLowerCase() === 'all';
};

export const isRocketMQTagFilteredConnection = (config: RocketMQTagFilterConfig | null | undefined): boolean => {
  if (!config || !ROCKETMQ_TYPES.has(toText(config.type).toLowerCase())) return false;
  return !isRocketMQTagExpressionDefault(resolveRocketMQTagExpression(config));
};
