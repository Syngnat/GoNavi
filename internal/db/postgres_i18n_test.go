package db

import (
	"strings"
	"testing"
	"GoNavi-Wails/shared/i18n"
)

var rawPostgresTableNameRequiredText = string([]rune{0x8868, 0x540d, 0x4e0d, 0x80fd, 0x4e3a, 0x7a7a})

func TestPostgresMetadataErrorsUseCurrentLanguage(t *testing.T) {
	SetBackendLanguage(i18n.LanguageEnUS)
	t.Cleanup(func() {
		SetBackendLanguage(i18n.LanguageZhCN)
	})

	postgres := &PostgresDB{}
	tests := []struct {
		name string
		call func() error
	}{
		{
			name: "columns table name required",
			call: func() error {
				_, err := postgres.GetColumns("", " ")
				return err
			},
		},
		{
			name: "indexes table name required",
			call: func() error {
				_, err := postgres.GetIndexes("", " ")
				return err
			},
		},
		{
			name: "foreign keys table name required",
			call: func() error {
				_, err := postgres.GetForeignKeys("", " ")
				return err
			},
		},
		{
			name: "triggers table name required",
			call: func() error {
				_, err := postgres.GetTriggers("", " ")
				return err
			},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			err := tc.call()
			if err == nil {
				t.Fatal("expected PostgreSQL metadata call to fail")
			}
			if err.Error() != "Table name is required" {
				t.Fatalf("expected English table-name-required error, got %q", err.Error())
			}
			if strings.Contains(err.Error(), rawPostgresTableNameRequiredText) {
				t.Fatalf("expected no raw Chinese PostgreSQL metadata text, got %q", err.Error())
			}
		})
	}
}

