import React from 'react';

import type { AIContextItem } from '../../types';
import { AIContextChip, type AIContextChipCopy } from './AIContextChipRow';
import { contextItemToDisplayChip, isTransientContextItem } from './aiContextChips';

interface AIComposerBoundChipsProps {
  items: AIContextItem[];
  copy: AIContextChipCopy;
  onRemove: (dbName: string, tableName: string) => void;
}

/**
 * What the person has bound for the next message (a selection from the editor, a
 * passage quoted from an answer) sits in the input box as small chips, can be taken
 * back with the cross, and is cleared when the message is sent. Table schemas stay
 * in the "context" list: they are a standing setting, not part of one message.
 */
export const AIComposerBoundChips: React.FC<AIComposerBoundChipsProps> = ({ items, copy, onRemove }) => {
  const chips = items
    .filter(isTransientContextItem)
    .flatMap((item, index) => {
      const chip = contextItemToDisplayChip(item);
      return chip ? [{ chip, item, key: `${item.dbName}:${item.tableName}:${index}` }] : [];
    });
  if (chips.length === 0) {
    return null;
  }
  return (
    <div
      className="gn-v2-ai-bound-chips"
      data-ai-bound-chips="true"
      style={{ display: 'flex', flexWrap: 'wrap', gap: 6, paddingBottom: 6 }}
    >
      {chips.map(({ chip, item, key }) => (
        <AIContextChip key={key} chip={chip} copy={copy} onRemove={() => onRemove(item.dbName, item.tableName)} />
      ))}
    </div>
  );
};

export default AIComposerBoundChips;
