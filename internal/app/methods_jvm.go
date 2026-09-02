package app

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/jvm"
	"github.com/google/uuid"
)

var newJVMProvider = jvm.NewProvider

const defaultJVMPreviewConfirmationTokenTTL = 10 * time.Minute

type jvmPreviewConfirmationToken struct {
	contextHash string
	expiresAt   time.Time
}

type jvmPreviewConfirmationContext struct {
	ConfigHash      string `json:"configHash"`
	ProviderMode    string `json:"providerMode"`
	ResourceID      string `json:"resourceId"`
	Action          string `json:"action"`
	Reason          string `json:"reason"`
	Source          string `json:"source"`
	ExpectedVersion string `json:"expectedVersion"`
	PayloadHash     string `json:"payloadHash"`
	PreviewChecksum string `json:"previewChecksum"`
	RiskLevel       string `json:"riskLevel"`
	BeforeVersion   string `json:"beforeVersion"`
	AfterVersion    string `json:"afterVersion"`
}

type jvmPreviewConfirmationHashError struct {
	key string
	err error
}

func (e *jvmPreviewConfirmationHashError) Error() string {
	if e == nil || e.err == nil {
		return ""
	}
	return e.err.Error()
}

func (e *jvmPreviewConfirmationHashError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.err
}

func buildJVMCapabilityError(mode string, cfg connection.ConnectionConfig, err error) jvm.Capability {
	probeCfg := cfg
	probeCfg.JVM.PreferredMode = mode
	return jvm.Capability{
		Mode:         mode,
		DisplayLabel: jvm.ModeDisplayLabel(mode),
		Reason:       jvm.DescribeConnectionTestError(probeCfg, err),
	}
}

func resolveJVMProvider(cfg connection.ConnectionConfig) (connection.ConnectionConfig, jvm.Provider, error) {
	return resolveJVMProviderForMode(cfg, "")
}

func resolveJVMProviderForMode(cfg connection.ConnectionConfig, mode string) (connection.ConnectionConfig, jvm.Provider, error) {
	normalized, selectedMode, err := jvm.ResolveProviderMode(cfg, mode)
	if err != nil {
		return connection.ConnectionConfig{}, nil, err
	}

	normalized.JVM.PreferredMode = selectedMode

	provider, err := newJVMProvider(selectedMode)
	if err != nil {
		return connection.ConnectionConfig{}, nil, err
	}

	return normalized, provider, nil
}

func (a *App) issueJVMPreviewConfirmationToken(cfg connection.ConnectionConfig, req jvm.ChangeRequest, preview jvm.ChangePreview) (string, error) {
	contextHash, err := buildJVMPreviewConfirmationContextHash(cfg, req, preview)
	if err != nil {
		return "", a.localizeJVMPreviewConfirmationHashError(err)
	}

	token := uuid.NewString()
	now := time.Now()
	ttl := a.jvmPreviewTokenTTL
	if ttl <= 0 {
		ttl = defaultJVMPreviewConfirmationTokenTTL
	}

	a.jvmPreviewTokenMu.Lock()
	defer a.jvmPreviewTokenMu.Unlock()
	if a.jvmPreviewTokens == nil {
		a.jvmPreviewTokens = make(map[string]jvmPreviewConfirmationToken)
	}
	a.pruneExpiredJVMPreviewConfirmationTokensLocked(now)
	a.jvmPreviewTokens[token] = jvmPreviewConfirmationToken{
		contextHash: contextHash,
		expiresAt:   now.Add(ttl),
	}
	return token, nil
}

func (a *App) consumeJVMPreviewConfirmationToken(cfg connection.ConnectionConfig, req jvm.ChangeRequest, preview jvm.ChangePreview) error {
	if !preview.RequiresConfirmation {
		return nil
	}

	if strings.TrimSpace(preview.ConfirmationToken) == "" {
		return errors.New(a.appText("jvm.backend.error.preview_confirmation_missing", nil))
	}

	token := strings.TrimSpace(req.ConfirmationToken)
	if token == "" {
		return errors.New(a.appText("jvm.backend.error.confirmation_token_missing", nil))
	}

	expectedHash, err := buildJVMPreviewConfirmationContextHash(cfg, req, preview)
	if err != nil {
		return a.localizeJVMPreviewConfirmationHashError(err)
	}

	now := time.Now()
	a.jvmPreviewTokenMu.Lock()
	if a.jvmPreviewTokens == nil {
		a.jvmPreviewTokens = make(map[string]jvmPreviewConfirmationToken)
	}
	entry, ok := a.jvmPreviewTokens[token]
	if ok {
		delete(a.jvmPreviewTokens, token)
	}
	a.pruneExpiredJVMPreviewConfirmationTokensLocked(now)
	a.jvmPreviewTokenMu.Unlock()

	if !ok {
		return errors.New(a.appText("jvm.backend.error.confirmation_token_invalid", nil))
	}
	if !entry.expiresAt.After(now) {
		return errors.New(a.appText("jvm.backend.error.confirmation_token_expired", nil))
	}
	if subtle.ConstantTimeCompare([]byte(entry.contextHash), []byte(expectedHash)) != 1 {
		return errors.New(a.appText("jvm.backend.error.confirmation_token_invalid", nil))
	}
	return nil
}

func (a *App) pruneExpiredJVMPreviewConfirmationTokensLocked(now time.Time) {
	for token, entry := range a.jvmPreviewTokens {
		if !entry.expiresAt.After(now) {
			delete(a.jvmPreviewTokens, token)
		}
	}
}

func buildJVMPreviewConfirmationContextHash(cfg connection.ConnectionConfig, req jvm.ChangeRequest, preview jvm.ChangePreview) (string, error) {
	configHash, err := hashJSONValue(cfg)
	if err != nil {
		return "", &jvmPreviewConfirmationHashError{
			key: "jvm.backend.error.preview_context_hash_failed",
			err: err,
		}
	}
	payloadHash, err := hashJSONValue(req.Payload)
	if err != nil {
		return "", &jvmPreviewConfirmationHashError{
			key: "jvm.backend.error.preview_payload_hash_failed",
			err: err,
		}
	}

	input := jvmPreviewConfirmationContext{
		ConfigHash:      configHash,
		ProviderMode:    strings.TrimSpace(cfg.JVM.PreferredMode),
		ResourceID:      strings.TrimSpace(req.ResourceID),
		Action:          strings.TrimSpace(req.Action),
		Reason:          strings.TrimSpace(req.Reason),
		Source:          strings.TrimSpace(req.Source),
		ExpectedVersion: strings.TrimSpace(req.ExpectedVersion),
		PayloadHash:     payloadHash,
		PreviewChecksum: strings.TrimSpace(preview.ConfirmationToken),
		RiskLevel:       strings.TrimSpace(preview.RiskLevel),
		BeforeVersion:   strings.TrimSpace(preview.Before.Version),
		AfterVersion:    strings.TrimSpace(preview.After.Version),
	}
	return hashJSONValue(input)
}

func (a *App) localizeJVMPreviewConfirmationHashError(err error) error {
	var hashErr *jvmPreviewConfirmationHashError
	if !errors.As(err, &hashErr) || hashErr == nil {
		return err
	}
	return errors.New(a.appText(hashErr.key, map[string]any{
		"detail": hashErr.Error(),
	}))
}

func (a *App) localizeJVMError(err error) string {
	if err == nil {
		return ""
	}
	var localized *jvm.LocalizedError
	if errors.As(err, &localized) && localized != nil && strings.TrimSpace(localized.Key) != "" {
		return a.appText(localized.Key, localized.Params)
	}
	return err.Error()
}

func (a *App) localizeJVMBlockingReason(preview jvm.ChangePreview) string {
	reason := strings.TrimSpace(preview.BlockingReason)
	if reason == "" {
		return ""
	}
	key := strings.TrimSpace(preview.BlockingReasonLocalizationKey())
	if key != "" && reason == key {
		return a.appText(key, nil)
	}
	return reason
}

func (a *App) localizeJVMCapability(capability jvm.Capability) jvm.Capability {
	reason := strings.TrimSpace(capability.Reason)
	if reason == "" {
		return capability
	}
	key := strings.TrimSpace(capability.ReasonLocalizationKey())
	if key != "" && reason == key {
		capability.Reason = a.appText(key, nil)
	}
	return capability
}

func hashJSONValue(value any) (string, error) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(encoded)
	return hex.EncodeToString(sum[:]), nil
}

func (a *App) TestJVMConnection(cfg connection.ConnectionConfig) connection.QueryResult {
	return a.testJVMConnectionWithContext(a.ctx, cfg)
}

func (a *App) testJVMConnectionWithContext(ctx context.Context, cfg connection.ConnectionConfig) connection.QueryResult {
	if ctx == nil {
		ctx = context.Background()
	}
	normalized, provider, err := resolveJVMProvider(cfg)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	if err := provider.TestConnection(ctx, normalized); err != nil {
		return connection.QueryResult{Success: false, Message: jvm.DescribeConnectionTestError(normalized, err)}
	}

	return connection.QueryResult{Success: true, Message: a.appText("jvm.backend.message.connect_success", nil)}
}

func (a *App) JVMListResources(cfg connection.ConnectionConfig, parentPath string) connection.QueryResult {
	normalized, provider, err := resolveJVMProvider(cfg)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	items, err := provider.ListResources(a.ctx, normalized, parentPath)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	return connection.QueryResult{Success: true, Data: items}
}

func (a *App) JVMGetValue(cfg connection.ConnectionConfig, resourcePath string) connection.QueryResult {
	normalized, provider, err := resolveJVMProvider(cfg)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	value, err := provider.GetValue(a.ctx, normalized, resourcePath)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	return connection.QueryResult{Success: true, Data: value}
}

func (a *App) JVMPreviewChange(cfg connection.ConnectionConfig, req jvm.ChangeRequest) connection.QueryResult {
	var err error
	req, err = jvm.NormalizeChangeRequest(req)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	normalized, provider, err := resolveJVMProviderForMode(cfg, req.ProviderMode)
	if err != nil {
		return connection.QueryResult{Success: false, Message: a.localizeJVMError(err)}
	}

	preview, err := jvm.BuildChangePreview(a.ctx, provider, normalized, req)
	if err != nil {
		return connection.QueryResult{Success: false, Message: a.localizeJVMError(err)}
	}
	if preview.Allowed && preview.RequiresConfirmation {
		token, err := a.issueJVMPreviewConfirmationToken(normalized, req, preview)
		if err != nil {
			return connection.QueryResult{Success: false, Message: err.Error()}
		}
		preview.ConfirmationToken = token
	}
	preview.BlockingReason = a.localizeJVMBlockingReason(preview)

	return connection.QueryResult{Success: true, Data: preview}
}

func (a *App) JVMApplyChange(cfg connection.ConnectionConfig, req jvm.ChangeRequest) connection.QueryResult {
	var err error
	req, err = jvm.NormalizeChangeRequest(req)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	normalized, provider, err := resolveJVMProviderForMode(cfg, req.ProviderMode)
	if err != nil {
		return connection.QueryResult{Success: false, Message: a.localizeJVMError(err)}
	}

	preview, err := jvm.BuildChangePreview(a.ctx, provider, normalized, req)
	if err != nil {
		return connection.QueryResult{Success: false, Message: a.localizeJVMError(err)}
	}
	if !preview.Allowed {
		message := a.localizeJVMBlockingReason(preview)
		if message == "" {
			message = a.appText("jvm.backend.error.change_blocked_by_guard", nil)
		}
		return connection.QueryResult{Success: false, Message: message}
	}
	if err := a.consumeJVMPreviewConfirmationToken(normalized, req, preview); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	auditStore := jvm.NewAuditStore(filepath.Join(a.auditRootDir(), "jvm_audit.jsonl"))
	appendAuditRecord := func(record jvm.AuditRecord) error {
		return auditStore.Append(record)
	}
	appendAudit := func(result string, timestamp int64) error {
		return appendAuditRecord(jvm.AuditRecord{
			Timestamp:    timestamp,
			ConnectionID: normalized.ID,
			ProviderMode: normalized.JVM.PreferredMode,
			ResourceID:   req.ResourceID,
			Action:       req.Action,
			Reason:       req.Reason,
			Source:       req.Source,
			Result:       result,
		})
	}
	appendWarning := func(message string, warning string) string {
		message = strings.TrimSpace(message)
		warning = strings.TrimSpace(warning)
		if warning == "" {
			return message
		}
		if message == "" {
			return warning
		}
		return message + a.appText("jvm.backend.separator.message_warning", nil) + warning
	}

	pendingTimestamp := time.Now().UnixMilli()
	terminalAuditTimestamp := func() int64 {
		ts := time.Now().UnixMilli()
		if ts <= pendingTimestamp {
			return pendingTimestamp + 1
		}
		return ts
	}

	if err := appendAudit("pending", pendingTimestamp); err != nil {
		return connection.QueryResult{Success: false, Message: a.appText("jvm.backend.error.audit_write_blocked", map[string]any{"detail": err.Error()})}
	}

	result, err := provider.ApplyChange(a.ctx, normalized, req)
	if err != nil {
		if auditErr := appendAudit("failed", terminalAuditTimestamp()); auditErr != nil {
			return connection.QueryResult{Success: false, Message: appendWarning(err.Error(), a.appText("jvm.backend.warning.failed_audit_write_failed", map[string]any{"detail": auditErr.Error()}))}
		}
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	terminalResult := strings.TrimSpace(result.Status)
	if terminalResult == "" {
		terminalResult = "applied"
	}
	if err := appendAudit(terminalResult, terminalAuditTimestamp()); err != nil {
		result.Message = appendWarning(result.Message, a.appText("jvm.backend.warning.terminal_audit_write_failed", map[string]any{"detail": err.Error()}))
		return connection.QueryResult{Success: true, Message: result.Message, Data: result}
	}

	return connection.QueryResult{Success: true, Data: result}
}

func (a *App) JVMListAuditRecords(connectionID string, limit int) connection.QueryResult {
	records, err := jvm.NewAuditStore(filepath.Join(a.auditRootDir(), "jvm_audit.jsonl")).List(connectionID, limit)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Data: records}
}

func (a *App) JVMProbeCapabilities(cfg connection.ConnectionConfig) connection.QueryResult {
	normalized, err := jvm.NormalizeConnectionConfig(cfg)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	items := make([]jvm.Capability, 0, len(normalized.JVM.AllowedModes))
	for _, mode := range normalized.JVM.AllowedModes {
		probeCfg := normalized
		probeCfg.JVM.PreferredMode = mode

		provider, providerErr := newJVMProvider(mode)
		if providerErr != nil {
			items = append(items, buildJVMCapabilityError(mode, probeCfg, providerErr))
			continue
		}

		caps, probeErr := provider.ProbeCapabilities(a.ctx, probeCfg)
		if probeErr != nil {
			items = append(items, buildJVMCapabilityError(mode, probeCfg, probeErr))
			continue
		}

		for _, cap := range caps {
			items = append(items, a.localizeJVMCapability(cap))
		}
	}

	return connection.QueryResult{Success: true, Data: items}
}

func (a *App) auditRootDir() string {
	if strings.TrimSpace(a.configDir) != "" {
		return a.configDir
	}
	return resolveAppConfigDir()
}
