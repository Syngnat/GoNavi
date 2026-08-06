export type DriverStatusSnapshot<TRow> = {
  rows: TRow[];
  downloadDir: string;
  cachedAt: number;
  intentSequence: number;
};

export type DriverNetworkSnapshot<TStatus> = {
  status: TStatus;
  cachedAt: number;
};

const DEFAULT_DRIVER_STATUS_REQUEST_KEY = '<default>';

export const normalizeDriverStatusRequestKey = (downloadDir: string): string => (
  String(downloadDir || '').trim() || DEFAULT_DRIVER_STATUS_REQUEST_KEY
);

export const createDriverStatusSnapshotRegistry = <TRow>() => {
  const snapshots = new Map<string, DriverStatusSnapshot<TRow>>();
  const latestIntentByKey = new Map<string, number>();
  let preferredRequestKey = DEFAULT_DRIVER_STATUS_REQUEST_KEY;

  return {
    beginRequest(downloadDir: string, intentSequence: number): string {
      const requestKey = normalizeDriverStatusRequestKey(downloadDir);
      preferredRequestKey = requestKey;
      latestIntentByKey.set(requestKey, intentSequence);
      return requestKey;
    },

    getPreferred(): DriverStatusSnapshot<TRow> | null {
      return snapshots.get(preferredRequestKey) || null;
    },

    write(requestKey: string, snapshot: DriverStatusSnapshot<TRow>): boolean {
      const normalizedRequestKey = normalizeDriverStatusRequestKey(requestKey);
      const latestIntentForKey = latestIntentByKey.get(normalizedRequestKey) || 0;
      const cachedSnapshot = snapshots.get(normalizedRequestKey);
      if (
        snapshot.intentSequence < latestIntentForKey
        || snapshot.intentSequence < (cachedSnapshot?.intentSequence || 0)
      ) {
        return false;
      }
      snapshots.set(normalizedRequestKey, snapshot);
      return true;
    },
  };
};

export const settleLatestDriverRequest = (
  requestGeneration: number,
  latestRequestGeneration: number,
  setLoading: (loading: boolean) => void,
): boolean => {
  if (requestGeneration !== latestRequestGeneration) {
    return false;
  }
  setLoading(false);
  return true;
};

export const restoreDriverStatusSnapshot = <TRow>(
  snapshot: DriverStatusSnapshot<TRow> | null,
  callbacks: {
    setRows: (rows: TRow[]) => void;
    setLoading: (loading: boolean) => void;
    setDownloadDir: (downloadDir: string) => void;
  },
): boolean => {
  if (!snapshot) {
    return false;
  }
  callbacks.setRows(snapshot.rows);
  callbacks.setLoading(false);
  if (snapshot.downloadDir) {
    callbacks.setDownloadDir(snapshot.downloadDir);
  }
  return true;
};

export const restoreDriverNetworkSnapshot = <TStatus>(
  snapshot: DriverNetworkSnapshot<TStatus> | null,
  callbacks: {
    setStatus: (status: TStatus) => void;
    setLoading: (loading: boolean) => void;
  },
): boolean => {
  if (!snapshot) {
    return false;
  }
  callbacks.setStatus(snapshot.status);
  callbacks.setLoading(false);
  return true;
};
