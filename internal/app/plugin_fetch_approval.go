package app

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"sync"
	"time"

	"GoNavi-Wails/internal/plugin"
)

const fetchApprovalLifetime = 10 * time.Minute
const maxFetchApprovals = 4

var (
	errFetchApprovalUnavailable = errors.New("plugin fetch inspection approval unavailable")
	errFetchApprovalExpired     = errors.New("plugin fetch inspection approval expired")
)

// fetchedInstallApproval holds the downloaded archive behind a one-use token, so
// an install can only ever consume the exact bytes the user reviewed.
type fetchedInstallApproval struct {
	token          string
	spec           string
	pluginID       string
	path           string
	contentDigest  string
	previousDigest string
	expires        time.Time
	cleanup        func()
	timer          *time.Timer
	once           sync.Once
}

func (q *fetchedInstallApproval) dispose() {
	if q == nil {
		return
	}
	if q.timer != nil {
		q.timer.Stop()
	}
	q.once.Do(func() {
		if q.cleanup != nil {
			q.cleanup()
		}
	})
}

// PluginRemoteInspection carries the downloaded package inspection plus the
// token that authorizes installing exactly these bytes.
type PluginRemoteInspection struct {
	Inspection     plugin.Inspection  `json:"inspection"`
	Source         pluginRemoteSource `json:"source"`
	ArtifactDigest string             `json:"artifactDigest"`
	ApprovalToken  string             `json:"approvalToken"`
	ExpiresAt      time.Time          `json:"expiresAt"`
}

// pluginRemoteSource tells the UI where the reviewed archive came from.
type pluginRemoteSource struct {
	Kind    string `json:"kind"`
	Spec    string `json:"spec"`
	URL     string `json:"url"`
	Name    string `json:"name"`
	Version string `json:"version"`
}

type pluginFetchState struct {
	mu        sync.Mutex
	approvals map[string]*fetchedInstallApproval
	closing   bool
}

func (s *pluginFetchState) close() {
	s.mu.Lock()
	s.closing = true
	approvals := s.approvals
	s.approvals = nil
	s.mu.Unlock()
	for _, approval := range approvals {
		approval.dispose()
	}
}

func (a *App) registerFetchApproval(ctx context.Context, q *fetchedInstallApproval) (string, error) {
	var entropy [32]byte
	if _, err := rand.Read(entropy[:]); err != nil {
		return "", err
	}
	token := hex.EncodeToString(entropy[:])
	state := &a.plugins.fetch
	state.mu.Lock()
	defer state.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if state.closing || len(state.approvals) >= maxFetchApprovals {
		return "", errors.New("plugin fetch inspection capacity unavailable")
	}
	if state.approvals == nil {
		state.approvals = make(map[string]*fetchedInstallApproval)
	}
	q.token, q.expires = token, time.Now().Add(fetchApprovalLifetime)
	state.approvals[token] = q
	q.timer = time.AfterFunc(fetchApprovalLifetime, func() { a.cancelFetchApproval(token) })
	return token, nil
}

func (a *App) cancelFetchApproval(token string) {
	state := &a.plugins.fetch
	state.mu.Lock()
	q := state.approvals[token]
	delete(state.approvals, token)
	state.mu.Unlock()
	if q != nil {
		q.dispose()
	}
}

func (a *App) takeFetchApproval(ctx context.Context, digest, token string) (*fetchedInstallApproval, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	state := &a.plugins.fetch
	state.mu.Lock()
	q := state.approvals[token]
	if state.closing || ctx.Err() != nil || q == nil || q.contentDigest != digest {
		state.mu.Unlock()
		return nil, errFetchApprovalUnavailable
	}
	delete(state.approvals, token)
	expired := !time.Now().Before(q.expires)
	if q.timer != nil {
		q.timer.Stop()
	}
	state.mu.Unlock()
	if expired {
		q.dispose()
		return nil, errFetchApprovalExpired
	}
	return q, nil
}
