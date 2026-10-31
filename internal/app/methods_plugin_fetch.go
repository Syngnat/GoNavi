package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"
	"GoNavi-Wails/internal/plugin"
	"GoNavi-Wails/internal/pluginfetch"
)

const (
	pluginFetchAPITimeout     = 15 * time.Second
	pluginFetchMaxReleaseBody = 4 << 20
	pluginFetchMaxNPMBody     = 2 << 20
)

// PluginRemoteInspect resolves a github:/npm reference, downloads the archive
// into a private temp dir and inspects it. No plugin code runs during any of this.
func (a *App) PluginRemoteInspect(spec string) connection.QueryResult {
	if !a.pluginManagementAllowed() {
		return a.pluginFailure("management_denied")
	}
	parsed, err := pluginfetch.Parse(spec)
	if err != nil {
		return a.pluginFailure("spec_invalid")
	}
	ctx := a.pluginContext()
	manager, err := a.pluginManager(ctx)
	if err != nil {
		return a.pluginFailure("runtime_unavailable")
	}
	value, err := a.fetchAndInspectRemotePackage(ctx, parsed, manager)
	if err != nil {
		return a.pluginFetchFailure(err)
	}
	return connection.QueryResult{Success: true, Data: value}
}

// PluginRemoteInstall consumes a one-use inspection approval, never the raw spec
// or a frontend-supplied path.
func (a *App) PluginRemoteInstall(digest string, trusted bool, approvalToken string) connection.QueryResult {
	if !a.pluginManagementAllowed() {
		return a.pluginFailure("management_denied")
	}
	if !trusted {
		return a.pluginFailure("invalid_request")
	}
	ctx := a.pluginContext()
	approval, err := a.takeFetchApproval(ctx, digest, approvalToken)
	if err != nil {
		if errors.Is(err, errFetchApprovalExpired) {
			return a.pluginFailure("fetch_expired")
		}
		return a.pluginFailure("invalid_request")
	}
	defer approval.dispose()
	manager, err := a.pluginManager(ctx)
	if err != nil {
		return a.pluginFailure("runtime_unavailable")
	}
	a.plugins.mutationMu.Lock()
	defer a.plugins.mutationMu.Unlock()
	installed, current := lookupInstalledPluginDigest(manager, approval.pluginID)
	if current != approval.previousDigest {
		return a.pluginFailure("fetch_stale")
	}
	request := plugin.InstallRequest{Path: approval.path, Digest: approval.contentDigest, Trusted: true}
	status, err := installMarketPackage(ctx, manager, request, installed)
	if err == nil {
		a.forgetPluginMarketSource(ctx, status.Manifest.ID)
	}
	return a.pluginResult(status, err)
}

// PluginRemoteCancelInspection releases a discarded preview and its temp files.
func (a *App) PluginRemoteCancelInspection(token string) connection.QueryResult {
	if !a.pluginManagementAllowed() {
		return a.pluginFailure("management_denied")
	}
	a.cancelFetchApproval(token)
	return connection.QueryResult{Success: true}
}

// lookupInstalledPluginDigest finds the current digest of the given plugin so a
// stale approval cannot silently overwrite a different installation.
func lookupInstalledPluginDigest(manager *plugin.Manager, id string) (bool, string) {
	for _, status := range manager.List() {
		if status.Manifest.ID == id {
			return true, status.Digest
		}
	}
	return false, ""
}

// remotePackageDownload is the resolved, allowlisted download target.
type remotePackageDownload struct {
	URL            string
	Name           string
	Version        string
	ExpectedShasum string
}

func (a *App) fetchAndInspectRemotePackage(ctx context.Context, spec pluginfetch.Spec, manager *plugin.Manager) (PluginRemoteInspection, error) {
	download, err := a.resolveRemotePackage(ctx, spec)
	if err != nil {
		return PluginRemoteInspection{}, err
	}
	dir, err := os.MkdirTemp("", "gonavi-plugin-fetch-")
	if err != nil {
		return PluginRemoteInspection{}, fmt.Errorf("%w: temp dir unavailable", pluginfetch.ErrFetchFailed)
	}
	cleanup := func() { _ = os.RemoveAll(dir) }
	path := filepath.Join(dir, download.Name)
	hash, err := downloadPluginAsset(ctx, download.URL, path)
	if err != nil {
		cleanup()
		if ctxErr := ctx.Err(); ctxErr != nil {
			return PluginRemoteInspection{}, fmt.Errorf("%w: %v", pluginfetch.ErrFetchFailed, ctxErr)
		}
		return PluginRemoteInspection{}, fmt.Errorf("%w: %v", pluginfetch.ErrFetchFailed, err)
	}
	if download.ExpectedShasum != "" && !strings.EqualFold(download.ExpectedShasum, hash) {
		cleanup()
		return PluginRemoteInspection{}, fmt.Errorf("%w: npm shasum mismatch", pluginfetch.ErrFetchFailed)
	}
	inspection, err := manager.Inspect(ctx, path)
	if err != nil {
		cleanup()
		return PluginRemoteInspection{}, fmt.Errorf("%w: %v", pluginfetch.ErrFetchFailed, err)
	}
	_, previousDigest := lookupInstalledPluginDigest(manager, inspection.Manifest.ID)
	approval := &fetchedInstallApproval{spec: spec.Raw, pluginID: inspection.Manifest.ID, path: path, contentDigest: inspection.Digest, previousDigest: previousDigest, cleanup: cleanup}
	if _, err = a.registerFetchApproval(ctx, approval); err != nil {
		cleanup()
		return PluginRemoteInspection{}, fmt.Errorf("%w: %v", pluginfetch.ErrFetchFailed, err)
	}
	inspection.SourcePath = "remote:" + spec.Raw
	return PluginRemoteInspection{
		Inspection:     inspection,
		Source:         pluginRemoteSource{Kind: string(spec.Kind), Spec: spec.Raw, URL: download.URL, Name: download.Name, Version: download.Version},
		ArtifactDigest: hash,
		ApprovalToken:  approval.token,
		ExpiresAt:      approval.expires,
	}, nil
}

func (a *App) resolveRemotePackage(ctx context.Context, spec pluginfetch.Spec) (remotePackageDownload, error) {
	switch spec.Kind {
	case pluginfetch.KindGitHub:
		return a.resolveGitHubReleaseAsset(ctx, spec)
	case pluginfetch.KindNPM:
		return a.resolveNPMTarball(ctx, spec)
	default:
		return remotePackageDownload{}, pluginfetch.ErrSpecInvalid
	}
}

func (a *App) resolveGitHubReleaseAsset(ctx context.Context, spec pluginfetch.Spec) (remotePackageDownload, error) {
	// /releases/download/ 直链：跳过 Release 解析，直接下载指定资产。
	if spec.AssetURL != "" {
		return remotePackageDownload{URL: spec.AssetURL, Name: safeRemoteFileName(spec.Asset), Version: spec.Tag}, nil
	}
	apiURL := fmt.Sprintf("https://api.github.com/repos/%s/%s/releases/latest", url.PathEscape(spec.Owner), url.PathEscape(spec.Repo))
	if spec.Tag != "" {
		apiURL = fmt.Sprintf("https://api.github.com/repos/%s/%s/releases/tags/%s", url.PathEscape(spec.Owner), url.PathEscape(spec.Repo), url.PathEscape(spec.Tag))
	}
	release, err := a.fetchGitHubReleaseJSON(ctx, apiURL)
	if err != nil {
		return remotePackageDownload{}, err
	}
	assets := make([]pluginfetch.ReleaseAsset, 0, len(release.Assets))
	for _, asset := range release.Assets {
		assets = append(assets, pluginfetch.ReleaseAsset{Name: asset.Name, URL: asset.BrowserDownloadURL, Size: asset.Size})
	}
	asset, err := pluginfetch.SelectReleaseAsset(pluginfetch.Release{Tag: release.TagName, Assets: assets})
	if err != nil {
		return remotePackageDownload{}, err
	}
	if err = pluginfetch.ValidateDownloadURL(asset.URL); err != nil {
		return remotePackageDownload{}, err
	}
	return remotePackageDownload{URL: asset.URL, Name: safeRemoteFileName(asset.Name), Version: release.TagName}, nil
}

func (a *App) resolveNPMTarball(ctx context.Context, spec pluginfetch.Spec) (remotePackageDownload, error) {
	manifestURL, err := pluginfetch.RegistryManifestURL(spec)
	if err != nil {
		return remotePackageDownload{}, err
	}
	manifest, err := a.fetchNPMManifest(ctx, manifestURL)
	if err != nil {
		return remotePackageDownload{}, err
	}
	return remotePackageDownload{
		URL:            manifest.Dist.Tarball,
		Name:           safeRemoteFileName(manifest.Dist.Tarball),
		Version:        manifest.Version,
		ExpectedShasum: manifest.Dist.Shasum,
	}, nil
}

func (a *App) fetchGitHubReleaseJSON(ctx context.Context, apiURL string) (*githubRelease, error) {
	client := newStrictHTTPClientWithGlobalProxy(pluginFetchAPITimeout)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, apiURL, nil)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", pluginfetch.ErrFetchFailed, err)
	}
	applyGitHubAPIRequestHeaders(req)
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("%w: github api %v", pluginfetch.ErrFetchFailed, err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode == http.StatusNotFound {
		return nil, pluginfetch.ErrReleaseNotFound
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, pluginFetchMaxReleaseBody))
	if err != nil {
		return nil, fmt.Errorf("%w: github api %v", pluginfetch.ErrFetchFailed, err)
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%w: github api status %d", pluginfetch.ErrFetchFailed, resp.StatusCode)
	}
	var release githubRelease
	if err = json.Unmarshal(body, &release); err != nil {
		return nil, fmt.Errorf("%w: github api %v", pluginfetch.ErrFetchFailed, err)
	}
	return &release, nil
}

func (a *App) fetchNPMManifest(ctx context.Context, manifestURL string) (pluginfetch.NPMManifest, error) {
	client := newStrictHTTPClientWithGlobalProxy(pluginFetchAPITimeout)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, manifestURL, nil)
	if err != nil {
		return pluginfetch.NPMManifest{}, fmt.Errorf("%w: %v", pluginfetch.ErrFetchFailed, err)
	}
	req.Header.Set("User-Agent", "GoNavi-PluginFetcher/"+strings.TrimSpace(getCurrentVersion()))
	req.Header.Set("Accept", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return pluginfetch.NPMManifest{}, fmt.Errorf("%w: npm registry %v", pluginfetch.ErrFetchFailed, err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode == http.StatusNotFound {
		return pluginfetch.NPMManifest{}, pluginfetch.ErrNPMNotFound
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, pluginFetchMaxNPMBody))
	if err != nil {
		return pluginfetch.NPMManifest{}, fmt.Errorf("%w: npm registry %v", pluginfetch.ErrFetchFailed, err)
	}
	if resp.StatusCode != http.StatusOK {
		return pluginfetch.NPMManifest{}, fmt.Errorf("%w: npm registry status %d", pluginfetch.ErrFetchFailed, resp.StatusCode)
	}
	return pluginfetch.ParseNPMManifest(body)
}

// safeRemoteFileName keeps the archive name readable while refusing path
// separators, control characters and everything else the filesystem dislikes.
func safeRemoteFileName(raw string) string {
	name := filepath.Base(strings.TrimSpace(strings.ReplaceAll(raw, "\\", "/")))
	name = strings.Split(name, "?")[0]
	var builder strings.Builder
	for _, char := range name {
		switch {
		case char >= 'a' && char <= 'z', char >= 'A' && char <= 'Z', char >= '0' && char <= '9':
			builder.WriteRune(char)
		case char == '.', char == '-', char == '_':
			builder.WriteRune(char)
		}
	}
	cleaned := strings.Trim(builder.String(), ".-")
	if cleaned == "" {
		return "plugin-package"
	}
	if len(cleaned) > 120 {
		cleaned = cleaned[len(cleaned)-120:]
	}
	return cleaned
}

// pluginFetchFailure maps fetch-stage errors onto plugin backend codes; install-stage
// errors keep flowing through pluginResult so manager semantics stay intact.
func (a *App) pluginFetchFailure(err error) connection.QueryResult {
	switch {
	case errors.Is(err, pluginfetch.ErrSpecInvalid):
		return a.pluginFailure("spec_invalid")
	case errors.Is(err, pluginfetch.ErrReleaseNotFound):
		return a.pluginFailure("release_not_found")
	case errors.Is(err, pluginfetch.ErrNPMNotFound):
		return a.pluginFailure("npm_not_found")
	case errors.Is(err, pluginfetch.ErrAssetAmbiguous):
		names := ""
		var ambiguity *pluginfetch.AmbiguityError
		if errors.As(err, &ambiguity) {
			names = strings.Join(ambiguity.Names, ", ")
		}
		logger.Warnf("Plugin fetch asset ambiguous: %s", names)
		return connection.QueryResult{
			Success: false,
			Message: a.appText("plugin.backend.error.asset_ambiguous", nil),
			Data:    map[string]any{"code": "asset_ambiguous"},
		}
	default:
		logger.Warnf("Plugin fetch failed: %v", err)
		return a.pluginFailure("fetch_failed")
	}
}
