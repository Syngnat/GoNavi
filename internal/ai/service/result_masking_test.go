package aiservice

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"GoNavi-Wails/internal/ai"
)

func TestProviderConfigStoreResultMaskingDefaultsForLegacyConfig(t *testing.T) {
	store := newProviderConfigStore(t.TempDir(), failOnUseSecretStore{})
	legacy := aiConfig{SchemaVersion: 5, Providers: []ai.ProviderConfig{}, SafetyLevel: string(ai.PermissionReadOnly), ContextLevel: string(ai.ContextSchemaOnly)}
	data, err := json.Marshal(legacy)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(store.configDir, aiConfigFileName), data, 0o644); err != nil {
		t.Fatal(err)
	}

	snapshot, err := store.Load()
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.ResultMasking.Enabled || len(snapshot.ResultMasking.FullMaskFields) != 0 || len(snapshot.ResultMasking.PartialMaskFields) != 0 {
		t.Fatalf("legacy config must default masking off: %#v", snapshot.ResultMasking)
	}
}

func TestProviderConfigStoreResultMaskingNormalizesAndPersists(t *testing.T) {
	store := newProviderConfigStore(t.TempDir(), failOnUseSecretStore{})
	err := store.Save(ProviderConfigStoreSnapshot{
		Providers: []ai.ProviderConfig{}, SafetyLevel: ai.PermissionReadOnly, ContextLevel: ai.ContextSchemaOnly,
		ResultMasking: ai.ResultMaskingSettings{Enabled: true, FullMaskFields: []string{" phone ", "PHONE", ""}, PartialMaskFields: []string{"email", " Phone ", "EMAIL", ""}},
	})
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := store.Load()
	if err != nil {
		t.Fatal(err)
	}
	want := ai.ResultMaskingSettings{Enabled: true, FullMaskFields: []string{"phone"}, PartialMaskFields: []string{"email"}}
	if !reflect.DeepEqual(snapshot.ResultMasking, want) {
		t.Fatalf("masking settings = %#v, want %#v", snapshot.ResultMasking, want)
	}
}

func TestResultMaskingNormalizationDeduplicatesUnicodeCaseFold(t *testing.T) {
	got := ai.NormalizeResultMaskingSettings(ai.ResultMaskingSettings{
		Enabled:           true,
		FullMaskFields:    []string{"Σ", "ς"},
		PartialMaskFields: []string{"σ"},
	})
	want := ai.ResultMaskingSettings{Enabled: true, FullMaskFields: []string{"Σ"}, PartialMaskFields: []string{}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Unicode case-fold settings = %#v, want %#v", got, want)
	}
}
