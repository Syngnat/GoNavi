// Catalog ordering is a local layout preference, like hidden presets. It stores
// preset keys only; presets the stored order has never seen keep their default
// relative order after the known ones, so an upstream addition still shows up.

export const applyPresetOrder = <T extends { key: string }>(presets: T[], order: string[]): T[] => {
  if (!order.length) return presets;
  const rank = new Map(order.map((key, index) => [key, index]));
  const known = presets.filter((preset) => rank.has(preset.key))
    .sort((a, b) => (rank.get(a.key) ?? 0) - (rank.get(b.key) ?? 0));
  const unknown = presets.filter((preset) => !rank.has(preset.key));
  return [...known, ...unknown];
};

// Move `activeKey` onto `overKey` inside one displayed group (visible catalog or
// hidden list). The group is a subsequence of the full order; its members swap
// slots among themselves while every other key keeps its place.
export const movePresetWithinGroup = (orderedKeys: string[], groupKeys: string[], activeKey: string, overKey: string): string[] => {
  const from = groupKeys.indexOf(activeKey);
  const to = groupKeys.indexOf(overKey);
  if (from < 0 || to < 0 || from === to) return orderedKeys;
  const nextGroup = [...groupKeys];
  const [moved] = nextGroup.splice(from, 1);
  nextGroup.splice(to, 0, moved);
  const members = new Set(groupKeys);
  const next = [...orderedKeys];
  let cursor = 0;
  next.forEach((key, index) => { if (members.has(key)) next[index] = nextGroup[cursor++]; });
  return next;
};
