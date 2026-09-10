package aiservice

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"

	"GoNavi-Wails/internal/ai"
	"GoNavi-Wails/internal/dailysecret"
	"GoNavi-Wails/internal/secretstore"
	"GoNavi-Wails/shared/i18n"
)

const (
	aiConfigSchemaVersion = 6
	aiConfigFileName      = "ai_config.json"
)

type aiConfig struct {
	SchemaVersion      int                      `json:"schemaVersion,omitempty"`
	Providers          []ai.ProviderConfig      `json:"providers"`
	ActiveProvider     string                   `json:"activeProvider"`
	SafetyLevel        string                   `json:"safetyLevel"`
	ContextLevel       string                   `json:"contextLevel"`
	UserPromptSettings ai.UserPromptSettings    `json:"userPromptSettings,omitempty"`
	MCPServers         []ai.MCPServerConfig     `json:"mcpServers,omitempty"`
	MCPHTTPServer      ai.MCPHTTPServerConfig   `json:"mcpHTTPServer"`
	Skills             []ai.SkillConfig         `json:"skills,omitempty"`
	ResultMasking      ai.ResultMaskingSettings `json:"resultMasking,omitempty"`
}

type ProviderConfigStoreSnapshot struct {
	Providers          []ai.ProviderConfig
	ActiveProvider     string
	SafetyLevel        ai.SQLPermissionLevel
	ContextLevel       ai.ContextLevel
	UserPromptSettings ai.UserPromptSettings
	MCPServers         []ai.MCPServerConfig
	MCPHTTPServer      ai.MCPHTTPServerConfig
	Skills             []ai.SkillConfig
	ResultMasking      ai.ResultMaskingSettings
}

type ProviderConfigStoreInspection struct {
	Snapshot                  ProviderConfigStoreSnapshot
	ProvidersNeedingMigration []string
}

type ProviderConfigStore struct {
	configDir    string
	secretStore  secretstore.SecretStore
	dailySecrets *dailysecret.Store
	localizer    *i18n.Localizer
}

func NewProviderConfigStore(configDir string, store secretstore.SecretStore) *ProviderConfigStore {
	return NewProviderConfigStoreWithLanguage(configDir, store, i18n.LanguageEnUS)
}

func NewProviderConfigStoreWithLanguage(configDir string, store secretstore.SecretStore, language i18n.Language) *ProviderConfigStore {
	if strings.TrimSpace(configDir) == "" {
		configDir = resolveConfigDir()
	}
	if store == nil {
		store = secretstore.NewUnavailableStore("secret store unavailable")
	}
	return &ProviderConfigStore{
		configDir:    configDir,
		secretStore:  store,
		dailySecrets: dailysecret.NewStore(configDir),
		localizer:    newServiceLocalizerForLanguage(language),
	}
}

func newProviderConfigStore(configDir string, store secretstore.SecretStore) *ProviderConfigStore {
	return NewProviderConfigStore(configDir, store)
}

func (s *ProviderConfigStore) configPath() string {
	return filepath.Join(s.configDir, aiConfigFileName)
}

func (s *ProviderConfigStore) storeError(key string, params map[string]any, cause error) error {
	return serviceErrorFromLocalizer(s.localizer, key, params, cause)
}

func (s *ProviderConfigStore) Load() (ProviderConfigStoreSnapshot, error) {
	cfg, snapshot, err := s.readStoredSnapshot()
	if err != nil {
		return snapshot, err
	}

	shouldRewrite := cfg.SchemaVersion != aiConfigSchemaVersion
	for _, providerConfig := range cfg.Providers {
		if providerHasRemovedEditorFields(providerConfig) {
			shouldRewrite = true
			break
		}
	}
	providers := make([]ai.ProviderConfig, 0, len(snapshot.Providers))
	for _, providerConfig := range snapshot.Providers {
		runtimeConfig, rewritten, loadErr := s.loadStoredProviderConfig(providerConfig)
		if loadErr != nil {
			return snapshot, s.storeError("ai_service.backend.error.provider_secret_load_failed", map[string]any{
				"provider": providerConfig.ID,
			}, loadErr)
		}
		if rewritten {
			shouldRewrite = true
		}
		providers = append(providers, runtimeConfig)
	}
	if providers == nil {
		providers = []ai.ProviderConfig{}
	}
	snapshot.Providers = providers

	mcpHTTPServer, err := s.loadMCPHTTPServerConfig(snapshot.MCPHTTPServer)
	if err != nil {
		return snapshot, s.storeError("ai_service.backend.error.config_read_failed", nil, err)
	}
	snapshot.MCPHTTPServer = mcpHTTPServer

	if shouldRewrite {
		if err := s.Save(snapshot); err != nil {
			return snapshot, s.storeError("ai_service.backend.error.config_rewrite_failed", nil, err)
		}
	}

	return snapshot, nil
}

func (s *ProviderConfigStore) LoadRuntime() (ProviderConfigStoreSnapshot, error) {
	return s.Load()
}

func (s *ProviderConfigStore) Inspect() (ProviderConfigStoreInspection, error) {
	_, snapshot, err := s.readStoredSnapshot()
	inspection := ProviderConfigStoreInspection{
		Snapshot:                  snapshot,
		ProvidersNeedingMigration: []string{},
	}
	if err != nil {
		return inspection, err
	}

	for _, providerConfig := range snapshot.Providers {
		if providerNeedsMigration(providerConfig) {
			inspection.ProvidersNeedingMigration = append(inspection.ProvidersNeedingMigration, providerConfig.ID)
		}
	}

	return inspection, nil
}

func (s *ProviderConfigStore) Save(snapshot ProviderConfigStoreSnapshot) error {
	providers := make([]ai.ProviderConfig, 0, len(snapshot.Providers))
	for _, providerConfig := range snapshot.Providers {
		runtimeConfig := clearRemovedProviderEditorFields(normalizeProviderConfig(clearRemovedProviderEditorFields(providerConfig)))
		meta, bundle := splitProviderSecrets(runtimeConfig)
		if bundle.hasAny() {
			storedMeta, err := persistProviderSecretBundleWithLocalizer(s.dailySecrets, meta, bundle, s.localizer)
			if err != nil {
				return s.storeError("ai_service.backend.error.provider_secret_save_failed", nil, err)
			}
			meta = storedMeta
		} else if meta.HasSecret {
			resolved, _, err := s.loadStoredProviderConfig(meta)
			if err != nil {
				return s.storeError("ai_service.backend.error.provider_secret_save_failed", nil, err)
			}
			meta = providerMetadataView(resolved)
		}
		providers = append(providers, clearRemovedProviderEditorFields(providerMetadataView(meta)))
	}
	if providers == nil {
		providers = []ai.ProviderConfig{}
	}
	mcpHTTPServer := normalizeMCPHTTPServerConfig(snapshot.MCPHTTPServer)
	if err := s.persistMCPHTTPServerToken(mcpHTTPServer.Token); err != nil {
		return s.storeError("ai_service.backend.error.config_write_failed", nil, err)
	}

	cfg := aiConfig{
		SchemaVersion:      aiConfigSchemaVersion,
		Providers:          providers,
		ActiveProvider:     snapshot.ActiveProvider,
		SafetyLevel:        string(snapshot.SafetyLevel),
		ContextLevel:       string(snapshot.ContextLevel),
		UserPromptSettings: snapshot.UserPromptSettings,
		MCPServers:         snapshot.MCPServers,
		MCPHTTPServer:      mcpHTTPServer,
		Skills:             snapshot.Skills,
		ResultMasking:      ai.NormalizeResultMaskingSettings(snapshot.ResultMasking),
	}

	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return s.storeError("ai_service.backend.error.config_serialize_failed", nil, err)
	}
	if err := os.MkdirAll(s.configDir, 0o755); err != nil {
		return s.storeError("ai_service.backend.error.config_dir_create_failed", nil, err)
	}
	if err := os.WriteFile(s.configPath(), data, 0o644); err != nil {
		return s.storeError("ai_service.backend.error.config_write_failed", nil, err)
	}
	return nil
}

func (s *ProviderConfigStore) readStoredSnapshot() (aiConfig, ProviderConfigStoreSnapshot, error) {
	snapshot := ProviderConfigStoreSnapshot{
		Providers:    []ai.ProviderConfig{},
		SafetyLevel:  ai.PermissionReadOnly,
		ContextLevel: ai.ContextSchemaOnly,
		MCPServers:   []ai.MCPServerConfig{},
		Skills:       []ai.SkillConfig{},
	}

	data, err := os.ReadFile(s.configPath())
	if err != nil {
		if os.IsNotExist(err) {
			return aiConfig{}, snapshot, nil
		}
		return aiConfig{}, snapshot, s.storeError("ai_service.backend.error.config_read_failed", nil, err)
	}

	var cfg aiConfig
	if err := json.Unmarshal(data, &cfg); err != nil {
		return aiConfig{}, snapshot, s.storeError("ai_service.backend.error.config_load_failed", nil, err)
	}

	snapshot.ActiveProvider = cfg.ActiveProvider
	switch ai.SQLPermissionLevel(cfg.SafetyLevel) {
	case ai.PermissionReadOnly, ai.PermissionReadWrite, ai.PermissionFull:
		snapshot.SafetyLevel = ai.SQLPermissionLevel(cfg.SafetyLevel)
	}
	switch ai.ContextLevel(cfg.ContextLevel) {
	case ai.ContextSchemaOnly, ai.ContextWithSamples, ai.ContextWithResults:
		snapshot.ContextLevel = ai.ContextLevel(cfg.ContextLevel)
	}
	snapshot.UserPromptSettings = cfg.UserPromptSettings
	snapshot.MCPServers = append([]ai.MCPServerConfig(nil), cfg.MCPServers...)
	snapshot.MCPHTTPServer = normalizeMCPHTTPServerConfig(cfg.MCPHTTPServer)
	snapshot.Skills = append([]ai.SkillConfig(nil), cfg.Skills...)
	snapshot.ResultMasking = ai.NormalizeResultMaskingSettings(cfg.ResultMasking)

	providers := make([]ai.ProviderConfig, 0, len(cfg.Providers))
	for _, providerConfig := range cfg.Providers {
		providers = append(providers, clearRemovedProviderEditorFields(normalizeProviderConfig(clearRemovedProviderEditorFields(providerConfig))))
	}
	if providers == nil {
		providers = []ai.ProviderConfig{}
	}
	snapshot.Providers = providers

	return cfg, snapshot, nil
}

func providerHasRemovedEditorFields(config ai.ProviderConfig) bool {
	return len(config.Models) > 0 || config.MaxTokens != 0 || config.ContextWindow != 0
}

func clearRemovedProviderEditorFields(config ai.ProviderConfig) ai.ProviderConfig {
	config.Models = nil
	config.MaxTokens = 0
	config.ContextWindow = 0
	return config
}

func (s *ProviderConfigStore) loadMCPHTTPServerConfig(config ai.MCPHTTPServerConfig) (ai.MCPHTTPServerConfig, error) {
	config = normalizeMCPHTTPServerConfig(config)
	if s.dailySecrets == nil {
		return config, nil
	}

	bundle, ok, err := s.dailySecrets.GetMCPHTTPServer()
	if err != nil {
		return config, err
	}
	if ok {
		config.Token = strings.TrimSpace(bundle.Token)
	}
	return config, nil
}

func (s *ProviderConfigStore) persistMCPHTTPServerToken(token string) error {
	if s.dailySecrets == nil {
		return nil
	}

	token = strings.TrimSpace(token)
	if token != "" {
		return s.dailySecrets.PutMCPHTTPServer(dailysecret.MCPHTTPServerBundle{Token: token})
	}

	_, exists, err := s.dailySecrets.GetMCPHTTPServer()
	if err != nil || !exists {
		return err
	}
	return s.dailySecrets.DeleteMCPHTTPServer()
}

func (s *ProviderConfigStore) loadStoredProviderConfig(config ai.ProviderConfig) (ai.ProviderConfig, bool, error) {
	meta, bundle := splitProviderSecrets(config)
	if bundle.hasAny() {
		storedMeta, err := persistProviderSecretBundleWithLocalizer(s.dailySecrets, meta, bundle, s.localizer)
		if err != nil {
			return meta, false, err
		}
		return mergeProviderSecrets(storedMeta, bundle), true, nil
	}

	if !meta.HasSecret {
		return meta, false, nil
	}

	if stored, ok, err := s.dailySecrets.GetAIProvider(meta.ID); err != nil {
		return meta, false, err
	} else if ok {
		rewritten := strings.TrimSpace(meta.SecretRef) != ""
		meta.SecretRef = ""
		return mergeProviderSecrets(meta, fromDailyProviderBundle(stored)), rewritten, nil
	}

	if !shouldReadLegacyProviderSecretStore() {
		meta.HasSecret = false
		meta.SecretRef = ""
		return meta, true, nil
	}

	if strings.TrimSpace(meta.SecretRef) != "" {
		resolved, err := resolveProviderConfigSecretsFromStoreWithLocalizer(s.secretStore, meta, s.localizer)
		if err != nil {
			if os.IsNotExist(err) || secretstore.IsUnavailable(err) {
				meta.HasSecret = false
				meta.SecretRef = ""
				return meta, true, nil
			}
			return meta, false, err
		}
		_, migratedBundle := splitProviderSecrets(resolved)
		storedMeta, err := persistProviderSecretBundleWithLocalizer(s.dailySecrets, meta, migratedBundle, s.localizer)
		if err != nil {
			return meta, false, err
		}
		return mergeProviderSecrets(storedMeta, migratedBundle), true, nil
	}

	meta.HasSecret = false
	meta.SecretRef = ""
	return meta, true, nil
}

func (s *ProviderConfigStore) loadRuntimeProviderConfig(config ai.ProviderConfig) (ai.ProviderConfig, error) {
	runtimeConfig, _, err := s.loadStoredProviderConfig(config)
	return runtimeConfig, err
}

func providerNeedsMigration(config ai.ProviderConfig) bool {
	_, bundle := splitProviderSecrets(normalizeProviderConfig(config))
	return bundle.hasAny() || strings.TrimSpace(config.SecretRef) != ""
}
