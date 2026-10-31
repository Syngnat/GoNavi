package app

import (
	"encoding/json"
	"errors"
	"testing"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/importjob"
)

func TestHiveTransferEffectiveModeHashAndPersistence(t *testing.T) {
	config := connection.ConnectionConfig{Type: "hive"}
	legacy := ImportFileOptions{}
	effective := effectiveHiveImportOptions(config, legacy)
	if !effective.LosslessHive || buildImportFileOptionsHash(effective) == buildImportFileOptionsHash(legacy) {
		t.Fatal("effective Hive mode must invalidate legacy checkpoints")
	}
	stored := importJobTableOptionsFromImportFileOptions(effective)
	encoded, err := json.Marshal(stored)
	if err != nil {
		t.Fatal(err)
	}
	var decoded importjob.TableImportOptions
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatal(err)
	}
	restored := importFileOptionsFromImportJobTableOptions(&decoded)
	if !restored.LosslessHive || buildImportFileOptionsHash(restored) != buildImportFileOptionsHash(effective) {
		t.Fatal("persisted effective mode drifted")
	}
	parent := importjob.Job{Kind: importjob.KindTable, TableImportOptions: importJobTableOptionsFromImportFileOptions(legacy), SourceIdentityToken: "source", TargetFingerprint: buildImportTargetFingerprint(config, "db", "t"), OptionsHash: buildImportFileOptionsHash(legacy)}
	err = (&App{}).validateTableImportRecovery(&tableImportRecoveryPlan{ParentJob: parent}, config, "db", "t", legacy, ImportSourceIdentity{Token: "source"})
	if !errors.Is(err, errImportJobRecoveryOptionsChanged) {
		t.Fatalf("legacy Hive checkpoint must fail closed before claim/write: %v", err)
	}
	if effectiveHiveImportOptions(connection.ConnectionConfig{Type: "mysql"}, legacy).LosslessHive {
		t.Fatal("legacy non-Hive mode changed")
	}
}
