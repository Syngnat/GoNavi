package pluginfetch

import (
	"encoding/json"
	"fmt"
	"net/url"
	"strings"
)

// npmRegistryHost is the only registry this path talks to; a custom registry or
// mirror is out of scope until the settings surface grows one.
const npmRegistryHost = "registry.npmjs.org"

// NPMDist carries the tarball location and its content hash.
type NPMDist struct {
	Tarball string `json:"tarball"`
	Shasum  string `json:"shasum"`
}

// NPMManifest is the per-version registry document.
type NPMManifest struct {
	Name    string  `json:"name"`
	Version string  `json:"version"`
	Dist    NPMDist `json:"dist"`
}

// RegistryManifestURL builds the registry document URL for a package. A missing
// version (or dist-tag) resolves to /latest. Scoped names must be %2F-encoded.
func RegistryManifestURL(spec Spec) (string, error) {
	if spec.Kind != KindNPM || spec.Name == "" {
		return "", fmt.Errorf("%w: not an npm spec", ErrSpecInvalid)
	}
	encoded := strings.ReplaceAll(spec.Name, "/", "%2F")
	version := spec.Version
	if version == "" {
		version = "latest"
	}
	if !npmVersionPattern.MatchString(version) {
		return "", fmt.Errorf("%w: invalid version %q", ErrSpecInvalid, version)
	}
	return fmt.Sprintf("https://%s/%s/%s", npmRegistryHost, encoded, version), nil
}

// ParseNPMManifest validates a registry document and its tarball location.
func ParseNPMManifest(data []byte) (NPMManifest, error) {
	var manifest NPMManifest
	if err := json.Unmarshal(data, &manifest); err != nil {
		return NPMManifest{}, fmt.Errorf("%w: registry response unparseable", ErrFetchFailed)
	}
	if err := validateNPMName(manifest.Name); err != nil {
		return NPMManifest{}, fmt.Errorf("%w: registry response unparseable", ErrFetchFailed)
	}
	if manifest.Dist.Tarball == "" {
		return NPMManifest{}, fmt.Errorf("%w: registry response has no tarball", ErrFetchFailed)
	}
	if err := ValidateTarballURL(manifest.Dist.Tarball); err != nil {
		return NPMManifest{}, err
	}
	return manifest, nil
}

// ValidateTarballURL keeps the download on the official registry.
func ValidateTarballURL(raw string) error {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme != "https" || strings.ToLower(parsed.Host) != npmRegistryHost {
		return fmt.Errorf("%w: unexpected tarball host", ErrFetchFailed)
	}
	return nil
}
