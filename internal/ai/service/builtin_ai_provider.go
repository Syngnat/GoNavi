package aiservice

import (
	"errors"
	"strings"

	"GoNavi-Wails/internal/ai"
	"GoNavi-Wails/internal/logger"
	"GoNavi-Wails/shared/i18n"
)

const (
	// builtinAIContextWindow / builtinAIMaxOutputTokens are the limits assumed
	// until the Gateway reports its own (see ai.CurrentHostedModelLimits). The
	// agent harness only trims prompts when it knows the window; without it a
	// real request (system prompt + schema + history) is rejected as too large.
	builtinAIContextWindow    = ai.DefaultHostedContextWindow
	builtinAIMaxOutputTokens  = ai.DefaultHostedMaxOutputTokens
	builtinAIDefaultTemperate = 0.1
)

// isBuiltinAIProviderConfig recognizes the built-in provider by its fixed id or,
// for records saved by earlier builds under a random id, by its precise
// name/endpoint/model combination. It never infers from an alias alone, so an
// unrelated custom provider is never redirected to the free service.
func isBuiltinAIProviderConfig(cfg ai.ProviderConfig) bool {
	if cfg.ID == builtinAIProviderID {
		return true
	}
	if !strings.EqualFold(strings.TrimSpace(cfg.Name), builtinAIProviderName) || !strings.EqualFold(strings.TrimSpace(cfg.AuthMode), "bearer") {
		return false
	}
	if model := strings.TrimSpace(cfg.Model); model != "" && !strings.EqualFold(model, builtinAIDefaultModel) {
		return false
	}
	base := strings.TrimRight(strings.TrimSpace(cfg.BaseURL), "/")
	if base == "" {
		return cfg.APIFormat == "openai" || cfg.APIFormat == ""
	}
	origins := []string{builtinAIDefaultGateway}
	if builtin, err := loadBuiltinAIConfig(); err == nil {
		origins = append(origins, builtin.gatewayURL)
	}
	for _, origin := range origins {
		if base == origin+"/v1" || base == origin {
			return true
		}
	}
	return false
}

// completeBuiltinAIProvider returns the provider every layer (list view, save,
// activate, test, send) must use. Identity, endpoint and protocol are owned by
// this app, not by the stored record, which may be partial (no address or
// model), stale, or saved under a legacy id. Credentials are never part of it.
func completeBuiltinAIProvider(cfg ai.ProviderConfig) ai.ProviderConfig {
	gateway, model := builtinAIDefaultGateway, builtinAIDefaultModel
	if builtin, err := loadBuiltinAIConfig(); err == nil {
		gateway, model = builtin.gatewayURL, builtin.model
	}
	cfg.ID = builtinAIProviderID
	if strings.TrimSpace(cfg.Name) == "" {
		cfg.Name = builtinAIProviderName
	}
	cfg.Type = "custom"
	cfg.APIFormat = "openai"
	cfg.AuthMode = "bearer"
	cfg.BaseURL = gateway + "/v1"
	cfg.Model = model
	cfg.Models = []string{model}
	limits, _ := ai.CurrentHostedModelLimits()
	cfg.ContextWindow = limits.ContextWindow
	if cfg.MaxTokens <= 0 || cfg.MaxTokens > limits.MaxOutputTokens {
		cfg.MaxTokens = limits.MaxOutputTokens
	}
	if cfg.Temperature == 0 {
		cfg.Temperature = builtinAIDefaultTemperate
	}
	cfg.APIKey, cfg.SecretRef, cfg.HasSecret = "", "", false
	// The hosted model has no reasoning mode: never send a thinking level.
	cfg.ThinkingIntensity, cfg.Effort = "", ""
	cfg.SupportsImages = builtinAISupportsImages()
	// Stored headers are discarded; only the product token below is sent.
	cfg.Headers, cfg.CLIEnv = map[string]string{"User-Agent": builtinAIUserAgent()}, nil
	return cfg
}

// normalizeBuiltinAIProviderConfig completes a built-in record and leaves every
// other provider untouched.
func normalizeBuiltinAIProviderConfig(config ai.ProviderConfig) ai.ProviderConfig {
	if !isBuiltinAIProviderConfig(config) {
		return config
	}
	return completeBuiltinAIProvider(config)
}

// builtinProviderMetadata is the read view of a stored provider: for the
// built-in provider it is complete, and HasSecret reflects this device's login.
func (s *Service) builtinProviderMetadata(cfg ai.ProviderConfig) ai.ProviderConfig {
	if !isBuiltinAIProviderConfig(cfg) {
		return cfg
	}
	cfg = completeBuiltinAIProvider(cfg)
	cfg.HasSecret = s.builtinAIHasLocalToken()
	return cfg
}

// canonicalizeBuiltinAIProvidersLocked collapses every stored built-in record,
// including legacy random-id ones, into the single complete "gonavi-ai" record
// and remaps the active provider. The caller holds s.mu. It reports whether
// anything changed so the caller can persist.
func (s *Service) canonicalizeBuiltinAIProvidersLocked() bool {
	changed, seen := false, false
	result := make([]ai.ProviderConfig, 0, len(s.providers))
	for _, stored := range s.providers {
		if !isBuiltinAIProviderConfig(stored) {
			result = append(result, stored)
			continue
		}
		if s.activeProvider == stored.ID && stored.ID != builtinAIProviderID {
			s.activeProvider = builtinAIProviderID
			changed = true
		}
		if seen {
			changed = true
			continue
		}
		seen = true
		completed := completeBuiltinAIProvider(stored)
		changed = changed || !sameBuiltinAIRecord(completed, stored)
		result = append(result, completed)
	}
	s.providers = result
	return changed
}

// addBuiltinAIProviderLocked appends the complete built-in record when none is
// stored. The caller holds s.mu. It reports whether the record now exists.
func (s *Service) addBuiltinAIProviderLocked() bool {
	for _, existing := range s.providers {
		if existing.ID == builtinAIProviderID {
			return true
		}
	}
	if _, err := loadBuiltinAIConfig(); err != nil {
		return false
	}
	s.providers = append(s.providers, completeBuiltinAIProvider(ai.ProviderConfig{}))
	return true
}

// saveBuiltinAIProviderLocked persists the built-in provider as metadata only.
// Whatever the caller sent (legacy id, missing address/model, a stale secret
// flag) is replaced by the complete record, and duplicates are merged. The
// caller holds s.mu.
func (s *Service) saveBuiltinAIProviderLocked(config ai.ProviderConfig) error {
	previous := append([]ai.ProviderConfig(nil), s.providers...)
	previousActive := s.activeProvider
	s.canonicalizeBuiltinAIProvidersLocked()
	complete := completeBuiltinAIProvider(config)
	replaced := false
	for i := range s.providers {
		if s.providers[i].ID == builtinAIProviderID {
			s.providers[i], replaced = complete, true
			break
		}
	}
	if !replaced {
		s.providers = append(s.providers, complete)
	}
	if err := s.saveConfig(); err != nil {
		s.providers, s.activeProvider = previous, previousActive
		return err
	}
	return nil
}

// migrateBuiltinAIProviders runs once at startup: records saved by earlier
// builds (random id, no address, secrets mixed into the provider record) become
// the single complete built-in record.
func (s *Service) migrateBuiltinAIProviders() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.canonicalizeBuiltinAIProvidersLocked() {
		if err := s.saveConfig(); err != nil {
			logger.Warnf("迁移 GoNavi AI 供应商记录失败: %v", err)
		}
	}
}

// ensureBuiltinAIProviderRecord guarantees the complete built-in record exists
// after a login, even if no provider was ever saved. An empty active provider
// becomes the built-in one so the first login is immediately usable.
func (s *Service) ensureBuiltinAIProviderRecord() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	changed := s.canonicalizeBuiltinAIProvidersLocked()
	if !s.addBuiltinAIProviderLocked() {
		return errors.New("GoNavi AI gateway is not configured")
	}
	if strings.TrimSpace(s.activeProvider) == "" {
		s.activeProvider, changed = builtinAIProviderID, true
	}
	if !changed && s.builtinAIRecordCurrentLocked() {
		return nil
	}
	return s.saveConfig()
}

func (s *Service) builtinAIRecordCurrentLocked() bool {
	for _, existing := range s.providers {
		if existing.ID == builtinAIProviderID {
			return sameBuiltinAIRecord(completeBuiltinAIProvider(existing), existing)
		}
	}
	return false
}

// sameBuiltinAIRecord compares only the fields that are persisted. Context
// window, max tokens and the model list are editor-removed fields the config
// store clears on every save, so they would otherwise look "changed" forever.
func sameBuiltinAIRecord(a, b ai.ProviderConfig) bool {
	return a.ID == b.ID && a.Name == b.Name && a.Type == b.Type && a.APIFormat == b.APIFormat &&
		a.AuthMode == b.AuthMode && a.BaseURL == b.BaseURL && a.Model == b.Model &&
		a.HasSecret == b.HasSecret && a.SecretRef == b.SecretRef && a.APIKey == b.APIKey
}

// builtinAIModelList answers model discovery without a network call: the
// Gateway serves exactly one pinned model, and a request here would only be
// able to fail for credential reasons that the send path already reports.
func builtinAIModelList() map[string]interface{} {
	return map[string]interface{}{
		"success": true,
		"models":  []string{completeBuiltinAIProvider(ai.ProviderConfig{}).Model},
		"source":  "static",
	}
}

// pinBuiltinAIContextLimits keeps the harness inside what the Gateway accepts.
// A per-request max-token override larger than the window would otherwise leave
// no room for the prompt and fail the run before it reaches the Gateway.
func pinBuiltinAIContextLimits(cfg ai.ProviderConfig) ai.ProviderConfig {
	// A per-run thinking level (the composer used to offer one) means nothing here.
	cfg.ThinkingIntensity, cfg.Effort = "", ""
	cfg.SupportsImages = builtinAISupportsImages()
	limits, _ := ai.CurrentHostedModelLimits()
	cfg.ContextWindow = limits.ContextWindow
	if cfg.MaxTokens <= 0 || cfg.MaxTokens > limits.MaxOutputTokens {
		cfg.MaxTokens = limits.MaxOutputTokens
	}
	return cfg
}

// resolveBuiltinAIProvider turns any built-in record into a ready-to-use
// provider config carrying a fresh access token. A refresh token or expiry are
// account metadata and never become request headers.
func (s *Service) resolveBuiltinAIProvider(cfg ai.ProviderConfig, localizer *i18n.Localizer) (ai.ProviderConfig, error) {
	config, err := loadBuiltinAIConfig()
	if err != nil {
		return cfg, builtinAIServiceError(localizer, err)
	}
	bundle, err := s.ensureBuiltinAIAccessToken(config, false)
	if err != nil {
		return cfg, builtinAIServiceError(localizer, err)
	}
	refreshBuiltinAILimits(config, bundle.APIKey)
	cfg = completeBuiltinAIProvider(cfg)
	cfg.APIKey = bundle.APIKey
	cfg.HasSecret = true
	return cfg, nil
}

// testBuiltinAIProvider checks login, gateway reachability, quota and node
// availability through /v1/quota, which consumes no generation quota.
func (s *Service) testBuiltinAIProvider() map[string]interface{} {
	status, _ := s.AIGetBuiltinAIStatus()
	if status.State != ai.BuiltinAIStateReady {
		return s.providerTestResult("endpoint", errors.New(status.Message))
	}
	if exhausted := builtinAIQuotaExhausted(status.Quota); exhausted != nil {
		return s.providerTestResult("endpoint", errors.New(s.builtinAIMessage(exhausted)))
	}
	return s.providerTestResult("endpoint", nil)
}

// builtinAISupportsImages is false: the hosted SQL model reads text only. The desktop
// recognises the text in an image itself and attaches that instead.
func builtinAISupportsImages() *bool {
	supported := false
	return &supported
}
