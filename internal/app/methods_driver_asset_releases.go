package app

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
)

func fetchDriverBundleAssetIndex(release *githubRelease) (driverBundleAssetIndex, error) {
	if release == nil {
		return driverBundleAssetIndex{}, newLocalizedDriverBackendError("driver_manager.backend.error.release_empty", nil, nil)
	}
	indexURL := ""
	for _, asset := range release.Assets {
		if strings.EqualFold(strings.TrimSpace(asset.Name), optionalDriverBundleIndexAssetName) {
			indexURL = strings.TrimSpace(asset.BrowserDownloadURL)
			break
		}
	}
	if indexURL == "" {
		return driverBundleAssetIndex{}, newLocalizedDriverBackendError("driver_manager.backend.error.bundle_index_asset_missing", nil, nil)
	}

	client := newStrictHTTPClientWithGlobalProxy(driverReleaseAssetSizeProbeTimeout)
	candidates, resolveErr := resolveDispatcherDownloadCandidates(client, indexURL)
	if resolveErr != nil {
		if errors.Is(resolveErr, errInvalidDownloadDispatcherURL) {
			return driverBundleAssetIndex{}, resolveErr
		}
		candidates = []string{indexURL}
	}
	failures := make([]error, 0, len(candidates)+1)
	if resolveErr != nil {
		failures = append(failures, resolveErr)
	}
	for _, candidate := range candidates {
		index, err := fetchDriverBundleAssetIndexCandidate(client, candidate)
		if err == nil {
			return index, nil
		}
		failures = append(failures, fmt.Errorf("%s: %w", redactDownloadURL(candidate), err))
	}
	return driverBundleAssetIndex{}, errors.Join(failures...)
}

func fetchDriverBundleAssetIndexCandidate(client *http.Client, indexURL string) (driverBundleAssetIndex, error) {
	req, err := http.NewRequest(http.MethodGet, indexURL, nil)
	if err != nil {
		return driverBundleAssetIndex{}, err
	}
	req.Header.Set("User-Agent", "GoNavi-DriverManager")
	req.Header.Set("Accept", "application/json")

	resp, err := client.Do(req)
	if err != nil {
		return driverBundleAssetIndex{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return driverBundleAssetIndex{}, newLocalizedDriverBackendError(
			"driver_manager.backend.error.bundle_index_fetch_failed",
			nil,
			fmt.Errorf("HTTP %d", resp.StatusCode),
		)
	}

	limited := io.LimitReader(resp.Body, driverBundleIndexMaxSize)
	decoder := json.NewDecoder(limited)
	var index driverBundleAssetIndex
	if err := decoder.Decode(&index); err != nil {
		return driverBundleAssetIndex{}, newLocalizedDriverBackendError("driver_manager.backend.error.bundle_index_parse_failed", nil, err)
	}
	if len(index.Assets) == 0 {
		return driverBundleAssetIndex{}, newLocalizedDriverBackendError("driver_manager.backend.error.bundle_index_empty", nil, nil)
	}
	if len(index.AssetSHA256) != len(index.Assets) {
		return driverBundleAssetIndex{}, newLocalizedDriverBackendError("driver_manager.backend.error.bundle_index_parse_failed", nil, errors.New("driver asset SHA256 metadata is incomplete"))
	}
	for name, size := range index.Assets {
		digest := normalizeGitHubAssetSHA256(index.AssetSHA256[name])
		if strings.TrimSpace(name) == "" || size <= 0 || len(digest) != 64 {
			return driverBundleAssetIndex{}, newLocalizedDriverBackendError("driver_manager.backend.error.bundle_index_parse_failed", nil, errors.New("driver asset metadata is invalid"))
		}
		index.AssetSHA256[name] = digest
	}
	return index, nil
}

func fetchLatestReleaseForDriverAssets() (*githubRelease, error) {
	if strings.EqualFold(currentDriverReleaseTag(), driverReleaseDevTag) {
		return fetchReleaseByTag(driverReleaseDevTag)
	}
	if release, err := fetchDriverReleaseIndexByURL("", driverReleaseMirrorLatestIndexURL); err == nil {
		return release, nil
	}
	return fetchDriverReleaseByURL(driverReleaseLatestAPIURL)
}

func resolveLatestPublishedDriverDownloadURL(definition driverDefinition) (string, bool) {
	return resolveLatestPublishedDriverDownloadURLForVersion(definition, "")
}

func resolveLatestPublishedDriverDownloadURLForVersion(definition driverDefinition, selectedVersion string) (string, bool) {
	driverType := normalizeDriverType(definition.Type)
	if driverType == "" {
		return "", false
	}
	assetNames := optionalDriverReleaseZipAssetNamesForVersion(driverType, selectedVersion)
	if len(assetNames) == 0 {
		return "", false
	}

	if sizeByAsset, publishedAssets, ok := readReleaseAssetSizesFromCache("latest"); ok {
		for _, assetName := range assetNames {
			if publishedAssets[assetName] && sizeByAsset[assetName] > 0 {
				if release, err := fetchLatestReleaseForDriverAssets(); err == nil {
					if asset, found := findReleaseAssetByName(release, []string{assetName}); found {
						return driverReleaseAssetAPIURL(asset), true
					}
				}
				return driverReleaseLatestDownloadURLForCurrentChannel(assetName), true
			}
		}
		return driverReleaseLatestDownloadURLForCurrentChannel(assetNames[0]), true
	}

	sizeByAsset, publishedAssets, err := loadReleaseAssetSizesCached("latest", fetchLatestReleaseForDriverAssets)
	if err != nil {
		return driverReleaseLatestDownloadURLForCurrentChannel(assetNames[0]), true
	}
	for _, assetName := range assetNames {
		if publishedAssets[assetName] && sizeByAsset[assetName] > 0 {
			if release, relErr := fetchLatestReleaseForDriverAssets(); relErr == nil {
				if asset, found := findReleaseAssetByName(release, []string{assetName}); found {
					return driverReleaseAssetAPIURL(asset), true
				}
			}
			return driverReleaseLatestDownloadURLForCurrentChannel(assetName), true
		}
	}
	return driverReleaseLatestDownloadURLForCurrentChannel(assetNames[0]), true
}

func fetchReleaseByTag(tag string) (*githubRelease, error) {
	tagName := strings.TrimSpace(tag)
	if tagName == "" {
		return nil, newLocalizedDriverBackendError("driver_manager.backend.error.tag_empty", nil, nil)
	}
	if release, err := fetchMirrorDriverReleaseByTag(tagName); err == nil {
		return release, nil
	}
	apiURL := fmt.Sprintf("https://api.github.com/repos/%s/releases/tags/%s", driverReleaseRepo, url.PathEscape(tagName))
	return fetchDriverReleaseByURL(apiURL)
}

func fetchMirrorDriverReleaseByTag(tag string) (*githubRelease, error) {
	tagName := strings.TrimSpace(tag)
	if tagName == "" {
		return nil, newLocalizedDriverBackendError("driver_manager.backend.error.tag_empty", nil, nil)
	}
	if strings.EqualFold(tagName, driverReleaseDevTag) {
		return fetchDriverReleaseIndexByURL(tagName, driverReleaseMirrorDevLatestIndexURL)
	}
	return fetchDriverReleaseIndexByURL(
		tagName,
		driverMirrorReleaseDownloadURL(tagName, optionalDriverBundleIndexAssetName),
	)
}

func fetchDriverReleaseIndexByURL(tag string, indexURL string) (*githubRelease, error) {
	fallbackTag := strings.TrimSpace(tag)
	indexRelease := &githubRelease{
		TagName: fallbackTag,
		Assets: []githubAsset{{
			Name:               optionalDriverBundleIndexAssetName,
			BrowserDownloadURL: strings.TrimSpace(indexURL),
		}},
	}
	index, err := fetchDriverBundleAssetIndex(indexRelease)
	if err != nil {
		return nil, err
	}
	tagName := strings.TrimSpace(index.TagName)
	if tagName == "" {
		tagName = fallbackTag
	}
	if strings.EqualFold(fallbackTag, driverReleaseDevTag) {
		// dev alias 的逻辑 GitHub 标签固定为 dev-latest；mirrorTagName 仅控制镜像物理路径。
		tagName = driverReleaseDevTag
	}
	if tagName == "" {
		return nil, newLocalizedDriverBackendError("driver_manager.backend.error.tag_empty", nil, nil)
	}
	mirrorTagName := strings.TrimSpace(index.MirrorTagName)
	if mirrorTagName == "" {
		mirrorTagName = tagName
	}
	sizes := index.Assets
	names := make([]string, 0, len(sizes))
	for name := range sizes {
		names = append(names, name)
	}
	sort.Strings(names)
	assets := make([]githubAsset, 0, len(names))
	for _, name := range names {
		trimmedName := strings.TrimSpace(name)
		if trimmedName == "" {
			continue
		}
		assets = append(assets, githubAsset{
			Name:               trimmedName,
			BrowserDownloadURL: driverMirrorReleaseDownloadURLForTags(tagName, mirrorTagName, trimmedName),
			URL:                driverReleaseDownloadURL(tagName, trimmedName),
			Size:               sizes[name],
		})
	}
	return &githubRelease{TagName: tagName, Assets: assets}, nil
}

func fetchDriverReleaseByURL(apiURL string) (*githubRelease, error) {
	urlText := strings.TrimSpace(apiURL)
	if urlText == "" {
		return nil, newLocalizedDriverBackendError("driver_manager.backend.error.api_url_empty", nil, nil)
	}

	client := newStrictHTTPClientWithGlobalProxy(driverReleaseAssetSizeProbeTimeout)
	req, err := http.NewRequest(http.MethodGet, urlText, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "GoNavi-DriverManager")
	req.Header.Set("Accept", "application/vnd.github+json")

	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, newLocalizedDriverBackendError(
			"driver_manager.backend.error.release_info_fetch_failed",
			nil,
			fmt.Errorf("HTTP %d", resp.StatusCode),
		)
	}

	var release githubRelease
	if err := json.NewDecoder(resp.Body).Decode(&release); err != nil {
		return nil, err
	}
	return &release, nil
}
