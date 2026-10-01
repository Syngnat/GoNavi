import { describe, expect, it } from 'vitest';

import { dataSyncMappingKey } from './dataSyncMappingKey';

describe('dataSyncMappingKey', () => {
  it('unifies case and whitespace so backend and frontend agree', () => {
    const left = dataSyncMappingKey(
      { sourceObject: 'SRC.Orders', targetObject: 'TGT.Orders' },
      '',
      '',
    );
    const right = dataSyncMappingKey(
      { sourceObject: ' src.orders ', targetObject: 'tgt.orders' },
      '',
      '',
    );
    expect(left).toBe(right);
    expect(left).toBe('src.orders -> tgt.orders');
  });

  it('falls back to the task-level schema when the object is unqualified', () => {
    expect(
      dataSyncMappingKey({ sourceObject: 'orders', targetObject: 'orders' }, 'SRC', 'TGT'),
    ).toBe('src.orders -> tgt.orders');
  });

  it('prefers the object schema over the task-level fallback', () => {
    expect(
      dataSyncMappingKey(
        { sourceObject: 'other.orders', targetObject: 'orders' },
        'SRC',
        'TGT',
      ),
    ).toBe('other.orders -> tgt.orders');
  });

  it('does not treat a trailing dot as a schema separator', () => {
    expect(dataSyncMappingKey({ sourceObject: 'orders.', targetObject: 'orders' }, 'SRC', 'TGT')).toBe(
      'src.orders. -> tgt.orders',
    );
  });
});
