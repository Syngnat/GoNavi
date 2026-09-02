package app

import (
	"encoding/json"
	"errors"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

const (
	downloadSourceConfigFileName = "download_source.json"

	DownloadSourceCst    DownloadSource = "cst"
	DownloadSourceBero   DownloadSource = "bero"
	DownloadSourceGitHub DownloadSource = "github"
)

// DownloadSource is the user's preferred origin for immutable downloads.
// Other configured sources remain available as failure fallbacks.
type DownloadSource string

type DownloadSourceConfig struct {
	Source string `json:"source"`
}

func normalizeDownloadSource(value string) DownloadSource {
	switch DownloadSource(strings.ToLower(strings.TrimSpace(value))) {
	case DownloadSourceBero:
		return DownloadSourceBero
	case DownloadSourceGitHub:
		return DownloadSourceGitHub
	default:
		return DownloadSourceCst
	}
}

func downloadSourceConfigPath(configDir string) string {
	return filepath.Join(configDir, downloadSourceConfigFileName)
}

func (a *App) preferredDownloadSource() DownloadSource {
	if a == nil {
		return DownloadSourceCst
	}
	a.ensureDownloadSourceLoaded()
	a.downloadSourceMu.RLock()
	source := normalizeDownloadSource(string(a.downloadSource))
	a.downloadSourceMu.RUnlock()
	return source
}

func (a *App) ensureDownloadSourceLoaded() {
	if a == nil {
		return
	}
	a.downloadSourceMu.RLock()
	loaded := a.downloadSourceLoaded
	a.downloadSourceMu.RUnlock()
	if loaded {
		return
	}
	a.loadPersistedDownloadSource()
}

func (a *App) loadPersistedDownloadSource() {
	if a == nil {
		return
	}
	configDir := strings.TrimSpace(a.configDir)
	if configDir == "" {
		configDir = resolveAppConfigDir()
		a.configDir = configDir
	}

	source := DownloadSourceCst
	data, err := os.ReadFile(downloadSourceConfigPath(configDir))
	if err == nil {
		var config DownloadSourceConfig
		if unmarshalErr := json.Unmarshal(data, &config); unmarshalErr == nil {
			source = normalizeDownloadSource(config.Source)
		}
	} else if !os.IsNotExist(err) {
		// A malformed or inaccessible preference must never block downloads.
		err = nil
	}

	a.downloadSourceMu.Lock()
	a.downloadSource = source
	a.downloadSourceLoaded = true
	a.downloadSourceMu.Unlock()
}

// GetDownloadSourceConfig returns the persisted preferred download origin.
func (a *App) GetDownloadSourceConfig() DownloadSourceConfig {
	if a == nil {
		return DownloadSourceConfig{Source: string(DownloadSourceCst)}
	}
	a.ensureDownloadSourceLoaded()
	return DownloadSourceConfig{Source: string(a.preferredDownloadSource())}
}

// SaveDownloadSourceConfig persists the preferred origin. Fallback order is
// derived at request time, so changing this setting applies to new downloads
// without restarting the application.
func (a *App) SaveDownloadSourceConfig(source string) (DownloadSourceConfig, error) {
	if a == nil {
		return DownloadSourceConfig{}, errors.New("application is unavailable")
	}
	preferred := normalizeDownloadSource(source)
	configDir := strings.TrimSpace(a.configDir)
	if configDir == "" {
		configDir = resolveAppConfigDir()
		a.configDir = configDir
	}
	if err := os.MkdirAll(configDir, 0o755); err != nil {
		return DownloadSourceConfig{}, err
	}
	payload, err := json.MarshalIndent(DownloadSourceConfig{Source: string(preferred)}, "", "  ")
	if err != nil {
		return DownloadSourceConfig{}, err
	}
	if err := os.WriteFile(downloadSourceConfigPath(configDir), payload, 0o644); err != nil {
		return DownloadSourceConfig{}, err
	}
	a.downloadSourceMu.Lock()
	a.downloadSource = preferred
	a.downloadSourceLoaded = true
	a.downloadSourceMu.Unlock()
	return DownloadSourceConfig{Source: string(preferred)}, nil
}

func downloadSourceForURL(rawURL string) DownloadSource {
	parsed, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil {
		return ""
	}
	host := strings.ToLower(parsed.Hostname())
	if host == "" {
		return ""
	}
	switch {
	case host == "download.syngnat.top", host == "download-dispatch.syngnat.top":
		return DownloadSourceCst
	case host == "origin-download.syngnat.top":
		return DownloadSourceBero
	case host == "github.com", strings.HasSuffix(host, ".github.com"),
		strings.HasSuffix(host, ".githubusercontent.com"), host == "githubusercontent.com":
		return DownloadSourceGitHub
	default:
		return ""
	}
}

// reorderDownloadCandidates places the selected origin first, then keeps the
// canonical fallback order Cst -> Bero -> GitHub. Unknown explicit URLs stay
// after recognized mirrors in their original order.
func reorderDownloadCandidates(candidates []string, preferred DownloadSource) []string {
	preferred = normalizeDownloadSource(string(preferred))
	order := []DownloadSource{preferred}
	for _, source := range []DownloadSource{DownloadSourceCst, DownloadSourceBero, DownloadSourceGitHub} {
		if source != preferred {
			order = append(order, source)
		}
	}
	rank := make(map[DownloadSource]int, len(order))
	for index, source := range order {
		rank[source] = index
	}
	type candidateWithIndex struct {
		value string
		index int
		rank  int
	}
	items := make([]candidateWithIndex, 0, len(candidates))
	for index, candidate := range candidates {
		source := downloadSourceForURL(candidate)
		itemRank, ok := rank[source]
		if !ok {
			itemRank = len(order)
		}
		items = append(items, candidateWithIndex{value: candidate, index: index, rank: itemRank})
	}
	sort.SliceStable(items, func(left, right int) bool {
		if items[left].rank != items[right].rank {
			return items[left].rank < items[right].rank
		}
		return items[left].index < items[right].index
	})
	result := make([]string, 0, len(items))
	for _, item := range items {
		result = append(result, item.value)
	}
	return result
}
