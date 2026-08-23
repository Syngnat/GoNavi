package db

import (
	"strings"
	"unicode"

	"GoNavi-Wails/internal/sqlaudit"
)

// MetadataObjectFailure records a per-object metadata read failure while a
// database-wide metadata request can still return data for other objects.
type MetadataObjectFailure struct {
	ObjectName string
	Err        error
}

// PartialMetadataError indicates that a metadata snapshot contains usable
// data, but one or more individual objects could not be read.
type PartialMetadataError struct {
	warnings []string
}

func (e *PartialMetadataError) Error() string {
	return localizedDriverRuntimeText("db.backend.error.column_summary_partial", nil)
}

// Warnings returns safe, user-facing details for the failed objects.
func (e *PartialMetadataError) Warnings() []string {
	if e == nil || len(e.warnings) == 0 {
		return nil
	}
	return append([]string(nil), e.warnings...)
}

// NewPartialMetadataError aggregates recoverable per-object failures. It
// returns nil when every object was read successfully.
func NewPartialMetadataError(failures []MetadataObjectFailure) *PartialMetadataError {
	if len(failures) == 0 {
		return nil
	}

	warnings := make([]string, 0, len(failures))
	for _, failure := range failures {
		objectName := sanitizeMetadataObjectName(failure.ObjectName)
		if objectName == "" {
			objectName = localizedDriverRuntimeText("db.backend.label.unknown_object", nil)
		}

		detail := localizedDriverRuntimeText("db.backend.error.unknown", nil)
		if failure.Err != nil {
			if sanitized := strings.TrimSpace(sqlaudit.RedactError(failure.Err.Error())); sanitized != "" {
				detail = sanitized
			}
		}

		warnings = append(warnings, localizedDriverRuntimeText("db.backend.warning.object_column_metadata_failed", map[string]any{
			"object": objectName,
			"detail": detail,
		}))
	}
	return &PartialMetadataError{warnings: warnings}
}

func sanitizeMetadataObjectName(value string) string {
	value = strings.ToValidUTF8(value, "?")
	value = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return ' '
		}
		return r
	}, value)
	value = strings.Join(strings.Fields(value), " ")
	const maxObjectNameRunes = 160
	runes := []rune(value)
	if len(runes) <= maxObjectNameRunes {
		return value
	}
	return string(runes[:maxObjectNameRunes]) + "..."
}
