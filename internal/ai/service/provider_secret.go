package aiservice

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"unicode"

	"GoNavi-Wails/internal/ai"
	"GoNavi-Wails/internal/dailysecret"
	"GoNavi-Wails/internal/secretstore"
	"GoNavi-Wails/shared/i18n"
)

const providerSecretKind = "ai-provider"

type providerSecretBundle struct {
	APIKey           string            `json:"apiKey,omitempty"`
	SensitiveHeaders map[string]string `json:"sensitiveHeaders,omitempty"`
	CLIEnv           map[string]string `json:"cliEnv,omitempty"`
}

func (b providerSecretBundle) hasAny() bool {
	return strings.TrimSpace(b.APIKey) != "" || len(b.SensitiveHeaders) > 0 || len(b.CLIEnv) > 0
}

func mergeProviderSecretBundles(base, overlay providerSecretBundle) providerSecretBundle {
	merged := providerSecretBundle{
		APIKey:           base.APIKey,
		SensitiveHeaders: cloneStringMap(base.SensitiveHeaders),
		CLIEnv:           cloneStringMap(base.CLIEnv),
	}
	if strings.TrimSpace(overlay.APIKey) != "" {
		merged.APIKey = overlay.APIKey
	}
	for key, value := range overlay.SensitiveHeaders {
		if merged.SensitiveHeaders == nil {
			merged.SensitiveHeaders = make(map[string]string, len(overlay.SensitiveHeaders))
		}
		merged.SensitiveHeaders[key] = value
	}
	for key, value := range overlay.CLIEnv {
		if merged.CLIEnv == nil {
			merged.CLIEnv = make(map[string]string, len(overlay.CLIEnv))
		}
		merged.CLIEnv[key] = value
	}
	if len(merged.SensitiveHeaders) == 0 {
		merged.SensitiveHeaders = nil
	}
	if len(merged.CLIEnv) == 0 {
		merged.CLIEnv = nil
	}
	return merged
}

func splitProviderSecrets(cfg ai.ProviderConfig) (ai.ProviderConfig, providerSecretBundle) {
	meta := cfg
	meta.APIKey = ""
	meta.CLIEnv = nil

	bundle := providerSecretBundle{CLIEnv: cloneStringMap(cfg.CLIEnv)}
	if apiKey := strings.TrimSpace(cfg.APIKey); apiKey != "" {
		bundle.APIKey = apiKey
	}

	if len(cfg.Headers) > 0 {
		safeHeaders := make(map[string]string, len(cfg.Headers))
		sensitiveHeaders := make(map[string]string)
		for key, value := range cfg.Headers {
			if isSensitiveProviderHeader(key) {
				if strings.TrimSpace(value) != "" {
					sensitiveHeaders[key] = value
				}
				continue
			}
			safeHeaders[key] = value
		}
		if len(safeHeaders) > 0 {
			meta.Headers = safeHeaders
		} else {
			meta.Headers = nil
		}
		if len(sensitiveHeaders) > 0 {
			bundle.SensitiveHeaders = sensitiveHeaders
		}
	} else {
		meta.Headers = nil
	}

	meta.HasSecret = cfg.HasSecret || bundle.hasAny()
	meta.SecretRef = strings.TrimSpace(cfg.SecretRef)
	if !meta.HasSecret {
		meta.SecretRef = ""
	}

	return meta, bundle
}

func mergeProviderSecrets(cfg ai.ProviderConfig, bundle providerSecretBundle) ai.ProviderConfig {
	merged := cfg
	merged.APIKey = bundle.APIKey
	merged.CLIEnv = cloneStringMap(bundle.CLIEnv)

	headers := cloneStringMap(cfg.Headers)
	if len(bundle.SensitiveHeaders) > 0 {
		if headers == nil {
			headers = make(map[string]string, len(bundle.SensitiveHeaders))
		}
		for key, value := range bundle.SensitiveHeaders {
			headers[key] = value
		}
	}
	if len(headers) > 0 {
		merged.Headers = headers
	} else {
		merged.Headers = nil
	}

	merged.HasSecret = cfg.HasSecret || bundle.hasAny()
	merged.SecretRef = ""
	if !merged.HasSecret {
		merged.SecretRef = ""
	}

	return merged
}

func toDailyProviderBundle(bundle providerSecretBundle) dailysecret.ProviderBundle {
	return dailysecret.ProviderBundle{
		APIKey:           bundle.APIKey,
		SensitiveHeaders: cloneStringMap(bundle.SensitiveHeaders),
		CLIEnv:           cloneStringMap(bundle.CLIEnv),
	}
}

func fromDailyProviderBundle(bundle dailysecret.ProviderBundle) providerSecretBundle {
	return providerSecretBundle{
		APIKey:           bundle.APIKey,
		SensitiveHeaders: cloneStringMap(bundle.SensitiveHeaders),
		CLIEnv:           cloneStringMap(bundle.CLIEnv),
	}
}

func persistProviderSecretBundle(store *dailysecret.Store, meta ai.ProviderConfig, bundle providerSecretBundle) (ai.ProviderConfig, error) {
	return persistProviderSecretBundleWithLocalizer(store, meta, bundle, nil)
}

func persistProviderSecretBundleWithLocalizer(store *dailysecret.Store, meta ai.ProviderConfig, bundle providerSecretBundle, localizer *i18n.Localizer) (ai.ProviderConfig, error) {
	meta, _ = splitProviderSecrets(meta)
	if !bundle.hasAny() {
		meta.HasSecret = false
		meta.SecretRef = ""
		if store == nil {
			return meta, nil
		}
		return meta, store.DeleteAIProvider(meta.ID)
	}
	if store == nil {
		return meta, serviceErrorFromLocalizer(localizer, "ai_service.backend.error.daily_secret_store_unavailable", nil, fmt.Errorf("daily secret store unavailable"))
	}
	if err := store.PutAIProvider(meta.ID, toDailyProviderBundle(bundle)); err != nil {
		return meta, err
	}
	meta.SecretRef = ""
	meta.HasSecret = true
	return meta, nil
}

func resolveProviderConfigSecrets(store *dailysecret.Store, cfg ai.ProviderConfig) (ai.ProviderConfig, error) {
	return resolveProviderConfigSecretsWithLocalizer(store, cfg, nil)
}

func resolveProviderConfigSecretsWithLocalizer(store *dailysecret.Store, cfg ai.ProviderConfig, localizer *i18n.Localizer) (ai.ProviderConfig, error) {
	cfg = normalizeProviderConfig(cfg)
	meta, bundle := splitProviderSecrets(cfg)
	if bundle.hasAny() {
		return mergeProviderSecrets(meta, bundle), nil
	}
	if !meta.HasSecret {
		return meta, nil
	}
	if store == nil {
		return meta, serviceErrorFromLocalizer(localizer, "ai_service.backend.error.daily_secret_store_unavailable", nil, fmt.Errorf("daily secret store unavailable"))
	}
	stored, ok, err := store.GetAIProvider(meta.ID)
	if err != nil {
		return meta, err
	}
	if !ok {
		return meta, os.ErrNotExist
	}
	meta.SecretRef = ""
	return mergeProviderSecrets(meta, fromDailyProviderBundle(stored)), nil
}

func (s *Service) persistProviderSecretBundle(meta ai.ProviderConfig, bundle providerSecretBundle) (ai.ProviderConfig, error) {
	return persistProviderSecretBundleWithLocalizer(s.dailySecretStore(), meta, bundle, s.serviceLocalizerForLanguageLocked())
}

func (s *Service) resolveProviderConfigSecrets(cfg ai.ProviderConfig) (ai.ProviderConfig, error) {
	return resolveProviderConfigSecretsWithLocalizer(s.dailySecretStore(), cfg, s.serviceLocalizerForLanguage())
}

func (s *Service) resolveProviderConfigSecretsLocked(cfg ai.ProviderConfig) (ai.ProviderConfig, error) {
	return resolveProviderConfigSecretsWithLocalizer(s.dailySecretStore(), cfg, s.serviceLocalizerForLanguageLocked())
}

func resolveProviderConfigSecretsFromStore(store secretstore.SecretStore, cfg ai.ProviderConfig) (ai.ProviderConfig, error) {
	return resolveProviderConfigSecretsFromStoreWithLocalizer(store, cfg, nil)
}

func resolveProviderConfigSecretsFromStoreWithLocalizer(store secretstore.SecretStore, cfg ai.ProviderConfig, localizer *i18n.Localizer) (ai.ProviderConfig, error) {
	cfg = normalizeProviderConfig(cfg)
	meta, bundle := splitProviderSecrets(cfg)
	if bundle.hasAny() {
		return mergeProviderSecrets(meta, bundle), nil
	}
	if !meta.HasSecret {
		return meta, nil
	}
	if store == nil {
		return meta, serviceErrorFromLocalizer(localizer, "ai_service.backend.error.secret_store_unavailable", nil, fmt.Errorf("secret store unavailable"))
	}

	ref := strings.TrimSpace(meta.SecretRef)
	if ref == "" {
		var err error
		ref, err = secretstore.BuildRef(providerSecretKind, meta.ID)
		if err != nil {
			return meta, err
		}
		meta.SecretRef = ref
	}

	payload, err := store.Get(ref)
	if err != nil {
		return meta, err
	}

	var stored providerSecretBundle
	if err := json.Unmarshal(payload, &stored); err != nil {
		return meta, serviceErrorFromLocalizer(localizer, "ai_service.backend.error.provider_secret_bundle_parse_failed", nil, err)
	}
	return mergeProviderSecrets(meta, stored), nil
}

func providerMetadataView(cfg ai.ProviderConfig) ai.ProviderConfig {
	meta, _ := splitProviderSecrets(normalizeProviderConfig(cfg))
	return meta
}

func isSensitiveProviderHeader(name string) bool {
	normalized := strings.TrimSpace(strings.ToLower(name))
	switch normalized {
	case "authorization", "proxy-authorization", "x-api-key", "api-key":
		return true
	}

	for _, token := range providerHeaderTokens(normalized) {
		switch token {
		case "auth", "authorization", "token", "secret", "key", "apikey":
			return true
		}
	}

	return false
}

func providerHeaderTokens(name string) []string {
	return strings.FieldsFunc(name, func(r rune) bool {
		return !unicode.IsLetter(r) && !unicode.IsDigit(r)
	})
}

func cloneStringMap(input map[string]string) map[string]string {
	if len(input) == 0 {
		return nil
	}
	cloned := make(map[string]string, len(input))
	for key, value := range input {
		cloned[key] = value
	}
	return cloned
}
