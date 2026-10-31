// Package marketfilter defines the bounded public catalog filter contract.
package marketfilter

import (
	"errors"
	"regexp"
	"sort"
	"strings"
	"unicode/utf8"
)

// Version is the acknowledged filter semantics version.
const Version = 1

// ErrInvalid identifies malformed or contradictory filter values.
var ErrInvalid = errors.New("invalid catalog filters")
var platformPattern = regexp.MustCompile(`^[a-z0-9]+/[a-z0-9]+$`)

// Filters combines fields with AND and values within a list with OR.
// Empty Platforms keeps the client's current-platform default; all removes that restriction.
type Filters struct {
	Categories []string `json:"categories"`
	Platforms  []string `json:"platforms"`
	Official   string   `json:"official"`
	Author     string   `json:"author"`
}

// Normalize validates and canonically orders filter sets without modifying input.
func Normalize(value Filters) (Filters, error) {
	if len(value.Categories) > 8 || len(value.Platforms) > 16 || len(value.Author) > 200 || !utf8.ValidString(value.Author) || strings.ContainsRune(value.Author, 0) {
		return Filters{}, ErrInvalid
	}
	if value.Official != "" && value.Official != "official" && value.Official != "community" {
		return Filters{}, ErrInvalid
	}
	categories := make([]string, 0, len(value.Categories))
	seen := map[string]bool{}
	for _, raw := range value.Categories {
		category := strings.TrimSpace(raw)
		switch category {
		case "datasource", "ai-provider", "exporter", "skill", "panel", "command", "ops", "other":
		default:
			return Filters{}, ErrInvalid
		}
		if !seen[category] {
			seen[category] = true
			categories = append(categories, category)
		}
	}
	platforms := make([]string, 0, len(value.Platforms))
	seen = map[string]bool{}
	for _, raw := range value.Platforms {
		platform := strings.TrimSpace(raw)
		if len(platform) > 64 || (platform != "all" && !platformPattern.MatchString(platform)) {
			return Filters{}, ErrInvalid
		}
		if !seen[platform] {
			seen[platform] = true
			platforms = append(platforms, platform)
		}
	}
	if len(platforms) > 1 && seen["all"] {
		return Filters{}, ErrInvalid
	}
	sort.Strings(categories)
	sort.Strings(platforms)
	return Filters{Categories: categories, Platforms: platforms, Official: value.Official, Author: strings.TrimSpace(value.Author)}, nil
}

// PlatformValues returns only concrete platform alternatives for repository queries.
func PlatformValues(value Filters) []string {
	if len(value.Platforms) == 1 && value.Platforms[0] == "all" {
		return []string{}
	}
	return append([]string{}, value.Platforms...)
}

// Active reports whether any explicit condition overrides default browsing.
func Active(value Filters) bool {
	return len(value.Categories) > 0 || len(value.Platforms) > 0 || value.Official != "" || value.Author != ""
}

// Matches checks non-legacy filters against the chosen published version.
func Matches(value Filters, category, author, publisher string, official bool, platforms []string) bool {
	if len(value.Categories) > 0 && !contains(value.Categories, category) {
		return false
	}
	if value.Official == "official" && !official || value.Official == "community" && official {
		return false
	}
	if value.Author != "" && !strings.Contains(strings.ToLower(author+" "+publisher), strings.ToLower(value.Author)) {
		return false
	}
	return MatchesPlatforms(PlatformValues(value), platforms)
}

// MatchesPlatforms applies OR semantics and includes universally supported packages.
func MatchesPlatforms(selected, supported []string) bool {
	if len(selected) == 0 {
		return true
	}
	for _, platform := range supported {
		if platform == "any" || contains(selected, platform) {
			return true
		}
	}
	return false
}
func contains(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}
