package app

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"

	"github.com/google/uuid"
)

const (
	defaultScriptWorkbenchWriteApprovalTTL  = 2 * time.Minute
	scriptWorkbenchMaxPendingWriteApprovals = 256
)

var (
	scriptWorkbenchWriteApprovalTTL = defaultScriptWorkbenchWriteApprovalTTL
	scriptWorkbenchWriteApprovalNow = time.Now
)

// ScriptWorkbenchWriteApproval is returned by PrepareScriptWorkbenchWrite.
// Required=false means the run has no unprotected production write target and
// WriteApprovalToken may stay empty.
type ScriptWorkbenchWriteApproval struct {
	Required  bool   `json:"required"`
	Token     string `json:"token,omitempty"`
	ExpiresAt int64  `json:"expiresAt,omitempty"`
}

type scriptWorkbenchWriteApproval struct {
	BindingHash string
	Actor       string
	Runtime     string
	ExpiresAt   time.Time
}

type scriptWorkbenchWriteBinding struct {
	Runtime          string                                  `json:"runtime"`
	Actor            string                                  `json:"actor"`
	Role             string                                  `json:"role"`
	AllowWrite       bool                                    `json:"allowWrite"`
	ScriptHash       string                                  `json:"scriptHash"`
	BatchSize        int                                     `json:"batchSize"`
	INListLimit      int                                     `json:"inListLimit"`
	TimeoutMs        int64                                   `json:"timeoutMs"`
	MaxDBCalls       int                                     `json:"maxDbCalls"`
	MaxOutputRows    int                                     `json:"maxOutputRows"`
	MemoryLimitBytes int64                                   `json:"memoryLimitBytes"`
	Connections      []scriptWorkbenchWriteConnectionBinding `json:"connections"`
	Production       []scriptWorkbenchWriteConnectionBinding `json:"production"`
	Inputs           []scriptWorkbenchWriteInputBinding      `json:"inputs"`
}

type scriptWorkbenchWriteConnectionBinding struct {
	Alias           string `json:"alias"`
	ConnectionID    string `json:"connectionId"`
	Database        string `json:"database"`
	EnvironmentType string `json:"environmentType"`
}

type scriptWorkbenchWriteInputBinding struct {
	Alias     string `json:"alias"`
	Path      string `json:"path"`
	Reference string `json:"reference"`
	Name      string `json:"name"`
	SheetName string `json:"sheetName"`
	Encoding  string `json:"encoding"`
	Delimiter string `json:"delimiter"`
	HeaderRow int    `json:"headerRow"`
}

func (a *App) PrepareScriptWorkbenchWrite(request ScriptWorkbenchRunRequest) connection.QueryResult {
	return a.prepareScriptWorkbenchWriteContext(a.ctx, request)
}

func (a *App) prepareScriptWorkbenchWriteContext(ctx context.Context, request ScriptWorkbenchRunRequest) connection.QueryResult {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return scriptWorkbenchFailure(err)
	}
	actor, webActor, err := a.scriptWorkbenchActor(ctx)
	if err != nil {
		return scriptWorkbenchFailure(err)
	}
	prepared, err := a.buildScriptWorkbenchPreparedRun(ctx, request, actor, webActor)
	if err != nil {
		return scriptWorkbenchFailure(err)
	}
	if !prepared.requiresWriteApproval {
		return connection.QueryResult{
			Success: true,
			Message: "OK",
			Data:    ScriptWorkbenchWriteApproval{Required: false},
		}
	}
	token, expiresAt, err := a.issueScriptWorkbenchWriteApproval(prepared)
	if err != nil {
		return scriptWorkbenchFailure(err)
	}
	return connection.QueryResult{
		Success: true,
		Message: "OK",
		Data: ScriptWorkbenchWriteApproval{
			Required:  true,
			Token:     token,
			ExpiresAt: expiresAt.UnixMilli(),
		},
	}
}

func (a *App) issueScriptWorkbenchWriteApproval(prepared *scriptWorkbenchPrepared) (string, time.Time, error) {
	if a == nil || prepared == nil {
		return "", time.Time{}, errScriptWorkbenchUnavailable
	}
	bindingHash, err := scriptWorkbenchWriteBindingHash(a, prepared)
	if err != nil {
		return "", time.Time{}, err
	}
	now := scriptWorkbenchWriteApprovalNow()
	ttl := scriptWorkbenchWriteApprovalTTL
	if ttl <= 0 {
		ttl = defaultScriptWorkbenchWriteApprovalTTL
	}
	expiresAt := now.Add(ttl)
	token := uuid.NewString()
	entry := scriptWorkbenchWriteApproval{
		BindingHash: bindingHash,
		Actor:       prepared.actor.Owner,
		Runtime:     scriptWorkbenchApprovalRuntime(a),
		ExpiresAt:   expiresAt,
	}
	a.scriptWorkbench.approvalMu.Lock()
	if a.scriptWorkbench.approvals == nil {
		a.scriptWorkbench.approvals = make(map[string]scriptWorkbenchWriteApproval)
	}
	for key, existing := range a.scriptWorkbench.approvals {
		if !existing.ExpiresAt.After(now) {
			delete(a.scriptWorkbench.approvals, key)
		}
	}
	for len(a.scriptWorkbench.approvals) >= scriptWorkbenchMaxPendingWriteApprovals {
		oldestToken := ""
		var oldestExpiry time.Time
		for key, existing := range a.scriptWorkbench.approvals {
			if oldestToken == "" || existing.ExpiresAt.Before(oldestExpiry) {
				oldestToken = key
				oldestExpiry = existing.ExpiresAt
			}
		}
		if oldestToken == "" {
			break
		}
		delete(a.scriptWorkbench.approvals, oldestToken)
	}
	a.scriptWorkbench.approvals[token] = entry
	a.scriptWorkbench.approvalMu.Unlock()
	return token, expiresAt, nil
}

func (a *App) consumeScriptWorkbenchWriteApproval(token string, prepared *scriptWorkbenchPrepared) error {
	if prepared == nil || !prepared.requiresWriteApproval {
		return nil
	}
	token = strings.TrimSpace(token)
	if token == "" {
		return errors.New("production write approval token is required")
	}
	bindingHash, err := scriptWorkbenchWriteBindingHash(a, prepared)
	if err != nil {
		return err
	}
	now := scriptWorkbenchWriteApprovalNow()
	a.scriptWorkbench.approvalMu.Lock()
	entry, exists := a.scriptWorkbench.approvals[token]
	for key, existing := range a.scriptWorkbench.approvals {
		if !existing.ExpiresAt.After(now) {
			delete(a.scriptWorkbench.approvals, key)
		}
	}
	if !exists {
		a.scriptWorkbench.approvalMu.Unlock()
		return errors.New("production write approval token is invalid or was already used")
	}
	if !entry.ExpiresAt.After(now) {
		a.scriptWorkbench.approvalMu.Unlock()
		return errors.New("production write approval token has expired")
	}
	if entry.Runtime != scriptWorkbenchApprovalRuntime(a) ||
		entry.Actor != prepared.actor.Owner ||
		!secureTextEqual(entry.BindingHash, bindingHash) {
		a.scriptWorkbench.approvalMu.Unlock()
		return errors.New("production write approval token does not match the current run")
	}
	delete(a.scriptWorkbench.approvals, token)
	a.scriptWorkbench.approvalMu.Unlock()
	return nil
}

func scriptWorkbenchApprovalRuntime(a *App) string {
	if a != nil && a.webRuntime {
		return "web"
	}
	return "desktop"
}

func scriptWorkbenchWriteBindingHash(a *App, prepared *scriptWorkbenchPrepared) (string, error) {
	if prepared == nil {
		return "", errScriptWorkbenchUnavailable
	}
	connections := make([]scriptWorkbenchWriteConnectionBinding, 0, len(prepared.connections))
	production := make([]scriptWorkbenchWriteConnectionBinding, 0, len(prepared.connections))
	for alias, item := range prepared.connections {
		binding := scriptWorkbenchWriteConnectionBinding{
			Alias:           alias,
			ConnectionID:    strings.TrimSpace(item.config.ID),
			Database:        strings.TrimSpace(item.database),
			EnvironmentType: normalizeConnectionEnvironmentType(item.environmentType),
		}
		connections = append(connections, binding)
		if binding.EnvironmentType == "production" &&
			!item.readOnly &&
			!isConnectionForcedReadOnly(item.config) {
			production = append(production, binding)
		}
	}
	sort.Slice(connections, func(i, j int) bool { return connections[i].Alias < connections[j].Alias })
	sort.Slice(production, func(i, j int) bool { return production[i].Alias < production[j].Alias })

	inputs := make([]scriptWorkbenchWriteInputBinding, 0, len(prepared.inputs))
	for alias, item := range prepared.inputs {
		inputs = append(inputs, scriptWorkbenchWriteInputBinding{
			Alias:     alias,
			Path:      item.path,
			Reference: item.reference,
			Name:      item.name,
			SheetName: item.sheetName,
			Encoding:  item.encoding,
			Delimiter: item.delimiter,
			HeaderRow: item.headerRow,
		})
	}
	sort.Slice(inputs, func(i, j int) bool { return inputs[i].Alias < inputs[j].Alias })

	scriptDigest := sha256.Sum256([]byte(prepared.code))
	binding := scriptWorkbenchWriteBinding{
		Runtime:          scriptWorkbenchApprovalRuntime(a),
		Actor:            prepared.actor.Owner,
		Role:             prepared.webActor.role,
		AllowWrite:       prepared.allowWrite,
		ScriptHash:       hex.EncodeToString(scriptDigest[:]),
		BatchSize:        prepared.batchSize,
		INListLimit:      prepared.inListLimit,
		TimeoutMs:        prepared.timeout.Milliseconds(),
		MaxDBCalls:       prepared.maxDBCalls,
		MaxOutputRows:    prepared.maxOutputRows,
		MemoryLimitBytes: prepared.memoryLimitBytes,
		Connections:      connections,
		Production:       production,
		Inputs:           inputs,
	}
	payload, err := json.Marshal(binding)
	if err != nil {
		return "", fmt.Errorf("encode script write approval binding: %w", err)
	}
	digest := sha256.Sum256(payload)
	return hex.EncodeToString(digest[:]), nil
}
