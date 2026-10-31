package pluginfetch

import (
	"errors"
	"strings"
	"testing"
)

func TestParse(t *testing.T) {
	tests := []struct {
		name    string
		input   string
		want    Spec
		wantErr error
	}{
		{name: "github latest", input: "github:owner/repo", want: Spec{Kind: KindGitHub, Owner: "owner", Repo: "repo", Raw: "github:owner/repo"}},
		{name: "github tag", input: "github:Owner/My-Plugin@v1.2.3", want: Spec{Kind: KindGitHub, Owner: "Owner", Repo: "My-Plugin", Tag: "v1.2.3", Raw: "github:Owner/My-Plugin@v1.2.3"}},
		{name: "github padded", input: "  GitHub:owner/repo  ", want: Spec{Kind: KindGitHub, Owner: "owner", Repo: "repo", Raw: "GitHub:owner/repo"}},
		{name: "github missing repo", input: "github:owner", wantErr: ErrSpecInvalid},
		{name: "github nested slash", input: "github:owner/repo/extra", wantErr: ErrSpecInvalid},
		{name: "github empty tag", input: "github:owner/repo@", wantErr: ErrSpecInvalid},
		{name: "npm plain", input: "lodash", want: Spec{Kind: KindNPM, Name: "lodash", Raw: "lodash"}},
		{name: "npm version", input: "lodash@4.17.21", want: Spec{Kind: KindNPM, Name: "lodash", Version: "4.17.21", Raw: "lodash@4.17.21"}},
		{name: "npm dist-tag", input: "lodash@next", want: Spec{Kind: KindNPM, Name: "lodash", Version: "next", Raw: "lodash@next"}},
		{name: "npm scoped", input: "@scope/pkg", want: Spec{Kind: KindNPM, Name: "@scope/pkg", Raw: "@scope/pkg"}},
		{name: "npm scoped version", input: "@scope/pkg@1.0.0-beta.1", want: Spec{Kind: KindNPM, Name: "@scope/pkg", Version: "1.0.0-beta.1", Raw: "@scope/pkg@1.0.0-beta.1"}},
		{name: "npm scoped missing name", input: "@scope/", wantErr: ErrSpecInvalid},
		{name: "npm uppercase rejected as npm", input: "Lodash", wantErr: ErrSpecInvalid},
		{name: "npm windows path rejected", input: `C:\plugins\demo`, wantErr: ErrSpecInvalid},
		{name: "npm relative path rejected", input: "dist/plugin.tgz", wantErr: ErrSpecInvalid},
		{name: "npm spaces rejected", input: "my plugin", wantErr: ErrSpecInvalid},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			spec, err := Parse(test.input)
			if test.wantErr != nil {
				if !errors.Is(err, test.wantErr) {
					t.Fatalf("Parse(%q) error = %v, want %v", test.input, err, test.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("Parse(%q) unexpected error: %v", test.input, err)
			}
			if spec != test.want {
				t.Fatalf("Parse(%q) = %+v, want %+v", test.input, spec, test.want)
			}
		})
	}
}

func TestParseGitHubURLs(t *testing.T) {
	tests := []struct {
		name    string
		input   string
		want    Spec
		wantErr error
	}{
		{
			name:  "repo home",
			input: "https://github.com/owner/repo",
			want:  Spec{Kind: KindGitHub, Owner: "owner", Repo: "repo", Raw: "https://github.com/owner/repo"},
		},
		{
			name:  "repo home with trailing slash and .git suffix",
			input: "https://github.com/owner/repo.git/",
			want:  Spec{Kind: KindGitHub, Owner: "owner", Repo: "repo", Raw: "https://github.com/owner/repo.git/"},
		},
		{
			name:  "tree ref",
			input: "https://github.com/owner/repo/tree/v1.2.3",
			want:  Spec{Kind: KindGitHub, Owner: "owner", Repo: "repo", Tag: "v1.2.3", Raw: "https://github.com/owner/repo/tree/v1.2.3"},
		},
		{
			name:  "slash tag",
			input: "https://github.com/owner/repo/tree/release/v1",
			want:  Spec{Kind: KindGitHub, Owner: "owner", Repo: "repo", Tag: "release/v1", Raw: "https://github.com/owner/repo/tree/release/v1"},
		},
		{
			name:  "release tag page",
			input: "https://github.com/owner/repo/releases/tag/v1.2.3",
			want:  Spec{Kind: KindGitHub, Owner: "owner", Repo: "repo", Tag: "v1.2.3", Raw: "https://github.com/owner/repo/releases/tag/v1.2.3"},
		},
		{
			name:  "releases page is latest",
			input: "https://github.com/owner/repo/releases",
			want:  Spec{Kind: KindGitHub, Owner: "owner", Repo: "repo", Raw: "https://github.com/owner/repo/releases"},
		},
		{
			name:  "releases latest page is latest",
			input: "https://github.com/owner/repo/releases/latest",
			want:  Spec{Kind: KindGitHub, Owner: "owner", Repo: "repo", Raw: "https://github.com/owner/repo/releases/latest"},
		},
		{
			name:  "direct download asset",
			input: "https://github.com/owner/repo/releases/download/v1.0.0/gonavi-demo.zip",
			want: Spec{
				Kind: KindGitHub, Owner: "owner", Repo: "repo", Tag: "v1.0.0",
				Asset: "gonavi-demo.zip", AssetURL: "https://github.com/owner/repo/releases/download/v1.0.0/gonavi-demo.zip",
				Raw: "https://github.com/owner/repo/releases/download/v1.0.0/gonavi-demo.zip",
			},
		},
		{
			name:  "direct asset with query and fragment",
			input: "https://github.com/owner/repo/releases/download/v1.0.0/x.tgz?sig=abc#frag",
			want: Spec{
				Kind: KindGitHub, Owner: "owner", Repo: "repo", Tag: "v1.0.0",
				Asset: "x.tgz", AssetURL: "https://github.com/owner/repo/releases/download/v1.0.0/x.tgz",
				Raw: "https://github.com/owner/repo/releases/download/v1.0.0/x.tgz?sig=abc#frag",
			},
		},
		{
			name:  "http upgrades to https",
			input: "http://github.com/owner/repo",
			want:  Spec{Kind: KindGitHub, Owner: "owner", Repo: "repo", Raw: "http://github.com/owner/repo"},
		},
		{
			name:  "missing scheme is assumed https",
			input: "github.com/owner/repo",
			want:  Spec{Kind: KindGitHub, Owner: "owner", Repo: "repo", Raw: "github.com/owner/repo"},
		},
		{
			name:  "www host",
			input: "https://www.github.com/owner/repo",
			want:  Spec{Kind: KindGitHub, Owner: "owner", Repo: "repo", Raw: "https://www.github.com/owner/repo"},
		},
		{name: "foreign host rejected", input: "https://evil.example/owner/repo", wantErr: ErrSpecInvalid},
		{name: "missing repo rejected", input: "https://github.com/owner", wantErr: ErrSpecInvalid},
		{name: "unsupported path rejected", input: "https://github.com/owner/repo/pulls", wantErr: ErrSpecInvalid},
		{name: "incomplete asset url rejected", input: "https://github.com/owner/repo/releases/download/v1/", wantErr: ErrSpecInvalid},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			spec, err := Parse(test.input)
			if test.wantErr != nil {
				if !errors.Is(err, test.wantErr) {
					t.Fatalf("Parse(%q) error = %v, want %v", test.input, err, test.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("Parse(%q) unexpected error: %v", test.input, err)
			}
			if spec != test.want {
				t.Fatalf("Parse(%q) = %+v, want %+v", test.input, spec, test.want)
			}
		})
	}
}

func TestSelectReleaseAsset(t *testing.T) {
	tests := []struct {
		name     string
		release  Release
		wantName string
		wantErr  error
	}{
		{
			name:     "single archive wins",
			release:  Release{Tag: "v1.0.0", Assets: []ReleaseAsset{{Name: "plugin.tgz", URL: "https://github.com/o/r/releases/download/v1.0.0/plugin.tgz"}}},
			wantName: "plugin.tgz",
		},
		{
			name: "gonavi marker disambiguates",
			release: Release{Tag: "v1.0.0", Assets: []ReleaseAsset{
				{Name: "demo.tgz"},
				{Name: "gonavi-plugin.zip"},
			}},
			wantName: "gonavi-plugin.zip",
		},
		{
			name: "no archive is release not found",
			release: Release{Tag: "v1.0.0", Assets: []ReleaseAsset{
				{Name: "checksums.txt"},
				{Name: "plugin.sig"},
			}},
			wantErr: ErrReleaseNotFound,
		},
		{
			name: "ambiguous archives list names",
			release: Release{Tag: "v1.0.0", Assets: []ReleaseAsset{
				{Name: "b.zip"},
				{Name: "a.tgz"},
			}},
			wantErr: ErrAssetAmbiguous,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			asset, err := SelectReleaseAsset(test.release)
			if test.wantErr != nil {
				if !errors.Is(err, test.wantErr) {
					t.Fatalf("SelectReleaseAsset() error = %v, want %v", err, test.wantErr)
				}
				if ambiguity := (*AmbiguityError)(nil); errors.As(err, &ambiguity) && strings.Join(ambiguity.Names, ",") != "a.tgz,b.zip" {
					t.Fatalf("ambiguity names = %v", err)
				}
				return
			}
			if err != nil {
				t.Fatalf("SelectReleaseAsset() unexpected error: %v", err)
			}
			if asset.Name != test.wantName {
				t.Fatalf("asset = %q, want %q", asset.Name, test.wantName)
			}
		})
	}
}

func TestValidateDownloadURL(t *testing.T) {
	valid := []string{
		"https://github.com/owner/repo/releases/download/v1/x.tgz",
		"https://GITHUB.com/owner/repo/releases/download/v1/x.zip",
	}
	for _, raw := range valid {
		if err := ValidateDownloadURL(raw); err != nil {
			t.Errorf("ValidateDownloadURL(%q) unexpected error: %v", raw, err)
		}
	}
	invalid := []string{
		"http://github.com/owner/repo/releases/download/v1/x.tgz",
		"https://evil.example/github.com/x.tgz",
		"https://objects.githubusercontent.com/direct",
		"://broken",
	}
	for _, raw := range invalid {
		if err := ValidateDownloadURL(raw); !errors.Is(err, ErrFetchFailed) {
			t.Errorf("ValidateDownloadURL(%q) error = %v, want ErrFetchFailed", raw, err)
		}
	}
}

func TestRegistryManifestURL(t *testing.T) {
	tests := []struct {
		name string
		spec Spec
		want string
	}{
		{name: "plain latest", spec: Spec{Kind: KindNPM, Name: "lodash"}, want: "https://registry.npmjs.org/lodash/latest"},
		{name: "plain version", spec: Spec{Kind: KindNPM, Name: "lodash", Version: "4.17.21"}, want: "https://registry.npmjs.org/lodash/4.17.21"},
		{name: "scoped encoded", spec: Spec{Kind: KindNPM, Name: "@scope/pkg"}, want: "https://registry.npmjs.org/@scope%2Fpkg/latest"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := RegistryManifestURL(test.spec)
			if err != nil {
				t.Fatalf("RegistryManifestURL() unexpected error: %v", err)
			}
			if got != test.want {
				t.Fatalf("RegistryManifestURL() = %q, want %q", got, test.want)
			}
		})
	}
	if _, err := RegistryManifestURL(Spec{Kind: KindGitHub}); !errors.Is(err, ErrSpecInvalid) {
		t.Fatalf("github spec should be rejected, got %v", err)
	}
}

func TestParseNPMManifest(t *testing.T) {
	t.Run("accepts official tarball with shasum", func(t *testing.T) {
		manifest, err := ParseNPMManifest([]byte(`{"name":"lodash","version":"4.17.21","dist":{"tarball":"https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz","shasum":"abc"}}`))
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if manifest.Dist.Tarball == "" || manifest.Version != "4.17.21" {
			t.Fatalf("manifest = %+v", manifest)
		}
	})
	t.Run("rejects foreign tarball host", func(t *testing.T) {
		_, err := ParseNPMManifest([]byte(`{"name":"pkg","version":"1.0.0","dist":{"tarball":"https://evil.example/pkg.tgz"}}`))
		if !errors.Is(err, ErrFetchFailed) {
			t.Fatalf("error = %v, want ErrFetchFailed", err)
		}
	})
	t.Run("rejects missing tarball", func(t *testing.T) {
		_, err := ParseNPMManifest([]byte(`{"name":"pkg","version":"1.0.0"}`))
		if !errors.Is(err, ErrFetchFailed) {
			t.Fatalf("error = %v, want ErrFetchFailed", err)
		}
	})
	t.Run("rejects garbage", func(t *testing.T) {
		if _, err := ParseNPMManifest([]byte("not json")); !errors.Is(err, ErrFetchFailed) {
			t.Fatalf("error = %v, want ErrFetchFailed", err)
		}
	})
}
