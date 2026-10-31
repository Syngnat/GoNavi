package pluginfetch

import (
	"fmt"
	"net/url"
	"slices"
	"strings"
)

// ReleaseAsset mirrors the part of a GitHub release asset the download needs.
type ReleaseAsset struct {
	Name string
	URL  string
	Size int64
}

// Release is the neutral view of a GitHub release the selector works on.
type Release struct {
	Tag    string
	Assets []ReleaseAsset
}

// archiveExtensions lists the archive shapes plugin packages may ship in; source
// archives auto-attached by GitHub never appear in the assets array, but checksums
// and signatures do and are excluded by the same filter.
var archiveExtensions = []string{".zip", ".tgz", ".tar.gz"}

// preferredAssetMarker marks assets that are clearly GoNavi plugin packages, so a
// release that also ships unrelated archives stays deterministic.
const preferredAssetMarker = "gonavi"

// SelectReleaseAsset picks the one package asset of a release. Zero usable
// assets is ErrReleaseNotFound; several equally plausible ones are AmbiguityError.
func SelectReleaseAsset(release Release) (ReleaseAsset, error) {
	archives := make([]ReleaseAsset, 0, len(release.Assets))
	for _, asset := range release.Assets {
		if hasArchiveExtension(asset.Name) {
			archives = append(archives, asset)
		}
	}
	if len(archives) == 0 {
		return ReleaseAsset{}, fmt.Errorf("%w: release %q has no zip/tgz asset", ErrReleaseNotFound, release.Tag)
	}
	marked := make([]ReleaseAsset, 0, len(archives))
	for _, asset := range archives {
		if strings.Contains(strings.ToLower(asset.Name), preferredAssetMarker) {
			marked = append(marked, asset)
		}
	}
	if len(marked) > 0 {
		archives = marked
	}
	if len(archives) > 1 {
		names := make([]string, 0, len(archives))
		for _, asset := range archives {
			names = append(names, asset.Name)
		}
		slices.Sort(names)
		return ReleaseAsset{}, &AmbiguityError{Names: names}
	}
	return archives[0], nil
}

func hasArchiveExtension(name string) bool {
	lower := strings.ToLower(strings.TrimSpace(name))
	for _, extension := range archiveExtensions {
		if strings.HasSuffix(lower, extension) {
			return true
		}
	}
	return false
}

// ValidateDownloadURL keeps the download on github.com release assets. The CDN
// redirect target (objects/release-assets.githubusercontent.com) is reached via
// the client's HTTPS-only redirect policy, not chosen by us.
func ValidateDownloadURL(raw string) error {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme != "https" || strings.ToLower(parsed.Host) != "github.com" {
		return fmt.Errorf("%w: unexpected download host", ErrFetchFailed)
	}
	return nil
}
