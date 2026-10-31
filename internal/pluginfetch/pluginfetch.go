// Package pluginfetch resolves user-typed remote plugin references
// (github:owner/repo and npm package names) into downloadable archives.
//
// The package is deliberately HTTP-free: it owns spec parsing, release-asset
// selection and registry-manifest validation, while the app layer performs the
// actual requests and downloads with its shared proxy-aware clients. Keeping
// the rules here lets them be tested without network fakes.
package pluginfetch

import (
	"errors"
	"strings"
)

var (
	// ErrSpecInvalid means the input is neither a github:/npm reference nor parseable as one.
	ErrSpecInvalid = errors.New("plugin fetch: invalid spec")
	// ErrReleaseNotFound covers a missing GitHub release and a release without a usable package asset.
	ErrReleaseNotFound = errors.New("plugin fetch: release or package asset not found")
	// ErrAssetAmbiguous means several release assets are equally plausible plugin packages.
	ErrAssetAmbiguous = errors.New("plugin fetch: ambiguous package assets")
	// ErrNPMNotFound means the npm registry has no such package or version.
	ErrNPMNotFound = errors.New("plugin fetch: npm package not found")
	// ErrFetchFailed is the download/network fallback after the specific causes above.
	ErrFetchFailed = errors.New("plugin fetch: download failed")
)

// AmbiguityError lists the equally plausible assets so the UI can show them.
// Is matches ErrAssetAmbiguous so callers can classify with errors.Is.
type AmbiguityError struct {
	Names []string
}

func (e *AmbiguityError) Error() string {
	return "plugin fetch: ambiguous package assets: " + strings.Join(e.Names, ", ")
}

func (e *AmbiguityError) Is(target error) bool {
	return target == ErrAssetAmbiguous
}
