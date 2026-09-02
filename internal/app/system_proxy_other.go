//go:build (darwin && !cgo) || (!darwin && !windows && !linux)

package app

import "net/url"

func resolvePlatformSystemProxy(*url.URL) (*url.URL, error) {
	return nil, nil
}
