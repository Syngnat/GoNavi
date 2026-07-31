import { describe, expect, it } from 'vitest'
import { formatMs, formatNumber, formatPercent } from '../../utils/explainTypes'

describe('SQL explain graph and sidebar presentation', () => {

  it('formats explain metrics with the active UI language', () => {
    expect(formatNumber(12_345, 'de-DE')).toBe('12.345')
    expect(formatPercent(0.125, 'de-DE')).toBe(
      new Intl.NumberFormat('de-DE', {
        style: 'percent',
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
      }).format(0.125),
    )
    expect(formatMs(1_500, 'de-DE')).toBe('1,50s')
  })
})
