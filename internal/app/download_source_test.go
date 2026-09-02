package app

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestReorderDownloadCandidatesUsesSelectedSourceAndCanonicalFallbacks(t *testing.T) {
	candidates := []string{
		"https://download.syngnat.top/asset.zip",
		"https://github.com/Syngnat/GoNavi/releases/download/v1/asset.zip",
		"https://origin-download.syngnat.top:8443/asset.zip",
	}
	tests := []struct {
		name      string
		preferred DownloadSource
		want      []string
	}{
		{
			name:      "cst preferred",
			preferred: DownloadSourceCst,
			want:      []string{candidates[0], candidates[2], candidates[1]},
		},
		{
			name:      "bero preferred",
			preferred: DownloadSourceBero,
			want:      []string{candidates[2], candidates[0], candidates[1]},
		},
		{
			name:      "github preferred",
			preferred: DownloadSourceGitHub,
			want:      []string{candidates[1], candidates[0], candidates[2]},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := reorderDownloadCandidates(candidates, test.preferred); !reflect.DeepEqual(got, test.want) {
				t.Fatalf("reordered candidates = %v, want %v", got, test.want)
			}
		})
	}
}

func TestDownloadSourceConfigPersistsAndDefaultsInvalidValuesToCst(t *testing.T) {
	configDir := t.TempDir()
	app := NewApp()
	app.configDir = configDir

	if got := app.GetDownloadSourceConfig(); got.Source != string(DownloadSourceCst) {
		t.Fatalf("default source = %q, want cst", got.Source)
	}
	saved, err := app.SaveDownloadSourceConfig("github")
	if err != nil {
		t.Fatalf("SaveDownloadSourceConfig returned error: %v", err)
	}
	if saved.Source != string(DownloadSourceGitHub) {
		t.Fatalf("saved source = %q, want github", saved.Source)
	}

	restarted := NewApp()
	restarted.configDir = configDir
	if got := restarted.GetDownloadSourceConfig(); got.Source != string(DownloadSourceGitHub) {
		t.Fatalf("restarted source = %q, want github", got.Source)
	}

	if _, err := os.Stat(filepath.Join(configDir, downloadSourceConfigFileName)); err != nil {
		t.Fatalf("download source config was not written: %v", err)
	}
	if got, err := restarted.SaveDownloadSourceConfig("unknown"); err != nil || got.Source != string(DownloadSourceCst) {
		t.Fatalf("invalid source normalization = %#v, err=%v", got, err)
	}
}
