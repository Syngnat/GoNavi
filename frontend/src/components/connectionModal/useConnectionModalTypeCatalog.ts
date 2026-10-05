import { isFileDatabaseType } from "../../utils/connectionTypeCapabilities";
import { resolveConnectionConfigLayout } from "../../utils/connectionModalPresentation";
import { t } from "../../i18n";
import { resolveConnectionDriverType } from "../../utils/connectionDriverType";
import {
  buildConnectionTypeGroups,
  orderConnectionTypeCatalogItems,
  getAllConnectionTypeCatalogItems,
} from "../../utils/connectionTypeCatalog";
import { getDbIcon, getDbDefaultColor } from "../DatabaseIcons";
import { useEffect, useMemo } from "react";
import type { ConnectionModalStateApi } from "./useConnectionModalState";
import type { ConnectionModalProps } from "../ConnectionModal";

export interface UseConnectionModalTypeCatalogInput {
  dbType: ConnectionModalStateApi['dbType'];
  hasUnsupportedJvmModeSelection: ConnectionModalStateApi['hasUnsupportedJvmModeSelection'];
  customDriver: ConnectionModalStateApi['customDriver'];
  driverStatusMap: ConnectionModalStateApi['driverStatusMap'];
  driverStatusLoaded: ConnectionModalStateApi['driverStatusLoaded'];
  step: ConnectionModalStateApi['step'];
  dbTypeQuery: ConnectionModalStateApi['dbTypeQuery'];
  activeGroup: ConnectionModalStateApi['activeGroup'];
  pinnedConnectionTypes: ConnectionModalStateApi['pinnedConnectionTypes'];
  setDbTypeQuery: ConnectionModalStateApi['setDbTypeQuery'];
  setActiveGroup: ConnectionModalStateApi['setActiveGroup'];
  open: ConnectionModalProps['open'];
  savedConnections: ConnectionModalStateApi['savedConnections'];
  recentConnectionTargets: ConnectionModalStateApi['recentConnectionTargets'];
}

export const useConnectionModalTypeCatalog = ({
  dbType,
  hasUnsupportedJvmModeSelection,
  customDriver,
  driverStatusMap,
  driverStatusLoaded,
  step,
  dbTypeQuery,
  activeGroup,
  pinnedConnectionTypes,
  setDbTypeQuery,
  setActiveGroup,
  open,
  savedConnections,
  recentConnectionTargets,
}: UseConnectionModalTypeCatalogInput) => {
  const isFileDb = isFileDatabaseType(dbType);
  const isCustom = dbType === "custom";
  const isRedis = dbType === "redis";
  const isJVM = dbType === "jvm";
  const connectionConfigLayout = resolveConnectionConfigLayout(dbType);
  const unsupportedJvmModeMessage =
    isJVM && hasUnsupportedJvmModeSelection
      ? t("connection.modal.jvm.unsupportedMode.banner")
      : "";
  const currentDriverType = resolveConnectionDriverType(dbType, customDriver);
  const hasCurrentDriverType =
    currentDriverType !== "" && currentDriverType !== "custom";
  const currentDriverSnapshot = driverStatusMap[currentDriverType];
  const currentDriverUnavailableReason =
    hasCurrentDriverType &&
    currentDriverSnapshot &&
    !currentDriverSnapshot.connectable
      ? currentDriverSnapshot.message ||
        t("connection.modal.driver.unavailableFallback", {
          name: currentDriverSnapshot.name || dbType,
        })
      : "";
  const currentDriverUpdateReason =
    hasCurrentDriverType &&
    currentDriverSnapshot?.connectable &&
    currentDriverSnapshot.needsUpdate
      ? currentDriverSnapshot.message ||
        currentDriverSnapshot.updateReason ||
        t("connection.modal.driver.updateFallback", {
          name: currentDriverSnapshot.name || dbType,
        })
      : "";
  const driverStatusChecking =
    hasCurrentDriverType && !driverStatusLoaded && step === 2;

  // 翻译函数读取运行时语言；系统语言变化时 preference 仍可能保持 "system"，
  // 因此这组少量目录项必须随组件重渲染重新派生，不能只按 preference 做 memo。
  const localizedDbTypeGroups = buildConnectionTypeGroups(t).map((group) => ({
    ...group,
    items: group.items.map((item) => ({
      ...item,
      icon: getDbIcon(item.key, undefined, 32),
    })),
  }));
  const seenDbTypeKeys = new Set<string>();
  const allDbTypeItems = localizedDbTypeGroups
    .flatMap((group) => group.items)
    .filter((item) => {
      if (seenDbTypeKeys.has(item.key)) {
        return false;
      }
      seenDbTypeKeys.add(item.key);
      return true;
    });
  const dbTypeGroups = [
    {
      labelKey: "connection_modal.step1.group.all",
      label: t("connection.modal.step1.group.all"),
      items: allDbTypeItems,
    },
    ...localizedDbTypeGroups,
  ];

  const normalizedDbTypeQuery = dbTypeQuery.trim().toLowerCase();
  const filteredDbTypeItems = normalizedDbTypeQuery
    ? (dbTypeGroups[0]?.items ?? []).filter(
        (item) =>
          item.name.toLowerCase().includes(normalizedDbTypeQuery) ||
          String(item.key).toLowerCase().includes(normalizedDbTypeQuery),
      )
    : (dbTypeGroups[activeGroup]?.items ?? []);
  const visibleDbTypeItems = orderConnectionTypeCatalogItems(
    filteredDbTypeItems,
    pinnedConnectionTypes,
  );
  const pinnedConnectionTypeSet = new Set(pinnedConnectionTypes);

  const handleDbTypeQueryChange = (value: string) => {
    setDbTypeQuery(value);
    if (value.trim()) {
      setActiveGroup(0);
    }
  };

  const handleDbTypeGroupSelect = (index: number) => {
    setActiveGroup(index);
    setDbTypeQuery("");
  };

  useEffect(() => {
    if (!open || step !== 1 || typeof window === "undefined") return;
    // Studio 选型页快捷键处理器，仅在第一步挂载。
    const focusStudioSearch = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "k") {
        return;
      }
      // 当前弹窗内的数据源搜索框。
      const searchInput = document.querySelector<HTMLInputElement>(
        '.connection-modal-wrap [data-connection-type-search="true"]',
      );
      if (!searchInput) return;
      event.preventDefault();
      searchInput.focus();
    };
    window.addEventListener("keydown", focusStudioSearch);
    return () => window.removeEventListener("keydown", focusStudioSearch);
  }, [open, step]);

  const dbTypes = getAllConnectionTypeCatalogItems();

  const recentConnectionChips = useMemo(() => {
    // 按“最近实际使用”的连接（recentConnectionTargets，已按 openedAt 倒序）
    // 去重取数据源类型，而不是按连接创建/添加顺序。
    const connectionById = new Map(
      savedConnections.map((conn) => [conn.id, conn] as const),
    );
    const seenTypes = new Set<string>();
    const chips: Array<{ type: string; color: string }> = [];
    for (const target of recentConnectionTargets) {
      const conn = connectionById.get(target.connectionId);
      const type = String(conn?.config?.type || "").trim();
      if (!conn || !type || seenTypes.has(type)) continue;
      seenTypes.add(type);
      chips.push({
        type,
        color: conn.iconColor || getDbDefaultColor(conn.iconType || type),
      });
      if (chips.length >= 5) break;
    }
    return chips;
  }, [savedConnections, recentConnectionTargets]);

  const activeGroupLabel =
    dbTypeGroups[activeGroup]?.label || t("connection.modal.step1.group.all");
  return {
    isFileDb,
    isCustom,
    isRedis,
    isJVM,
    connectionConfigLayout,
    unsupportedJvmModeMessage,
    currentDriverSnapshot,
    currentDriverUnavailableReason,
    currentDriverUpdateReason,
    driverStatusChecking,
    localizedDbTypeGroups,
    dbTypeGroups,
    normalizedDbTypeQuery,
    visibleDbTypeItems,
    pinnedConnectionTypeSet,
    handleDbTypeQueryChange,
    handleDbTypeGroupSelect,
    dbTypes,
    recentConnectionChips,
    activeGroupLabel,
  };
};

export type ConnectionModalTypeCatalogApi = ReturnType<typeof useConnectionModalTypeCatalog>;
