//go:build gonavi_full_drivers || gonavi_kingbase_driver

package db

import (
	"errors"
	"strings"
	"testing"
)

func TestKingbaseGetSearchPathStrPropagatesRowErrors(t *testing.T) {
	tests := []struct {
		name      string
		scenario  string
		wantStage string
		wantErr   error
	}{
		{name: "second row scan error", scenario: "scan", wantStage: "扫描用户 schema"},
		{name: "second row iteration error", scenario: "iteration", wantStage: "遍历用户 schema", wantErr: errFakeUserSchemaIteration},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			client := &KingbaseDB{conn: openFakeUserSchemaDB(t, tt.scenario)}
			searchPath, err := client.getSearchPathStr()
			if err == nil {
				t.Fatalf("expected %s error, got search_path=%q", tt.wantStage, searchPath)
			}
			if searchPath != "" {
				t.Fatalf("partial schemas must not be used, got search_path=%q", searchPath)
			}
			if !strings.Contains(err.Error(), tt.wantStage) {
				t.Fatalf("error %q does not identify stage %q", err, tt.wantStage)
			}
			if tt.wantErr != nil && !errors.Is(err, tt.wantErr) {
				t.Fatalf("error %q does not wrap %v", err, tt.wantErr)
			}
		})
	}
}
