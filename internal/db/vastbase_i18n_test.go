//go:build gonavi_full_drivers || gonavi_vastbase_driver

package db

import (
	"strings"
	"testing"
	"GoNavi-Wails/shared/i18n"
)

var rawVastbaseTableNameRequiredText = string([]rune{0x8868, 0x540d, 0x4e0d, 0x80fd, 0x4e3a, 0x7a7a})

func TestVastbaseMetadataErrorsUseCurrentLanguage(t *testing.T) {
	SetBackendLanguage(i18n.LanguageEnUS)
	t.Cleanup(func() {
		SetBackendLanguage(i18n.LanguageZhCN)
	})

	vastbase := &VastbaseDB{}
	tests := []struct {
		name string
		call func() error
	}{
		{
			name: "columns table name required",
			call: func() error {
				_, err := vastbase.GetColumns("", " ")
				return err
			},
		},
		{
			name: "indexes table name required",
			call: func() error {
				_, err := vastbase.GetIndexes("", " ")
				return err
			},
		},
		{
			name: "foreign keys table name required",
			call: func() error {
				_, err := vastbase.GetForeignKeys("", " ")
				return err
			},
		},
		{
			name: "triggers table name required",
			call: func() error {
				_, err := vastbase.GetTriggers("", " ")
				return err
			},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			err := tc.call()
			if err == nil {
				t.Fatal("expected Vastbase metadata call to fail")
			}
			if err.Error() != "Table name is required" {
				t.Fatalf("expected English table-name-required error, got %q", err.Error())
			}
			if strings.Contains(err.Error(), rawVastbaseTableNameRequiredText) {
				t.Fatalf("expected no raw Chinese Vastbase metadata text, got %q", err.Error())
			}
		})
	}
}

