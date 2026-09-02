import { t as translateCatalog } from '../i18n';

export interface ConnectionWorkbenchState {
  ready: boolean;
  message: string;
}

type StartupReadinessTranslator = (key: string) => string;

export function getConnectionWorkbenchState(
  isStoreHydrated: boolean,
  hasAppliedInitialGlobalProxy: boolean,
  hasLoadedConnectionSidebarLayout: boolean,
  translate: StartupReadinessTranslator = translateCatalog,
): ConnectionWorkbenchState {
  if (!isStoreHydrated) {
    return {
      ready: false,
      message: translate('app.startup_readiness.loading_local_config'),
    };
  }
  if (!hasAppliedInitialGlobalProxy) {
    return {
      ready: false,
      message: translate('app.startup_readiness.loading_security_config'),
    };
  }
  if (!hasLoadedConnectionSidebarLayout) {
    return {
      ready: false,
      message: translate('app.startup_readiness.loading_security_config'),
    };
  }
  return {
    ready: true,
    message: '',
  };
}
