package sync

import (
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
)

func TestHashOnlyIndexTargetGuardRewritesIndexes(t *testing.T) {
	plan := SchemaMigrationPlan{
		IndexesToCreate: 2,
		PostDataSQL: []string{
			"CREATE INDEX `idx_name` ON `orders` (`name`)",
			"CREATE UNIQUE INDEX `ux_code` ON `orders` (`code`)",
			"ALTER TABLE `orders` COMMENT 'x'",
		},
	}
	got := withHashOnlyIndexTargetGuard(SyncConfig{TargetConfig: connection.ConnectionConfig{Type: "gbase8a"}}, plan)
	if len(got.PostDataSQL) != 2 || !strings.HasSuffix(got.PostDataSQL[0], "USING HASH") || strings.Contains(got.PostDataSQL[1], "USING HASH") {
		t.Fatalf("unexpected statements: %#v", got.PostDataSQL)
	}
	if got.IndexesToCreate != 1 || got.IndexesSkipped != 1 || len(got.Warnings) != 1 {
		t.Fatalf("unique index should be skipped with a warning: %+v", got)
	}
	untouched := withHashOnlyIndexTargetGuard(SyncConfig{TargetConfig: connection.ConnectionConfig{Type: "mysql"}}, plan)
	if len(untouched.PostDataSQL) != 3 || untouched.PostDataSQL[0] != plan.PostDataSQL[0] {
		t.Fatalf("other targets must be untouched: %#v", untouched.PostDataSQL)
	}
}
