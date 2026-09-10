package ai

import (
	"strings"
	"unicode"
)

// ResultMaskingSettings controls masking for data returned by GoNavi's built-in
// AI SQL tool. Field names are global and intentionally not tied to a database
// or table, because result sets do not always retain source metadata.
type ResultMaskingSettings struct {
	Enabled           bool     `json:"enabled"`
	FullMaskFields    []string `json:"fullMaskFields"`
	PartialMaskFields []string `json:"partialMaskFields"`
}

// NormalizeResultMaskingSettings makes persisted rules deterministic. Full
// masking takes precedence when a field occurs in both lists.
func NormalizeResultMaskingSettings(settings ResultMaskingSettings) ResultMaskingSettings {
	full, fullSet := normalizeMaskFieldNames(settings.FullMaskFields, nil)
	partial, _ := normalizeMaskFieldNames(settings.PartialMaskFields, fullSet)
	return ResultMaskingSettings{
		Enabled:           settings.Enabled,
		FullMaskFields:    full,
		PartialMaskFields: partial,
	}
}

func normalizeMaskFieldNames(fields []string, excluded map[string]struct{}) ([]string, map[string]struct{}) {
	seen := make(map[string]struct{}, len(fields))
	for key := range excluded {
		seen[key] = struct{}{}
	}
	result := make([]string, 0, len(fields))
	for _, field := range fields {
		field = strings.TrimSpace(field)
		key := ResultMaskFieldKey(field)
		if key == "" {
			continue
		}
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		result = append(result, field)
	}
	return result, seen
}

// ResultMaskFieldKey returns a deterministic Unicode simple-fold key. Using a
// fold orbit rather than strings.ToLower keeps case-insensitive matches stable
// for characters such as Greek sigma (Σ/σ/ς), whose lowercase forms differ.
func ResultMaskFieldKey(field string) string {
	field = strings.TrimSpace(field)
	return strings.Map(func(r rune) rune {
		canonical := unicode.ToLower(r)
		for folded := unicode.SimpleFold(r); folded != r; folded = unicode.SimpleFold(folded) {
			candidate := unicode.ToLower(folded)
			if candidate < canonical {
				canonical = candidate
			}
		}
		return canonical
	}, field)
}
