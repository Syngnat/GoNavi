import {
  type DriverStatusSnapshot,
  normalizeDriverType,
  resolveConnectionDriverType,
} from "../../utils/connectionDriverType";
import { GetDriverStatusList } from "../../../wailsjs/go/app/App";
import { t } from "../../i18n";
import Modal from "../common/ResizableDraggableModal";
import type { ConnectionModalStateApi } from "./useConnectionModalState";
import type { ConnectionModalProps } from "../ConnectionModal";

export interface UseConnectionModalDriverStatusInput {
  setDriverStatusMap: ConnectionModalStateApi['setDriverStatusMap'];
  setDriverStatusLoaded: ConnectionModalStateApi['setDriverStatusLoaded'];
  driverStatusMap: ConnectionModalStateApi['driverStatusMap'];
  onOpenDriverManager: ConnectionModalProps['onOpenDriverManager'];
}

export const useConnectionModalDriverStatus = ({
  setDriverStatusMap,
  setDriverStatusLoaded,
  driverStatusMap,
  onOpenDriverManager,
}: UseConnectionModalDriverStatusInput) => {
  const fetchDriverStatusMap = async (): Promise<
    Record<string, DriverStatusSnapshot>
  > => {
    const result: Record<string, DriverStatusSnapshot> = {};
    const res = await GetDriverStatusList("", "");
    if (!res?.success) {
      return result;
    }
    const data = (res?.data || {}) as any;
    const drivers = Array.isArray(data.drivers) ? data.drivers : [];
    drivers.forEach((item: any) => {
      const type = normalizeDriverType(String(item.type || "").trim());
      if (!type) return;
      result[type] = {
        type,
        name: String(item.name || item.type || type).trim(),
        connectable: !!item.connectable,
        expectedRevision: String(item.expectedRevision || "").trim() || undefined,
        needsUpdate: !!item.needsUpdate,
        updateReason: String(item.updateReason || "").trim() || undefined,
        affectedConnections: Number.isFinite(Number(item.affectedConnections))
          ? Number(item.affectedConnections)
          : undefined,
        message: String(item.message || "").trim() || undefined,
      };
    });
    return result;
  };

  const refreshDriverStatus = async () => {
    try {
      const next = await fetchDriverStatusMap();
      setDriverStatusMap(next);
    } catch {
      setDriverStatusMap({});
    } finally {
      setDriverStatusLoaded(true);
    }
  };

  const resolveDriverUnavailableReason = async (
    type: string,
    driver?: string,
  ): Promise<string> => {
    const normalized = resolveConnectionDriverType(type, driver);
    if (!normalized || normalized === "custom") {
      return "";
    }
    let snapshot = driverStatusMap;
    if (!snapshot[normalized]) {
      snapshot = await fetchDriverStatusMap();
      setDriverStatusMap(snapshot);
    }
    const status = snapshot[normalized];
    if (!status || status.connectable) {
      return "";
    }
    return (
      status.message ||
      t("connection.modal.driver.unavailableFallback", {
        name: status.name || normalized,
      })
    );
  };

  const promptInstallDriver = (driverType: string, reason: string) => {
    const normalized = normalizeDriverType(driverType);
    const snapshot = driverStatusMap[normalized];
    const driverName =
      snapshot?.name || normalized || t("connection.modal.driver.currentFallback");
    Modal.confirm({
      title: t("connection.modal.driver.unavailableTitle", {
        name: driverName,
      }),
      content:
        reason ||
        t("connection.modal.driver.unavailableFallback", {
          name: driverName,
        }),
      okText: t("connection.modal.driver.installAction"),
      cancelText: t("common.action.cancel"),
      onOk: () => {
        onOpenDriverManager?.();
      },
    });
  };
  return {
    refreshDriverStatus,
    resolveDriverUnavailableReason,
    promptInstallDriver,
  };
};

export type ConnectionModalDriverStatusApi = ReturnType<typeof useConnectionModalDriverStatus>;
