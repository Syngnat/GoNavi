import { describe, expect, it } from 'vitest';

import {
  filterAISlashCommands,
  orderAISlashCommandsForDisplay,
  splitAISlashCommandIcon,
} from './aiSlashCommands';

describe('slash command display helpers', () => {
  it('splits a leading emoji off the label', () => {
    expect(splitAISlashCommandIcon('🔍 Natural language query')).toEqual({ icon: '🔍', text: 'Natural language query' });
    expect(splitAISlashCommandIcon('🛠️ Tools')).toEqual({ icon: '🛠️', text: 'Tools' });
    expect(splitAISlashCommandIcon('Plain label')).toEqual({ icon: '', text: 'Plain label' });
    expect(splitAISlashCommandIcon('')).toEqual({ icon: '', text: '' });
  });

  it('orders commands the way the grouped menu draws them', () => {
    const commands = filterAISlashCommands('/');
    const ordered = orderAISlashCommandsForDisplay(commands);

    expect(ordered).toHaveLength(commands.length);
    const categories = ordered.map((command) => command.category);
    // Categories appear as contiguous blocks: generate, then review, then diagnose.
    expect([...new Set(categories)]).toEqual(['generate', 'review', 'diagnose']);
    expect(categories.join(',')).toBe([...categories].sort((a, b) => ['generate', 'review', 'diagnose'].indexOf(a) - ['generate', 'review', 'diagnose'].indexOf(b)).join(','));
  });
});
