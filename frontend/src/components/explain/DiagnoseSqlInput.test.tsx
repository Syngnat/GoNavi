import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '../../i18n/provider'
import DiagnoseSqlInput from './DiagnoseSqlInput'

const sql = 'SELECT c.id,\n       c.name\n  FROM lab_customers c\n LIMIT 100'

const render = (props: Partial<React.ComponentProps<typeof DiagnoseSqlInput>> = {}) => renderToStaticMarkup(
  <I18nProvider preference="zh-CN" systemLanguages={['zh-CN']} onPreferenceChange={vi.fn()}>
    <DiagnoseSqlInput
      value={sql}
      hasReport={false}
      collapsed={false}
      onChange={vi.fn()}
      onRun={vi.fn()}
      onCollapsedChange={vi.fn()}
      {...props}
    />
  </I18nProvider>,
)

describe('DiagnoseSqlInput', () => {
  it('shows the editor and a run button before the first diagnosis', () => {
    const markup = render()

    expect(markup).toContain('<textarea')
    expect(markup).toContain('运行诊断')
    expect(markup).not.toContain('重新诊断')
    expect(markup).not.toContain('收起')
  })

  it('collapses into a one-line SQL summary once a report exists', () => {
    const markup = render({ hasReport: true, collapsed: true })

    expect(markup).not.toContain('<textarea')
    expect(markup).toContain('SELECT c.id, c.name FROM lab_customers c LIMIT 100')
    expect(markup).toContain('编辑 SQL')
    expect(markup).toContain('重新诊断')
  })

  it('never collapses without a report, so the first run always has an input to edit', () => {
    const markup = render({ hasReport: false, collapsed: true })

    expect(markup).toContain('<textarea')
  })

  it('offers a collapse action while editing an already diagnosed SQL', () => {
    const markup = render({ hasReport: true, collapsed: false })

    expect(markup).toContain('<textarea')
    expect(markup).toContain('收起')
    expect(markup).toContain('重新诊断')
  })
})
