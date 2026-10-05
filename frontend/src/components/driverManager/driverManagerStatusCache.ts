import { t } from '../../i18n';
import {
  createDriverStatusSnapshotRegistry,
  normalizeDriverStatusRequestKey,
} from '../../utils/driverManagerRequestState';
import { GetDriverStatusList, CheckDriverNetworkStatus } from '../../../wailsjs/go/app/App';
import {
  type DriverStatusRow,
  type DriverNetworkStatus,
  type DriverVersionOption,
  buildVersionOptionKey,
} from './driverManagerModel';

export const driverStatusSnapshots = createDriverStatusSnapshotRegistry<DriverStatusRow>();
export let driverNetworkSnapshotCache: { status: DriverNetworkStatus; cachedAt: number } | null = null;
export let driverStatusSnapshotIntentSequence = 0;

// ES module bindings are read-only for importers, so writes go through setters.
export const setDriverNetworkSnapshotCache = (value: typeof driverNetworkSnapshotCache) => {
  driverNetworkSnapshotCache = value;
};
export const setDriverStatusSnapshotIntentSequence = (value: number) => {
  driverStatusSnapshotIntentSequence = value;
};
type DriverStatusBackendResult = Awaited<ReturnType<typeof GetDriverStatusList>>;
type DriverNetworkBackendResult = Awaited<ReturnType<typeof CheckDriverNetworkStatus>>;
const driverStatusInFlightRequests = new Map<string, Promise<DriverStatusBackendResult>>();
let driverNetworkInFlightRequest: Promise<DriverNetworkBackendResult> | null = null;

export const requestDriverStatusShared = (
  downloadDir: string,
  options?: { fresh?: boolean },
): Promise<DriverStatusBackendResult> => {
  const requestKey = normalizeDriverStatusRequestKey(downloadDir);
  const pendingRequest = driverStatusInFlightRequests.get(requestKey);
  // fresh 用于「刚改完必须看到新状态」的场景：复用安装前发出的在途请求会把旧
  // 快照当成新结果写进 rows（代际守卫只看调用方新旧，不看数据新旧）。
  if (pendingRequest && !options?.fresh) {
    return pendingRequest;
  }
  const request = Promise.resolve()
    .then(() => GetDriverStatusList(downloadDir, ''))
    .finally(() => {
      if (driverStatusInFlightRequests.get(requestKey) === request) {
        driverStatusInFlightRequests.delete(requestKey);
      }
    });
  driverStatusInFlightRequests.set(requestKey, request);
  return request;
};

export const requestDriverNetworkStatusShared = (): Promise<DriverNetworkBackendResult> => {
  if (driverNetworkInFlightRequest) {
    return driverNetworkInFlightRequest;
  }
  const request = Promise.resolve()
    .then(() => CheckDriverNetworkStatus())
    .finally(() => {
      if (driverNetworkInFlightRequest === request) {
        driverNetworkInFlightRequest = null;
      }
    });
  driverNetworkInFlightRequest = request;
  return request;
};

export const isFreshCache = (cachedAt: number, ttlMs: number): boolean => Date.now() - cachedAt <= ttlMs;

export const buildVersionSelectOptions = (options: DriverVersionOption[]) => {
  type SelectOption = { value: string; label: string };
  type SelectGroup = { label: string; options: SelectOption[] };

  if (options.length === 0) {
    return [] as Array<SelectOption | SelectGroup>;
  }

  const yearGroups = new Map<string, SelectOption[]>();
  const others: SelectOption[] = [];
  options.forEach((option) => {
    const selectOption: SelectOption = {
      value: buildVersionOptionKey(option),
      label: option.displayLabel || option.version || t('driver.modal.version.default'),
    };
    const year = String(option.year || '').trim();
    if (!year) {
      others.push(selectOption);
      return;
    }
    const group = yearGroups.get(year) || [];
    group.push(selectOption);
    yearGroups.set(year, group);
  });

  const sortedYears = Array.from(yearGroups.keys()).sort((a, b) => {
    const left = Number.parseInt(a, 10);
    const right = Number.parseInt(b, 10);
    const leftValid = Number.isFinite(left);
    const rightValid = Number.isFinite(right);
    if (leftValid && rightValid) {
      return right - left;
    }
    return b.localeCompare(a);
  });

  const grouped: SelectGroup[] = sortedYears.map((year) => ({
    label: t('driver.modal.version.group.year', { year }),
    options: yearGroups.get(year) || [],
  }));
  if (others.length > 0) {
    // 只有「其他」一组时直接平铺，避免出现不可选的分组标题
    if (grouped.length === 0) {
      return others;
    }
    grouped.push({ label: t('driver.modal.version.group.other'), options: others });
  }
  return grouped;
};
