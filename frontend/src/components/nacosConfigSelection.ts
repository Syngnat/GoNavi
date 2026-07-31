export type NacosConfigIdentity = {
  dataId: string;
  group: string;
};

export type NacosImportIdentityInput =
  | (Partial<NacosConfigIdentity> & { index?: number })
  | null
  | undefined;

export type NacosImportSelectionItem = NacosConfigIdentity & {
  index: number;
};

export type NacosImportSelectionRow = NacosImportSelectionItem &
  Record<string, unknown> & {
    selectionKey: string;
  };

export type NacosDeleteResponse = {
  success: boolean;
  message?: string;
};

export type NacosDeleteFailure<T extends NacosConfigIdentity> = {
  item: T;
  message: string;
};

export const nacosConfigSelectionKey = (item: NacosConfigIdentity): string =>
  JSON.stringify([String(item.group || 'DEFAULT_GROUP'), String(item.dataId || '')]);

const normalizeNacosImportIdentity = (
  item: NacosImportIdentityInput,
): NacosConfigIdentity => ({
  group: String(item?.group ?? ''),
  dataId: String(item?.dataId ?? ''),
});

export const nacosImportSelectionKey = (
  item: NacosImportIdentityInput,
  index: number,
): string => {
  const identity = normalizeNacosImportIdentity(item);
  return JSON.stringify([index, identity.group, identity.dataId]);
};

export const buildNacosImportSelectionRows = (
  rows: NacosImportIdentityInput[],
): NacosImportSelectionRow[] =>
  rows.map((row, index) => {
    const identity = normalizeNacosImportIdentity(row);
    const sourceIndex = Number(row?.index);
    const previewIndex = Number.isInteger(sourceIndex) && sourceIndex >= 0
      ? sourceIndex
      : index;
    return {
      ...(row || {}),
      ...identity,
      index: previewIndex,
      selectionKey: nacosImportSelectionKey(identity, previewIndex),
    };
  });

export const selectedNacosImportItems = (
  rows: NacosImportIdentityInput[],
  keys: Array<string | number | bigint>,
): NacosImportSelectionItem[] => {
  const selectedKeys = new Set(keys.map((key) => String(key)));
  return buildNacosImportSelectionRows(rows).flatMap((row) => {
    if (!selectedKeys.has(row.selectionKey)) {
      return [];
    }
    return [{
      group: row.group,
      dataId: row.dataId,
      index: row.index,
    }];
  });
};

export const selectedNacosConfigItems = <T extends NacosConfigIdentity>(
  rows: T[],
  keys: Array<string | number | bigint>,
): T[] => {
  const selectedKeys = new Set(keys.map((key) => String(key)));
  return rows.filter((row) => selectedKeys.has(nacosConfigSelectionKey(row)));
};

export const reconcileNacosConfigSelection = <T extends NacosConfigIdentity>(
  rows: T[],
  keys: Array<string | number | bigint>,
): string[] => {
  const visibleKeys = new Set(rows.map(nacosConfigSelectionKey));
  return keys.map((key) => String(key)).filter((key) => visibleKeys.has(key));
};

export const deleteSelectedNacosConfigs = async <T extends NacosConfigIdentity>(
  items: T[],
  deleteOne: (item: T) => Promise<NacosDeleteResponse>,
): Promise<{ deleted: T[]; failed: Array<NacosDeleteFailure<T>> }> => {
  const deleted: T[] = [];
  const failed: Array<NacosDeleteFailure<T>> = [];

  // Keep deletion sequential so a page-sized selection cannot burst the Nacos API.
  for (const item of items) {
    try {
      const result = await deleteOne(item);
      if (result.success) {
        deleted.push(item);
      } else {
        failed.push({ item, message: String(result.message || 'delete failed') });
      }
    } catch (error: any) {
      failed.push({ item, message: error?.message || String(error) });
    }
  }

  return { deleted, failed };
};
