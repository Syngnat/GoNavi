export interface SidebarPartitionTableEntry {
  tableName: string;
  schemaName?: string;
  displayName: string;
  partitionParentTableName?: string;
  rowCount?: number;
}

export type GroupedSidebarPartitionTableEntry<T extends SidebarPartitionTableEntry> = T & {
  partitionTables?: GroupedSidebarPartitionTableEntry<T>[];
};

interface GroupSidebarPartitionTableEntriesOptions<T extends SidebarPartitionTableEntry> {
  isEntryVisible?: (entry: T) => boolean;
}

const normalizePartitionTableKey = (value: unknown): string =>
  String(value || '').trim().toLowerCase();

const extractUnqualifiedPartitionTableName = (value: string): string => {
  const separatorIndex = value.indexOf('.');
  return separatorIndex >= 0 ? value.slice(separatorIndex + 1) : value;
};

const buildPartitionEntryKeys = (
  entry: Pick<SidebarPartitionTableEntry, 'tableName' | 'schemaName'>,
): string[] => {
  const tableName = String(entry.tableName || '').trim();
  const schemaName = String(entry.schemaName || '').trim();
  if (!tableName) return [];

  const keys = new Set<string>([normalizePartitionTableKey(tableName)]);
  if (schemaName) {
    const objectName = extractUnqualifiedPartitionTableName(tableName);
    keys.add(normalizePartitionTableKey(`${schemaName}.${objectName}`));
  }
  return Array.from(keys).filter(Boolean);
};

const buildPartitionParentKeys = (
  entry: Pick<SidebarPartitionTableEntry, 'partitionParentTableName' | 'schemaName'>,
): string[] => {
  const parentTableName = String(entry.partitionParentTableName || '').trim();
  const schemaName = String(entry.schemaName || '').trim();
  if (!parentTableName) return [];

  const keys = new Set<string>();
  if (schemaName && !parentTableName.includes('.')) {
    keys.add(normalizePartitionTableKey(`${schemaName}.${parentTableName}`));
  }
  keys.add(normalizePartitionTableKey(parentTableName));
  return Array.from(keys).filter(Boolean);
};

export const groupSidebarPartitionTableEntries = <T extends SidebarPartitionTableEntry>(
  entries: T[],
  options: GroupSidebarPartitionTableEntriesOptions<T> = {},
): GroupedSidebarPartitionTableEntry<T>[] => {
  const groupedEntries = entries
    .filter((entry) => options.isEntryVisible?.(entry) ?? true)
    .map((entry) => ({ ...entry })) as GroupedSidebarPartitionTableEntry<T>[];
  const entryByKey = new Map<string, GroupedSidebarPartitionTableEntry<T>>();

  groupedEntries.forEach((entry) => {
    buildPartitionEntryKeys(entry).forEach((key) => {
      if (!entryByKey.has(key)) entryByKey.set(key, entry);
    });
  });

  const directParentByEntry = new Map<
    GroupedSidebarPartitionTableEntry<T>,
    GroupedSidebarPartitionTableEntry<T>
  >();
  groupedEntries.forEach((entry) => {
    const parent = buildPartitionParentKeys(entry)
      .map((key) => entryByKey.get(key))
      .find((candidate) => candidate && candidate !== entry);
    if (parent) directParentByEntry.set(entry, parent);
  });

  const createsCycle = (
    child: GroupedSidebarPartitionTableEntry<T>,
    parent: GroupedSidebarPartitionTableEntry<T>,
  ): boolean => {
    const seen = new Set<GroupedSidebarPartitionTableEntry<T>>([child]);
    let current: GroupedSidebarPartitionTableEntry<T> | undefined = parent;
    while (current) {
      if (seen.has(current)) return true;
      seen.add(current);
      current = directParentByEntry.get(current);
    }
    return false;
  };

  const nestedEntries = new Set<GroupedSidebarPartitionTableEntry<T>>();
  groupedEntries.forEach((entry) => {
    const parent = directParentByEntry.get(entry);
    if (!parent || createsCycle(entry, parent)) return;
    parent.partitionTables = [...(parent.partitionTables || []), entry];
    delete parent.rowCount;
    nestedEntries.add(entry);
  });

  return groupedEntries.filter((entry) => !nestedEntries.has(entry));
};
