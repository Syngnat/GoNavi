//go:build gonavi_full_drivers || gonavi_dameng_driver

package db

import (
	"strings"
	"time"
)

const (
	damengDateTimeLayout                = "2006-01-02 15:04:05"
	damengDateTimeFractionLayout        = "2006-01-02 15:04:05.999999999"
	damengDateTimeTimezoneLayout        = "2006-01-02 15:04:05Z07:00"
	damengDateTimeFractionTZLayout      = "2006-01-02 15:04:05.999999999Z07:00"
	damengDateTimeSpaceTimezoneLayout   = "2006-01-02 15:04:05 -07:00"
	damengDateTimeSpaceFractionTZLayout = "2006-01-02 15:04:05.999999999 -07:00"
)

// applyColumnMetadata loads the target table's columns once, then derives both
// IDENTITY_INSERT requirements and temporal write types. The metadata lookup
// happens before the write transaction so its query cannot be scheduled onto
// the transaction's pinned connection.
func (d *DamengDB) applyColumnMetadata(schema, table string) (map[string]struct{}, map[string]string, error) {
	columns, err := d.GetColumns(schema, table)
	if err != nil {
		return nil, nil, err
	}
	identityColumns := make(map[string]struct{})
	columnTypes := make(map[string]string, len(columns))
	for _, column := range columns {
		name := strings.ToLower(strings.TrimSpace(column.Name))
		if name == "" {
			continue
		}
		columnTypes[name] = strings.TrimSpace(column.Type)
		if strings.Contains(strings.ToLower(strings.TrimSpace(column.Extra)), "auto_increment") {
			identityColumns[name] = struct{}{}
		}
	}
	return identityColumns, columnTypes, nil
}

func normalizeDamengWriteValue(column string, value interface{}, columnTypes map[string]string) interface{} {
	if len(columnTypes) == 0 {
		return value
	}
	columnType := columnTypes[strings.ToLower(strings.TrimSpace(column))]
	if !isDamengTemporalColumnType(columnType) {
		return value
	}
	return normalizeDamengTemporalWriteValue(value)
}

func isDamengTemporalColumnType(columnType string) bool {
	raw := strings.ToLower(strings.TrimSpace(columnType))
	if raw == "" {
		return false
	}
	if strings.Contains(raw, "timestamp") || strings.Contains(raw, "datetime") {
		return true
	}
	base := raw
	if idx := strings.IndexAny(base, "( "); idx >= 0 {
		base = base[:idx]
	}
	return base == "date" || base == "time"
}

// normalizeDamengTemporalWriteValue accepts the RFC3339 text emitted by the
// grid/JSON boundary. DM's Go driver parses bound strings as space-separated
// timestamps; passing "...T...+08:00" through an exact DATETIME parameter
// can surface as Error -6118. Zoned values become time.Time so the driver
// performs the same timezone conversion as native temporal values; unzoned
// wall-clock text is kept as text so it never acquires an unintended UTC offset.
func normalizeDamengTemporalWriteValue(value interface{}) interface{} {
	text, ok := value.(string)
	if !ok {
		return value
	}
	raw := strings.TrimSpace(text)
	if raw == "" {
		return value
	}

	for _, layout := range []string{
		time.RFC3339Nano,
		time.RFC3339,
		damengDateTimeFractionTZLayout,
		damengDateTimeTimezoneLayout,
		damengDateTimeSpaceFractionTZLayout,
		damengDateTimeSpaceTimezoneLayout,
	} {
		if parsed, err := time.Parse(layout, raw); err == nil {
			return parsed
		}
	}

	candidate := raw
	if len(candidate) > 10 && (candidate[10] == 'T' || candidate[10] == 't') {
		candidate = candidate[:10] + " " + candidate[11:]
	}
	if len(candidate) > 19 && (candidate[19] == '+' || candidate[19] == '-') {
		zoned := candidate[:19] + " " + candidate[19:]
		for _, layout := range []string{damengDateTimeSpaceFractionTZLayout, damengDateTimeSpaceTimezoneLayout} {
			if parsed, err := time.Parse(layout, zoned); err == nil {
				return parsed
			}
		}
	}
	for _, layout := range []string{damengDateTimeFractionLayout, damengDateTimeLayout} {
		if _, err := time.ParseInLocation(layout, candidate, time.Local); err == nil {
			return candidate
		}
	}
	return value
}
