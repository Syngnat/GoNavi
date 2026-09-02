import { describe, expect, it } from 'vitest';

import {
  isRocketMQTagFilteredConnection,
  resolveRocketMQTagExpression,
} from './rocketmqTagFilter';

describe('RocketMQ TAG filter capability', () => {
  it('detects an effective TAG from a RocketMQ URI', () => {
    const config = { type: 'rocketmq', uri: 'rocketmq://localhost:9876/orders?tag=paid' };

    expect(resolveRocketMQTagExpression(config)).toBe('paid');
    expect(isRocketMQTagFilteredConnection(config)).toBe(true);
  });

  it.each([
    'tags=paid',
    'tagExpression=paid',
    'tag_expression=paid',
    'selector=paid',
    'selectorExpression=paid',
    'selector_expression=paid',
  ])('supports backend TAG alias %s', (connectionParams) => {
    expect(isRocketMQTagFilteredConnection({ type: 'apache-rocketmq', connectionParams })).toBe(true);
  });

  it.each(['', 'tag=', 'tag=*', 'tag=all', 'tag=ALL'])('treats %j as an unfiltered connection', (connectionParams) => {
    expect(isRocketMQTagFilteredConnection({ type: 'rocketmq', connectionParams })).toBe(false);
  });

  it('lets connectionParams override the same URI parameter', () => {
    const config = {
      type: 'rmq',
      uri: 'rocketmq://localhost:9876/orders?tag=paid',
      connectionParams: 'tag=*',
    };

    expect(resolveRocketMQTagExpression(config)).toBe('*');
    expect(isRocketMQTagFilteredConnection(config)).toBe(false);
  });

  it('ignores TAG-like parameters for other data sources and unsupported URI schemes', () => {
    expect(isRocketMQTagFilteredConnection({ type: 'mysql', connectionParams: 'tag=paid' })).toBe(false);
    expect(isRocketMQTagFilteredConnection({ type: 'rocketmq', uri: 'mysql://localhost/db?tag=paid' })).toBe(false);
  });
});
