import type {
  ConnectionSidebarLayout,
  ConnectionSidebarLayoutInput,
  SaveConnectionSidebarLayoutInput,
  SaveConnectionSidebarLayoutResult,
} from '../types';

export interface ConnectionSidebarLayoutBackend {
  BootstrapConnectionSidebarLayout?: (
    input: ConnectionSidebarLayoutInput,
  ) => Promise<ConnectionSidebarLayout>;
  LoadConnectionSidebarLayout?: () => Promise<ConnectionSidebarLayout>;
  SaveConnectionSidebarLayout?: (
    input: SaveConnectionSidebarLayoutInput,
  ) => Promise<SaveConnectionSidebarLayoutResult>;
}

export interface ConnectionSidebarLayoutStore {
  getLayout: () => ConnectionSidebarLayoutInput;
  replaceLayout: (layout: ConnectionSidebarLayoutInput) => void;
  subscribe: (listener: () => void) => () => void;
}

export interface ConnectionSidebarLayoutBootstrapResult {
  available: boolean;
  initialized: boolean;
  revision: number;
}

export interface ConnectionSidebarLayoutCoordinator {
  bootstrap: () => Promise<ConnectionSidebarLayoutBootstrapResult>;
  refresh: () => Promise<void>;
  flush: () => Promise<void>;
  acceptRemoteLayout: () => void;
  retryPendingSave: () => Promise<void>;
  dispose: () => void;
}

export type ConnectionSidebarLayoutSaveState =
  | { status: 'saving' }
  | { status: 'saved'; revision: number }
  | { status: 'error'; error: unknown }
  | {
    status: 'conflict';
    localLayout: ConnectionSidebarLayoutInput;
    remoteLayout: ConnectionSidebarLayout;
  };

interface CreateConnectionSidebarLayoutCoordinatorArgs {
  backend?: ConnectionSidebarLayoutBackend;
  store: ConnectionSidebarLayoutStore;
  debounceMs?: number;
  refreshIntervalMs?: number;
  onError?: (error: unknown) => void;
  onSaveStateChange?: (state: ConnectionSidebarLayoutSaveState) => void;
}

const cloneLayout = (
  layout: ConnectionSidebarLayoutInput,
): ConnectionSidebarLayoutInput => ({
  connectionTags: layout.connectionTags.map((tag) => ({
    ...tag,
    connectionIds: [...tag.connectionIds],
    childOrder: tag.childOrder ? [...tag.childOrder] : undefined,
  })),
  sidebarRootOrder: [...layout.sidebarRootOrder],
  rootSortMode: layout.rootSortMode,
  rootConnectionSortMode: layout.rootConnectionSortMode,
});

const layoutFingerprint = (layout: ConnectionSidebarLayoutInput): string =>
  JSON.stringify(layout);

export const createConnectionSidebarLayoutCoordinator = (
  args: CreateConnectionSidebarLayoutCoordinatorArgs,
): ConnectionSidebarLayoutCoordinator => {
  let disposed = false;
  let bootstrapPromise: Promise<ConnectionSidebarLayoutBootstrapResult> | null = null;
  let bootstrapSettled = false;
  let bootstrapSucceeded = false;
  let revision = 0;
  let unsubscribe: (() => void) | null = null;
  let pendingLayout: ConnectionSidebarLayoutInput | null = null;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;
  let inFlightSave: Promise<void> | null = null;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  let refreshInFlight: Promise<void> | null = null;
  let unresolvedConflict: {
    localLayout: ConnectionSidebarLayoutInput;
    remoteLayout: ConnectionSidebarLayout;
  } | null = null;
  let lastObservedFingerprint = '';
  let applyingRemoteLayout = false;
  const debounceMs = args.debounceMs ?? 160;
  const refreshIntervalMs = Math.max(0, args.refreshIntervalMs ?? 0);

  const clearPendingTimer = () => {
    if (pendingTimer !== null) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
  };

  const clearRefreshTimer = () => {
    if (refreshTimer !== null) {
      clearTimeout(refreshTimer);
      refreshTimer = null;
    }
  };

  const applyRemoteLayout = (
    layout: ConnectionSidebarLayout,
    options: { allowBusy?: boolean } = {},
  ): void => {
    if (
      disposed
      || !layout.initialized
      || (!options.allowBusy && (pendingLayout || inFlightSave))
      || layout.revision < revision
    ) {
      return;
    }
    const authoritativeLayout = cloneLayout(layout);
    const authoritativeFingerprint = layoutFingerprint(authoritativeLayout);
    const currentFingerprint = layoutFingerprint(args.store.getLayout());
    revision = layout.revision;
    lastObservedFingerprint = authoritativeFingerprint;
    if (authoritativeFingerprint === currentFingerprint) {
      return;
    }
    applyingRemoteLayout = true;
    try {
      args.store.replaceLayout(authoritativeLayout);
    } finally {
      applyingRemoteLayout = false;
    }
  };

  const savePendingLayout = async (): Promise<void> => {
    clearPendingTimer();
    if (inFlightSave) {
      return inFlightSave;
    }
    if (unresolvedConflict) {
      return;
    }
    const saveLayout = args.backend?.SaveConnectionSidebarLayout;
    const layout = pendingLayout;
    pendingLayout = null;
    if (
      disposed
      || typeof saveLayout !== 'function'
      || !layout
    ) {
      return;
    }
    let saveFailed = false;
    let saveConflicted = false;
    inFlightSave = (async () => {
      try {
        args.onSaveStateChange?.({ status: 'saving' });
        const result = await saveLayout({
          expectedRevision: revision,
          layout: cloneLayout(layout),
        });
        revision = result.layout.revision;
        if (result.conflict && !disposed) {
          saveConflicted = true;
          const localLayout = cloneLayout(args.store.getLayout());
          pendingLayout = localLayout;
          clearPendingTimer();
          unresolvedConflict = {
            localLayout,
            remoteLayout: result.layout,
          };
          args.onSaveStateChange?.({
            status: 'conflict',
            localLayout: cloneLayout(localLayout),
            remoteLayout: {
              ...cloneLayout(result.layout),
              initialized: result.layout.initialized,
              revision: result.layout.revision,
            },
          });
          return;
        }
        if (!disposed && !pendingLayout) {
          args.onSaveStateChange?.({
            status: 'saved',
            revision: result.layout.revision,
          });
        }
      } catch (error) {
        saveFailed = true;
        pendingLayout = cloneLayout(args.store.getLayout());
        if (!disposed) {
          args.onSaveStateChange?.({ status: 'error', error });
        }
        args.onError?.(error);
        throw error;
      }
    })().finally(() => {
      inFlightSave = null;
      if (
        !disposed
        && !saveFailed
        && !saveConflicted
        && !unresolvedConflict
        && pendingLayout
      ) {
        void savePendingLayout().catch(() => undefined);
      }
    });
    return inFlightSave;
  };

  const flush = async (): Promise<void> => {
    clearPendingTimer();
    while (inFlightSave || pendingLayout) {
      if (inFlightSave) {
        await inFlightSave;
      } else if (unresolvedConflict) {
        throw new Error('Connection sidebar layout has an unresolved revision conflict');
      } else {
        await savePendingLayout();
      }
    }
  };

  const acceptRemoteLayout = (): void => {
    if (disposed || !unresolvedConflict) return;
    const { remoteLayout } = unresolvedConflict;
    unresolvedConflict = null;
    pendingLayout = null;
    clearPendingTimer();
    applyRemoteLayout(remoteLayout, { allowBusy: true });
  };

  const retryPendingSave = async (): Promise<void> => {
    if (disposed) return;
    if (unresolvedConflict) {
      pendingLayout = cloneLayout(args.store.getLayout());
      unresolvedConflict = null;
    }
    await flush();
  };

  const startSubscription = () => {
    if (unsubscribe || typeof args.backend?.SaveConnectionSidebarLayout !== 'function') {
      return;
    }
    lastObservedFingerprint = layoutFingerprint(args.store.getLayout());
    unsubscribe = args.store.subscribe(() => {
      if (disposed || applyingRemoteLayout) return;
      const layout = cloneLayout(args.store.getLayout());
      const fingerprint = layoutFingerprint(layout);
      if (fingerprint === lastObservedFingerprint) return;
      lastObservedFingerprint = fingerprint;
      pendingLayout = layout;
      clearPendingTimer();
      pendingTimer = setTimeout(() => {
        pendingTimer = null;
        void savePendingLayout().catch(() => undefined);
      }, debounceMs);
    });
  };

  const refresh = (): Promise<void> => {
    if (!bootstrapSettled) {
      if (!bootstrapPromise) return Promise.resolve();
      return bootstrapPromise.then(() => refresh());
    }
    if (refreshInFlight) return refreshInFlight;
    const loadLayout = args.backend?.LoadConnectionSidebarLayout;
    const bootstrapLayout = args.backend?.BootstrapConnectionSidebarLayout;
    if (
      disposed
      || (typeof loadLayout !== 'function' && typeof bootstrapLayout !== 'function')
    ) {
      return Promise.resolve();
    }
    refreshInFlight = (async () => {
      try {
        let layout: ConnectionSidebarLayout;
        if (!bootstrapSucceeded && typeof bootstrapLayout === 'function') {
          layout = await bootstrapLayout(cloneLayout(args.store.getLayout()));
          bootstrapSucceeded = true;
        } else if (typeof loadLayout === 'function') {
          layout = await loadLayout();
        } else {
          layout = await bootstrapLayout!({
            connectionTags: [],
            sidebarRootOrder: [],
          });
        }
        if (disposed) return;
        applyRemoteLayout(layout);
        startSubscription();
      } catch (error) {
        args.onError?.(error);
        throw error;
      }
    })().finally(() => {
      refreshInFlight = null;
    });
    return refreshInFlight;
  };

  const scheduleRefresh = () => {
    if (
      disposed
      || refreshIntervalMs <= 0
      || refreshTimer !== null
      || (
        typeof args.backend?.LoadConnectionSidebarLayout !== 'function'
        && typeof args.backend?.BootstrapConnectionSidebarLayout !== 'function'
      )
    ) {
      return;
    }
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      void refresh()
        .catch(() => undefined)
        .finally(scheduleRefresh);
    }, refreshIntervalMs);
  };

  const bootstrap = (): Promise<ConnectionSidebarLayoutBootstrapResult> => {
    if (bootstrapPromise) return bootstrapPromise;
    bootstrapPromise = (async () => {
      const bootstrapLayout = args.backend?.BootstrapConnectionSidebarLayout;
      if (typeof bootstrapLayout !== 'function') {
        scheduleRefresh();
        return { available: false, initialized: false, revision: 0 };
      }
      let layout: ConnectionSidebarLayout;
      try {
        layout = await bootstrapLayout(cloneLayout(args.store.getLayout()));
        bootstrapSucceeded = true;
      } catch (error) {
        args.onError?.(error);
        scheduleRefresh();
        return { available: false, initialized: false, revision: 0 };
      }
      if (!disposed && layout.initialized) {
        applyRemoteLayout(layout);
      }
      revision = layout.revision;
      if (!disposed) {
        startSubscription();
        scheduleRefresh();
      }
      return {
        available: true,
        initialized: layout.initialized,
        revision: layout.revision,
      };
    })().finally(() => {
      bootstrapSettled = true;
    });
    return bootstrapPromise;
  };

  return {
    bootstrap,
    refresh,
    flush,
    acceptRemoteLayout,
    retryPendingSave,
    dispose: () => {
      disposed = true;
      clearPendingTimer();
      clearRefreshTimer();
      unsubscribe?.();
      unsubscribe = null;
    },
  };
};
