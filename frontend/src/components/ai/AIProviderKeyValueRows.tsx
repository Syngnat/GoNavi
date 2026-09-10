import React from 'react';
import { Button, Input } from 'antd';
import { PlusOutlined } from '@ant-design/icons';

import { newKeyValueRow, type AIProviderKeyValueRow } from '../../utils/aiProviderKeyValue';

interface AIProviderKeyValueRowsProps {
  value?: AIProviderKeyValueRow[];
  onChange?: (rows: AIProviderKeyValueRow[]) => void;
  namePlaceholder: string;
  valuePlaceholder: string;
  addLabel: string;
  removeLabel: string;
}

const AIProviderKeyValueRows: React.FC<AIProviderKeyValueRowsProps> = ({
  value = [],
  onChange,
  namePlaceholder,
  valuePlaceholder,
  addLabel,
  removeLabel,
}) => {
  const rows = value.length ? value : [];
  const patch = (next: AIProviderKeyValueRow[]) => onChange?.(next);
  return <div className="gonavi-ai-provider-kv">
    {rows.map((row, index) => (
      <div className="gonavi-ai-provider-kv-row" key={row.id || `${row.name}-${index}`}>
        <Input size="middle" value={row.name} placeholder={namePlaceholder} spellCheck={false}
          onChange={(event) => patch(rows.map((item, itemIndex) => itemIndex === index ? { ...item, name: event.target.value } : item))} />
        <Input.Password size="middle" value={row.value} placeholder={valuePlaceholder} visibilityToggle
          onChange={(event) => patch(rows.map((item, itemIndex) => itemIndex === index ? { ...item, value: event.target.value } : item))} />
        <Button type="text" size="small" aria-label={removeLabel} onClick={() => patch(rows.filter((_, itemIndex) => itemIndex !== index))}>×</Button>
      </div>
    ))}
    <Button className="gonavi-ai-provider-kv-add" type="dashed" size="middle" icon={<PlusOutlined />}
      onClick={() => patch([...rows, newKeyValueRow()])}>{addLabel}</Button>
  </div>;
};

export default AIProviderKeyValueRows;
