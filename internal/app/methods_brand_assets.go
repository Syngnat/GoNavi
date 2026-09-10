package app

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const (
	brandAssetRemoteBaseURL = "https://origin-download.syngnat.top:8443/gonavi/brand-assets/v1"
	brandAssetCacheDirName  = "brand-icons"
	brandAssetMaxBytes      = 4 << 20
)

type brandAssetDefinition struct {
	ID       string
	FileName string
	SHA256   string
}

var brandAssetDefinitions = map[string]brandAssetDefinition{
	"01": {ID: "01", FileName: "01-ribbon-graphite-air.svg", SHA256: "3cab076e113e1722ae6f1dce9f295f3a1d404e4cfb11e76944452e149fcc7b04"},
	"02": {ID: "02", FileName: "02-ribbon-graphite.svg", SHA256: "c1185639143e0212cdb9b4895c57cca5160d722d56afccffbe523994cd353a2e"},
	"03": {ID: "03", FileName: "03-ribbon-graphite-glow.svg", SHA256: "a85f15c0dbe753ac2df2143c1048f0cdc9fa1174ecf2ae8b66e47762ef3659ee"},
	"04": {ID: "04", FileName: "04-ribbon-indigo-light.svg", SHA256: "b040d0b9597cf46e6d16c7a10b876c59126d4cdfcc14b8016c88ac9ccd12cca7"},
	"05": {ID: "05", FileName: "05-ribbon-graphite-light.svg", SHA256: "d8a726f229d9aed116545a361667928979baaf530b181986ed76fe655cb7fd9f"},
	"06": {ID: "06", FileName: "06-ribbon-lilac-dark.svg", SHA256: "f5d11c757a337470a4126e6641eedbd3912eb8932d5000b2dc2d363a409cb4fc"},
}

var brandAssetHTTPClient = &http.Client{Timeout: 30 * time.Second}
var brandAssetRemoteBaseURLForTests = ""
var brandAssetMu sync.Mutex

var (
	errBrandAssetUnknownID = errors.New("unknown brand asset id")
	errBrandAssetInvalid   = errors.New("invalid brand asset")
)

// GetBrandIconDataURL returns a verified brand SVG from the application cache.
// A missing asset is downloaded once from the immutable Bero origin and then
// served locally on subsequent starts.
func (a *App) GetBrandIconDataURL(id string) (string, error) {
	brandAssetMu.Lock()
	defer brandAssetMu.Unlock()
	definition, ok := brandAssetDefinitions[strings.TrimSpace(id)]
	if !ok {
		return "", errBrandAssetUnknownID
	}
	cacheDir := strings.TrimSpace(a.configDir)
	if cacheDir == "" {
		cacheDir = resolveAppConfigDir()
	}
	assetDir := filepath.Join(cacheDir, brandAssetCacheDirName, "v1")
	assetPath := filepath.Join(assetDir, definition.FileName)
	if data, err := readVerifiedBrandAsset(assetPath, definition.SHA256); err == nil {
		return brandAssetDataURL(data), nil
	}

	if err := os.MkdirAll(assetDir, 0o755); err != nil {
		return "", fmt.Errorf("create brand asset cache: %w", err)
	}
	baseURL := brandAssetRemoteBaseURL
	if strings.TrimSpace(brandAssetRemoteBaseURLForTests) != "" {
		baseURL = strings.TrimRight(brandAssetRemoteBaseURLForTests, "/")
	}
	request, err := http.NewRequest(http.MethodGet, baseURL+"/"+definition.FileName, nil)
	if err != nil {
		return "", fmt.Errorf("build brand asset request: %w", err)
	}
	response, err := brandAssetHTTPClient.Do(request)
	if err != nil {
		return "", fmt.Errorf("download brand asset: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return "", fmt.Errorf("download brand asset: unexpected HTTP status %s", response.Status)
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, brandAssetMaxBytes+1))
	if err != nil {
		return "", fmt.Errorf("read brand asset: %w", err)
	}
	if len(data) > brandAssetMaxBytes {
		return "", fmt.Errorf("%w: size exceeds %d bytes", errBrandAssetInvalid, brandAssetMaxBytes)
	}
	if !brandAssetHashMatches(data, definition.SHA256) {
		return "", fmt.Errorf("%w: sha256 mismatch", errBrandAssetInvalid)
	}
	temporary, err := os.CreateTemp(assetDir, ".brand-asset-*.tmp")
	if err != nil {
		return "", fmt.Errorf("create brand asset temp file: %w", err)
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if _, err := temporary.Write(data); err != nil {
		temporary.Close()
		return "", fmt.Errorf("write brand asset cache: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return "", fmt.Errorf("close brand asset cache: %w", err)
	}
	if err := os.Rename(temporaryPath, assetPath); err != nil {
		return "", fmt.Errorf("commit brand asset cache: %w", err)
	}
	return brandAssetDataURL(data), nil
}

func readVerifiedBrandAsset(path string, expectedSHA256 string) ([]byte, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	if len(data) > brandAssetMaxBytes || !brandAssetHashMatches(data, expectedSHA256) {
		return nil, errBrandAssetInvalid
	}
	return data, nil
}

func brandAssetHashMatches(data []byte, expectedSHA256 string) bool {
	hash := sha256.Sum256(data)
	return strings.EqualFold(hex.EncodeToString(hash[:]), expectedSHA256)
}

func brandAssetDataURL(data []byte) string {
	return "data:image/svg+xml;base64," + base64.StdEncoding.EncodeToString(data)
}
