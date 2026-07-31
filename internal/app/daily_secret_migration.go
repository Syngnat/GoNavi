package app

import (
	"os"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"
	"GoNavi-Wails/internal/secretstore"
)

func migrateDailySecretsIfNeeded(a *App) error {
	return migrateDailySecretsIfNeededWithHome(a, os.UserHomeDir)
}

func migrateDarwinDailySecretsIfNeeded(a *App) error {
	return migrateDailySecretsIfNeeded(a)
}

func migrateDailySecretsIfNeededWithHome(a *App, resolveHomeDir func() (string, error)) error {
	if a == nil {
		return nil
	}

	var legacy legacyWebKitVisibleConfig
	if resolveHomeDir != nil {
		homeDir, err := resolveHomeDir()
		if err != nil {
			return err
		}
		legacyConfig, _, err := findLegacyWebKitVisibleConfig(homeDir)
		if err != nil {
			return err
		}
		legacy = legacyConfig
	}

	repo := a.savedConnectionRepository()
	if err := migrateSavedConnectionSecrets(repo, legacy); err != nil {
		return err
	}
	return migrateGlobalProxySecret(a, legacy)
}

func migrateDarwinDailySecretsIfNeededWithHome(a *App, resolveHomeDir func() (string, error)) error {
	return migrateDailySecretsIfNeededWithHome(a, resolveHomeDir)
}

func migrateSavedConnectionSecrets(repo *savedConnectionRepository, legacy legacyWebKitVisibleConfig) error {
	if repo == nil {
		return nil
	}

	// 与 Save/Delete/Duplicate 共用同一把包级锁：本函数直接走 load/saveAll 的读改写序列，
	// 不经过 Save，因此不会重入。
	savedConnectionsMu.Lock()
	defer savedConnectionsMu.Unlock()

	items, err := repo.load()
	if err != nil {
		return err
	}

	changed := false
	for index, item := range items {
		bundle, found, err := repo.resolveMigrationConnectionBundle(item, legacy)
		if err != nil {
			return err
		}
		if found && bundle.hasAny() {
			if err := repo.saveSecretBundle(item.ID, bundle); err != nil {
				return err
			}
			normalized := item
			normalized.Config = stripConnectionSecretFields(normalized.Config)
			normalized.SecretRef = ""
			applyConnectionBundleFlags(&normalized, bundle)
			items[index] = normalized
			changed = true
			continue
		}

		inline := extractConnectionSecretBundle(item.Config)
		if !inline.hasAny() && !savedConnectionViewHasSecrets(item) && strings.TrimSpace(item.SecretRef) == "" {
			continue
		}
		if err := repo.deleteSecretBundle(item.ID); err != nil {
			return err
		}
		item.Config = stripConnectionSecretFields(item.Config)
		item.SecretRef = ""
		applyConnectionBundleFlags(&item, connectionSecretBundle{})
		items[index] = item
		changed = true
		logger.Warnf("日常连接密文未回填：连接=%s，已停用旧系统密文引用，请重新保存连接密码", strings.TrimSpace(item.ID))
	}

	if changed {
		return repo.saveAll(items)
	}
	return nil
}

func (r *savedConnectionRepository) resolveMigrationConnectionBundle(view connection.SavedConnectionView, legacy legacyWebKitVisibleConfig) (connectionSecretBundle, bool, error) {
	inline := extractConnectionSecretBundle(view.Config)
	if inline.hasAny() {
		return inline, true, nil
	}

	stored, ok, err := r.dailySecrets().GetConnection(view.ID)
	if err != nil {
		return connectionSecretBundle{}, false, err
	}
	if ok {
		return fromDailyConnectionBundle(stored), true, nil
	}

	legacyBundle := findLegacyConnectionSecretBundle(legacy.Connections, view.ID)
	if legacyBundle.hasAny() {
		return legacyBundle, true, nil
	}

	if !shouldReadLegacySecretStoreForDailySecrets() {
		return connectionSecretBundle{}, false, nil
	}

	if strings.TrimSpace(view.SecretRef) == "" {
		return connectionSecretBundle{}, false, nil
	}
	bundle, err := r.loadSecretBundleFromStore(view)
	if err == nil {
		return bundle, true, nil
	}
	if os.IsNotExist(err) || secretstore.IsUnavailable(err) {
		return connectionSecretBundle{}, false, nil
	}
	return connectionSecretBundle{}, false, err
}

func migrateGlobalProxySecret(a *App, legacy legacyWebKitVisibleConfig) error {
	view, err := a.loadStoredGlobalProxyView()
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}

	bundle, found, err := a.resolveMigrationGlobalProxyBundle(view, legacy)
	if err != nil {
		return err
	}
	if found && strings.TrimSpace(bundle.Password) != "" {
		if err := a.dailySecretStore().PutGlobalProxy(toDailyGlobalProxyBundle(bundle)); err != nil {
			return err
		}
		normalized := view
		normalized.Password = ""
		normalized.SecretRef = ""
		normalized.HasPassword = true
		if normalized != view {
			return a.persistGlobalProxyView(normalized)
		}
		return nil
	}

	inline := extractGlobalProxySecretBundle(view)
	if !view.HasPassword && strings.TrimSpace(view.SecretRef) == "" && strings.TrimSpace(inline.Password) == "" {
		return nil
	}
	if err := a.dailySecretStore().DeleteGlobalProxy(); err != nil {
		return err
	}
	view.Password = ""
	view.SecretRef = ""
	view.HasPassword = false
	logger.Warnf("日常全局代理密文未回填，已停用旧系统密文引用，如需继续使用请重新保存代理密码")
	return a.persistGlobalProxyView(view)
}

func (a *App) resolveMigrationGlobalProxyBundle(view connection.GlobalProxyView, legacy legacyWebKitVisibleConfig) (globalProxySecretBundle, bool, error) {
	inline := extractGlobalProxySecretBundle(view)
	if strings.TrimSpace(inline.Password) != "" {
		return inline, true, nil
	}

	stored, ok, err := a.dailySecretStore().GetGlobalProxy()
	if err != nil {
		return globalProxySecretBundle{}, false, err
	}
	if ok {
		return fromDailyGlobalProxyBundle(stored), true, nil
	}

	if legacy.GlobalProxy != nil && strings.TrimSpace(legacy.GlobalProxy.Password) != "" {
		return globalProxySecretBundle{Password: legacy.GlobalProxy.Password}, true, nil
	}

	if !shouldReadLegacySecretStoreForDailySecrets() {
		return globalProxySecretBundle{}, false, nil
	}

	if strings.TrimSpace(view.SecretRef) == "" {
		return globalProxySecretBundle{}, false, nil
	}
	bundle, err := a.loadGlobalProxySecretBundleFromStore(view)
	if err == nil {
		return bundle, true, nil
	}
	if os.IsNotExist(err) || secretstore.IsUnavailable(err) {
		return globalProxySecretBundle{}, false, nil
	}
	return globalProxySecretBundle{}, false, err
}

func findLegacyConnectionSecretBundle(items []connection.LegacySavedConnection, id string) connectionSecretBundle {
	targetID := strings.TrimSpace(id)
	if targetID == "" {
		return connectionSecretBundle{}
	}
	for _, item := range items {
		if strings.TrimSpace(item.ID) != targetID {
			continue
		}
		return extractConnectionSecretBundle(item.Config)
	}
	return connectionSecretBundle{}
}
