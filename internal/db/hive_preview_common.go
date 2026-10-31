package db

import (
	"errors"
	"strings"
)

func hivePreviewUnavailable(err error) string {
	if err == nil {
		err = errors.New("typed Hive metadata is unavailable")
	}
	// The legacy preview DTO has no error channel. Keep failure non-executable
	// and on one comment line rather than falling back to fabricated SQL.
	detail := strings.Join(strings.Fields(err.Error()), " ")
	return "-- Hive change preview unavailable: " + detail
}
