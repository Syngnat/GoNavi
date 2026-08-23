package app

import (
	"crypto/sha256"
	"crypto/subtle"
	"errors"
	"strings"
	"time"

	"GoNavi-Wails/internal/syncjob"
	"github.com/google/uuid"
)

const (
	defaultDataSyncJobApprovalTokenTTL = 10 * time.Minute
	defaultDataSyncJobApprovalDelay    = 10 * time.Second
	defaultDataSyncJobChallengeTTL     = 5 * time.Minute
)

type dataSyncJobApprovalToken struct {
	JobID             string
	DefinitionHash    string
	TargetFingerprint string
	ApprovedAt        int64
	ApprovedByRuntime string
	ExpiresAt         time.Time
}

type dataSyncJobApprovalChallenge struct {
	JobID             string
	DefinitionHash    string
	TargetFingerprint string
	Runtime           string
	NotBefore         time.Time
	ExpiresAt         time.Time
}

func dataSyncJobDefinitionHash(input syncjob.JobDefinition) (string, error) {
	return syncjob.ExecutionPlanHash(input)
}

func dataSyncJobApprovalScopeHash(input syncjob.JobDefinition) (string, error) {
	return syncjob.ApprovalScopeHash(input)
}

func (a *App) beginDataSyncJobApproval(definition syncjob.JobDefinition, targetFingerprint string, now time.Time) (string, time.Time, time.Time, error) {
	definitionHash, err := dataSyncJobApprovalScopeHash(definition)
	if err != nil {
		return "", time.Time{}, time.Time{}, err
	}
	targetFingerprint = strings.TrimSpace(targetFingerprint)
	if targetFingerprint == "" {
		return "", time.Time{}, time.Time{}, errors.New("target endpoint fingerprint is required")
	}
	runtimeName := dataSyncApprovalRuntime(a)
	delay := a.dataSyncJobApprovalDelay
	if delay <= 0 {
		delay = defaultDataSyncJobApprovalDelay
	}
	notBefore := now.Add(delay)
	expiresAt := now.Add(defaultDataSyncJobChallengeTTL)
	challenge := uuid.NewString()
	a.dataSyncJobApprovalMu.Lock()
	if a.dataSyncJobApprovalChallenges == nil {
		a.dataSyncJobApprovalChallenges = make(map[string]dataSyncJobApprovalChallenge)
	}
	for key, entry := range a.dataSyncJobApprovalChallenges {
		if !entry.ExpiresAt.After(now) {
			delete(a.dataSyncJobApprovalChallenges, key)
		}
	}
	a.dataSyncJobApprovalChallenges[challenge] = dataSyncJobApprovalChallenge{
		JobID:             strings.TrimSpace(definition.ID),
		DefinitionHash:    definitionHash,
		TargetFingerprint: targetFingerprint,
		Runtime:           runtimeName,
		NotBefore:         notBefore,
		ExpiresAt:         expiresAt,
	}
	a.dataSyncJobApprovalMu.Unlock()
	return challenge, notBefore, expiresAt, nil
}

func (a *App) confirmDataSyncJobApproval(challenge string, definition syncjob.JobDefinition, targetFingerprint string, now time.Time) (string, syncjob.ExecutionApproval, error) {
	challenge = strings.TrimSpace(challenge)
	if challenge == "" {
		return "", syncjob.ExecutionApproval{}, errors.New("data sync production approval challenge is required")
	}
	definitionHash, err := dataSyncJobApprovalScopeHash(definition)
	if err != nil {
		return "", syncjob.ExecutionApproval{}, err
	}
	a.dataSyncJobApprovalMu.Lock()
	entry, exists := a.dataSyncJobApprovalChallenges[challenge]
	delete(a.dataSyncJobApprovalChallenges, challenge)
	a.dataSyncJobApprovalMu.Unlock()
	if !exists {
		return "", syncjob.ExecutionApproval{}, errors.New("data sync production approval challenge is invalid or was already used")
	}
	if now.Before(entry.NotBefore) {
		return "", syncjob.ExecutionApproval{}, errors.New("data sync production approval countdown has not completed")
	}
	if !entry.ExpiresAt.After(now) {
		return "", syncjob.ExecutionApproval{}, errors.New("data sync production approval challenge has expired")
	}
	if entry.Runtime != dataSyncApprovalRuntime(a) ||
		!secureTextEqual(entry.DefinitionHash, definitionHash) ||
		!secureTextEqual(entry.TargetFingerprint, strings.TrimSpace(targetFingerprint)) {
		return "", syncjob.ExecutionApproval{}, errors.New("data sync production approval challenge does not match the current task")
	}
	return a.issueDataSyncJobApproval(definition, targetFingerprint, now)
}

func dataSyncApprovalRuntime(a *App) string {
	if a != nil && a.webRuntime {
		return "web"
	}
	return "desktop"
}

func (a *App) issueDataSyncJobApproval(definition syncjob.JobDefinition, targetFingerprint string, now time.Time) (string, syncjob.ExecutionApproval, error) {
	definitionHash, err := dataSyncJobApprovalScopeHash(definition)
	if err != nil {
		return "", syncjob.ExecutionApproval{}, err
	}
	targetFingerprint = strings.TrimSpace(targetFingerprint)
	if targetFingerprint == "" {
		return "", syncjob.ExecutionApproval{}, errors.New("target endpoint fingerprint is required")
	}
	runtimeName := dataSyncApprovalRuntime(a)
	approval := syncjob.ExecutionApproval{
		DefinitionHash:    definitionHash,
		TargetFingerprint: targetFingerprint,
		ApprovedAt:        now.UnixMilli(),
		ApprovedByRuntime: runtimeName,
	}
	ttl := a.dataSyncJobApprovalTokenTTL
	if ttl <= 0 {
		ttl = defaultDataSyncJobApprovalTokenTTL
	}
	token := uuid.NewString()
	a.dataSyncJobApprovalMu.Lock()
	if a.dataSyncJobApprovalTokens == nil {
		a.dataSyncJobApprovalTokens = make(map[string]dataSyncJobApprovalToken)
	}
	for key, entry := range a.dataSyncJobApprovalTokens {
		if !entry.ExpiresAt.After(now) {
			delete(a.dataSyncJobApprovalTokens, key)
		}
	}
	a.dataSyncJobApprovalTokens[token] = dataSyncJobApprovalToken{
		JobID:             strings.TrimSpace(definition.ID),
		DefinitionHash:    definitionHash,
		TargetFingerprint: targetFingerprint,
		ApprovedAt:        approval.ApprovedAt,
		ApprovedByRuntime: runtimeName,
		ExpiresAt:         now.Add(ttl),
	}
	a.dataSyncJobApprovalMu.Unlock()
	return token, approval, nil
}

func (a *App) invalidateDataSyncJobApprovals(jobID string) {
	jobID = strings.TrimSpace(jobID)
	if a == nil || jobID == "" {
		return
	}
	a.dataSyncJobApprovalMu.Lock()
	defer a.dataSyncJobApprovalMu.Unlock()
	for key, entry := range a.dataSyncJobApprovalChallenges {
		if entry.JobID == jobID {
			delete(a.dataSyncJobApprovalChallenges, key)
		}
	}
	for key, entry := range a.dataSyncJobApprovalTokens {
		if entry.JobID == jobID {
			delete(a.dataSyncJobApprovalTokens, key)
		}
	}
}

func (a *App) consumeDataSyncJobApproval(token string, definition syncjob.JobDefinition, targetFingerprint string, now time.Time) (syncjob.ExecutionApproval, error) {
	token = strings.TrimSpace(token)
	if token == "" {
		return syncjob.ExecutionApproval{}, errors.New("data sync production approval token is required")
	}
	definitionHash, err := dataSyncJobApprovalScopeHash(definition)
	if err != nil {
		return syncjob.ExecutionApproval{}, err
	}
	a.dataSyncJobApprovalMu.Lock()
	entry, exists := a.dataSyncJobApprovalTokens[token]
	delete(a.dataSyncJobApprovalTokens, token)
	a.dataSyncJobApprovalMu.Unlock()
	if !exists {
		return syncjob.ExecutionApproval{}, errors.New("data sync production approval token is invalid or was already used")
	}
	if !entry.ExpiresAt.After(now) {
		return syncjob.ExecutionApproval{}, errors.New("data sync production approval token has expired")
	}
	if !secureTextEqual(entry.ApprovedByRuntime, dataSyncApprovalRuntime(a)) ||
		!secureTextEqual(entry.DefinitionHash, definitionHash) ||
		!secureTextEqual(entry.TargetFingerprint, strings.TrimSpace(targetFingerprint)) {
		return syncjob.ExecutionApproval{}, errors.New("data sync production approval token does not match the current task")
	}
	return syncjob.ExecutionApproval{
		DefinitionHash:    entry.DefinitionHash,
		TargetFingerprint: entry.TargetFingerprint,
		ApprovedAt:        entry.ApprovedAt,
		ApprovedByRuntime: entry.ApprovedByRuntime,
	}, nil
}

func secureTextEqual(left, right string) bool {
	leftDigest := sha256.Sum256([]byte(left))
	rightDigest := sha256.Sum256([]byte(right))
	return subtle.ConstantTimeCompare(leftDigest[:], rightDigest[:]) == 1
}

func (a *App) validateStoredDataSyncJobApproval(definition syncjob.JobDefinition, targetFingerprint string) error {
	if definition.Approval == nil {
		return errors.New("data sync production approval is missing")
	}
	if !secureTextEqual(definition.Approval.ApprovedByRuntime, dataSyncApprovalRuntime(a)) {
		return errors.New("data sync production approval belongs to a different runtime; run preflight again")
	}
	definitionHash, err := dataSyncJobApprovalScopeHash(definition)
	if err != nil {
		return err
	}
	if !secureTextEqual(definition.Approval.DefinitionHash, definitionHash) ||
		!secureTextEqual(definition.Approval.TargetFingerprint, strings.TrimSpace(targetFingerprint)) {
		return errors.New("data sync production approval is stale; run preflight again")
	}
	return nil
}
