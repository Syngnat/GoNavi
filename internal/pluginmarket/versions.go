package pluginmarket

import (
	"context"
	"net/http"
	"runtime"
	"sort"
	"strings"

	"GoNavi-Wails/internal/buildversion"
	"golang.org/x/mod/semver"
)

// VersionChoice contains source-validated metadata and host-owned compatibility results.
type VersionChoice struct {
	Plugin     Item   `json:"plugin"`
	Compatible bool   `json:"compatible"`
	Reason     string `json:"reason,omitempty"`
}

// VersionPage exposes bounded published version history without compatibility exemptions.
type VersionPage struct {
	Versions []VersionChoice `json:"versions"`
	Warning  string          `json:"warning,omitempty"`
}

// Versions validates each published version against the selected source and current host.
func (s *Service) Versions(ctx context.Context, id string) (VersionPage, error) {
	if !validID(id) {
		return VersionPage{}, ErrInvalidRequest
	}
	source, err := s.snapshot()
	if err != nil {
		return VersionPage{}, err
	}
	var items []Item
	err = s.requestJSON(ctx, source, http.MethodGet, "/plugins/"+id+"/versions", nil, nil, &items)
	if err != nil {
		if errorCode(err) != "not_found" {
			return VersionPage{}, err
		}
		item, detailErr := s.Detail(ctx, id)
		if detailErr != nil {
			return VersionPage{}, detailErr
		}
		if err = s.checkSource(source); err != nil {
			return VersionPage{}, err
		}
		return VersionPage{Versions: []VersionChoice{s.versionChoice(item)}, Warning: "versions_unavailable"}, nil
	}
	if len(items) == 0 || len(items) > 100 {
		return VersionPage{}, ErrInvalidResponse
	}
	seen := make(map[string]bool, len(items))
	page := VersionPage{Versions: make([]VersionChoice, 0, len(items))}
	for i := range items {
		if items[i].ID != id || seen[items[i].Version] {
			return VersionPage{}, ErrInvalidResponse
		}
		if err = validateItem(&items[i], source); err != nil {
			return VersionPage{}, err
		}
		seen[items[i].Version] = true
		page.Versions = append(page.Versions, s.versionChoice(items[i]))
	}
	sort.SliceStable(page.Versions, func(i, j int) bool {
		return semver.Compare("v"+page.Versions[i].Plugin.Version, "v"+page.Versions[j].Plugin.Version) > 0
	})
	if err = s.checkSource(source); err != nil {
		return VersionPage{}, err
	}
	return page, nil
}

func (s *Service) versionChoice(item Item) VersionChoice {
	result := VersionChoice{Plugin: item, Compatible: true}
	host := "v" + strings.TrimPrefix(s.hostVersion, "v")
	if item.MinHostVersion != "" {
		minimum := "v" + strings.TrimPrefix(item.MinHostVersion, "v")
		switch {
		case !semver.IsValid(minimum):
			result.Compatible = false
			result.Reason = "invalid_version"
		case buildversion.IsDevelopment(s.hostVersion):
			// Development builds track the newest source, so a released minimum cannot
			// lock them out. The manifest validator still rejects malformed minimums.
		case !semver.IsValid(host):
			result.Compatible = false
			result.Reason = "host_version_unknown"
		case semver.Compare(host, minimum) < 0:
			result.Compatible = false
			result.Reason = "host_version"
		}
	}
	platform := runtime.GOOS + "/" + runtime.GOARCH
	supported := false
	for _, entry := range item.Platforms {
		if entry == "any" || entry == platform {
			supported = true
			break
		}
	}
	if !supported {
		result.Compatible = false
		if result.Reason == "" {
			result.Reason = "platform"
		}
	}
	return result
}
