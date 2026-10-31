package main

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"

	plugin "github.com/Syngnat/GoNavi/sdk/go"
)

func TestManifestMatchesExecutable(t *testing.T) {
	raw, err := os.ReadFile("gonavi.plugin.json")
	if err != nil {
		t.Fatal(err)
	}
	var manifest plugin.Manifest
	if err := json.Unmarshal(raw, &manifest); err != nil {
		t.Fatal(err)
	}
	if manifest.ID != "sdk.examples.aiprovider" || manifest.APIVersion != 1 || manifest.SchemaVersion != 1 || len(manifest.Permissions) != 1 || manifest.Permissions[0] != "ai.providers" {
		t.Fatal("incorrect identity or permissions")
	}
	if manifest.Backend == nil || manifest.Backend.Default == nil || manifest.Backend.Default.Executable != "bin/plugin" || manifest.Backend.Default.Runtime != "native" {
		t.Fatal("manifest does not declare the native executable")
	}
	contributes := manifest.Contributes
	if contributes == nil || len(contributes.AIProviders) != 1 || len(contributes.Commands) != 1 || contributes.Commands[0].ID != "provider" || len(contributes.DataSources) != 0 || len(contributes.Skills) != 0 || len(contributes.Panels) != 0 {
		t.Fatal("unexpected extension surface")
	}
	declaration := contributes.AIProviders[0]
	if declaration.ID != "http" || declaration.Command != "provider" || declaration.Icon != "icons/provider.png" || !declaration.SupportsTools || declaration.SupportsImages || !reflect.DeepEqual(declaration.Models, providerModels()) {
		t.Fatal("manifest does not match the registered provider")
	}
	if err = plugin.ValidateAIProvider(declaration); err != nil {
		t.Fatal(err)
	}
	if "plugin:"+manifest.ID+":"+declaration.ID != "plugin:sdk.examples.aiprovider:http" {
		t.Fatal("unexpected provider type")
	}
}
