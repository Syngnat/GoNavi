import { Collapse, Form } from 'antd';
import type { FormInstance } from 'antd';
import AIProviderKeyValueRows from './AIProviderKeyValueRows';
import type { PluginAIModel } from '../../plugins/aiProvider/types';

type CopyText = (key: string, params?: Record<string, string | number>) => string;

interface AIPluginProviderAdvancedProps {
  t: CopyText;
  form: FormInstance;
  model?: PluginAIModel;
}

interface HeaderRow { name?: string; value?: string }

export default function AIPluginProviderAdvanced({ t, form, model }: AIPluginProviderAdvancedProps) {
  const rawRows = Form.useWatch('headerRows', form) as HeaderRow[] | undefined;
  const headerCount = Array.isArray(rawRows)
    ? rawRows.filter((row) => row && ((row.name ?? '') !== '' || (row.value ?? '') !== '')).length
    : 0;

  return (
    <div className="gn-advanced">
      <Collapse
        ghost
        className="gn-advanced-fold"
        items={[{
          key: 'headers',
          label: (
            <span className="gn-fold-label">
              <span>{t('plugin.ai_provider.headers_folded')}</span>
              {headerCount > 0 && <span className="gn-fold-count">{headerCount}</span>}
            </span>
          ),
          children: (
            <Form.Item name="headerRows">
              <AIProviderKeyValueRows
                namePlaceholder={t('plugin.ai_provider.header_name')}
                valuePlaceholder={t('plugin.ai_provider.header_value')}
                addLabel={t('plugin.ai_provider.add_header')}
                removeLabel={t('common.delete')}
              />
            </Form.Item>
          ),
        }]}
      />
    </div>
  );
}
