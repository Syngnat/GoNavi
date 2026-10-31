package pluginmarket

import (
	"context"
	"fmt"
	"path/filepath"
	"sync/atomic"
)

const maxSources = 32

// SourceConfig is a user-owned endpoint and its explicit network opt-in.
type SourceConfig struct {
	BaseURL string `json:"baseUrl"`
	Enabled bool   `json:"enabled"`
}

// Source describes a saved endpoint; official trust is always release-owned.
type Source struct {
	BaseURL         string `json:"baseUrl"`
	SourceID        string `json:"sourceId"`
	Enabled         bool   `json:"enabled"`
	TrustedOfficial bool   `json:"trustedOfficial"`
}

func (s *Service) initializeSources() error {
	configs := s.state.Sources
	if configs == nil {
		configs = []SourceConfig{}
		if s.officialURL != "" {
			configs = append(configs, SourceConfig{BaseURL: s.officialURL, Enabled: s.state.BaseURL == s.officialURL})
		}
		if s.state.BaseURL != "" && s.state.BaseURL != s.officialURL {
			configs = append(configs, SourceConfig{BaseURL: s.state.BaseURL, Enabled: true})
		}
	} else if s.officialURL != "" {
		found := false
		for _, entry := range configs {
			found = found || entry.BaseURL == s.officialURL
		}
		if !found {
			configs = append([]SourceConfig{{BaseURL: s.officialURL}}, configs...)
		}
	}
	normalized, err := normalizeSources(configs, s.officialURL)
	if err != nil {
		return err
	}
	s.state.Sources = normalized
	s.state.BaseURL = selectedSource(normalized, s.state.BaseURL)
	s.scopes = make(map[string]*Service)
	return nil
}

func normalizeSources(configs []SourceConfig, official string) ([]SourceConfig, error) {
	if len(configs) > maxSources {
		return nil, ErrInvalidRequest
	}
	seen := make(map[string]bool, len(configs))
	result := make([]SourceConfig, 0, len(configs))
	var pinned *SourceConfig
	for _, entry := range configs {
		base, err := normalizeBase(entry.BaseURL)
		if err != nil || base == "" || seen[base] {
			return nil, ErrInvalidRequest
		}
		entry.BaseURL = base
		seen[base] = true
		if base == official {
			copy := entry
			pinned = &copy
		} else {
			result = append(result, entry)
		}
	}
	if official != "" {
		if pinned == nil {
			return nil, ErrInvalidRequest
		}
		result = append([]SourceConfig{*pinned}, result...)
	}
	return result, nil
}

func selectedSource(configs []SourceConfig, previous string) string {
	first := ""
	for _, entry := range configs {
		if !entry.Enabled {
			continue
		}
		if entry.BaseURL == previous {
			return previous
		}
		if first == "" {
			first = entry.BaseURL
		}
	}
	return first
}

// Sources returns public metadata without opening the keychain or contacting endpoints.
func (s *Service) Sources() []Source {
	s.mu.Lock()
	defer s.mu.Unlock()
	result := make([]Source, 0, len(s.state.Sources))
	for _, entry := range s.state.Sources {
		result = append(result, Source{BaseURL: entry.BaseURL, SourceID: sourceID(entry.BaseURL), Enabled: entry.Enabled, TrustedOfficial: entry.BaseURL == s.officialURL && s.officialURL != ""})
	}
	return result
}

// SaveSources atomically replaces the source list, preserving the official entry.
func (s *Service) SaveSources(ctx context.Context, configs []SourceConfig) ([]Source, error) {
	if s.owner != nil {
		return nil, ErrInvalidRequest
	}
	normalized, err := normalizeSources(configs, s.officialURL)
	if err != nil {
		return nil, err
	}
	if err = ctx.Err(); err != nil {
		return nil, err
	}
	s.mu.Lock()
	if err = ctx.Err(); err == nil {
		next := s.state
		next.Sources = normalized
		next.BaseURL = selectedSource(normalized, next.BaseURL)
		if err = atomicJSON(filepath.Join(s.root, "settings.json"), next, maxStateBytes); err == nil {
			s.applySourceStateLocked(next)
		}
	}
	s.mu.Unlock()
	if err != nil {
		return nil, fmt.Errorf("save marketplace sources: %w", err)
	}
	return s.Sources(), nil
}

func (s *Service) applySourceStateLocked(next diskState) {
	enabled := make(map[string]bool, len(next.Sources))
	for _, entry := range next.Sources {
		if entry.Enabled {
			enabled[sourceID(entry.BaseURL)] = true
		}
	}
	for id, scope := range s.scopes {
		if !enabled[id] {
			scope.lease.Store(false)
			delete(s.scopes, id)
		}
	}
	if next.BaseURL != s.state.BaseURL {
		s.generation++
	}
	s.state = next
	s.currentSource.Store(sourceID(next.BaseURL))
}

func legacySourceSelection(configs []SourceConfig, base, official string) ([]SourceConfig, error) {
	next := append([]SourceConfig{}, configs...)
	found := false
	for i := range next {
		next[i].Enabled = base != "" && next[i].BaseURL == base
		found = found || next[i].BaseURL == base
	}
	if base != "" && !found {
		next = append(next, SourceConfig{BaseURL: base, Enabled: true})
	}
	return normalizeSources(next, official)
}

// ForSource returns an immutable, isolated session for one enabled registered endpoint.
// Revoked scopes never become valid again, including when an endpoint is re-enabled.
func (s *Service) ForSource(id string) (*Service, error) {
	if s.owner != nil || !digestPattern.MatchString(id) {
		return nil, ErrInvalidRequest
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	var base string
	for _, entry := range s.state.Sources {
		if entry.Enabled && sourceID(entry.BaseURL) == id {
			base = entry.BaseURL
			break
		}
	}
	if base == "" {
		return nil, ErrNotConfigured
	}
	if existing := s.scopes[id]; existing != nil {
		return existing, nil
	}
	lease := &atomic.Bool{}
	lease.Store(true)
	scope := &Service{root: s.root, client: s.client, downloadClient: s.downloadClient, hostVersion: s.hostVersion, officialURL: s.officialURL,
		state: diskState{Version: 1, BaseURL: base, Installs: make(map[string]installedSource)}, receipts: make(map[string]downloadReceipt), now: s.now, owner: s, lease: lease}
	scope.currentSource.Store(id)
	s.scopes[id] = scope
	return scope, nil
}
