package app

import (
	"errors"
	"time"
)

const (
	parallelDownloadWorkers       = 8
	parallelDownloadRangeRetries  = 3
	parallelDownloadMinimumSize   = 8 << 20
	parallelDownloadProgressEvery = 120 * time.Millisecond
	parallelDownloadHeaderTimeout = 15 * time.Second
	downloadDispatcherHostname    = "download-dispatch.syngnat.top"
	downloadDispatcherPath        = "/v1/resolve"
	downloadDispatcherMaxResponse = 64 << 10
	downloadCandidateProbeBytes   = 256 << 10
	downloadCandidateProbeTimeout = 15 * time.Second
	downloadCandidateCacheTTL     = 6 * time.Hour
	downloadRegionalBiasRatio     = 1.20
	downloadCstBaseURL            = "https://download.syngnat.top"
	downloadBeroBaseURL           = "https://origin-download.syngnat.top:8443"
)

var errParallelRangeUnsupported = errors.New("download source does not support validated byte ranges")
var errNotImmutableDriverDispatcherAsset = errors.New("not an immutable driver dispatcher asset")
var errNotStaticDispatcherAsset = errors.New("not a static dispatcher asset")
var errInvalidDownloadDispatcherURL = errors.New("invalid download dispatcher URL")

type downloadCurrentAssetMismatchError struct{}

func (downloadCurrentAssetMismatchError) Error() string {
	return "download dispatcher reports that the dev asset is no longer current"
}

// downloadCurrentAssetTerminalError marks an HTTP status returned by the
// Dispatcher itself for a gated dev asset. A Dispatcher 404/410 means that the
// immutable tag is stale and should refresh the manifest; the same status from
// a redirected Cst/Bero origin is an ordinary source failure and must continue
// through the fallback chain.
type downloadCurrentAssetTerminalError struct {
	cause error
}

func (e downloadCurrentAssetTerminalError) Error() string {
	if e.cause == nil {
		return "download dispatcher reports that the dev asset is unavailable"
	}
	return e.cause.Error()
}

func (e downloadCurrentAssetTerminalError) Unwrap() error {
	return e.cause
}
