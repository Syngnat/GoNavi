package app

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
)

func responseIsFromDownloadDispatcher(response *http.Response) bool {
	if response == nil || response.Request == nil || response.Request.URL == nil {
		// A custom RoundTripper may omit Request. Treat the response as direct so
		// malformed or test transports cannot accidentally bypass the stale-asset
		// protection.
		return true
	}
	return strings.EqualFold(response.Request.URL.Hostname(), downloadDispatcherHostname)
}

func gatedDispatcherResponse(rawURL string, response *http.Response) bool {
	return dispatcherURLRequiresCurrentDevAsset(rawURL) && responseIsFromDownloadDispatcher(response)
}

type dispatcherDownloadCandidate struct {
	Source string `json:"source"`
	URL    string `json:"url"`
}

type dispatcherDownloadResponse struct {
	Candidates []dispatcherDownloadCandidate `json:"candidates"`
}

func downloadDispatcherURLForPath(assetPath string) string {
	assetPath = strings.TrimSpace(assetPath)
	if assetPath == "" || !strings.HasPrefix(assetPath, "/") {
		return ""
	}
	query := url.Values{}
	query.Set("path", assetPath)
	return "https://" + downloadDispatcherHostname + downloadDispatcherPath + "?" + query.Encode()
}

func parseDownloadDispatcherAssetPath(rawURL string) (string, bool, error) {
	parsed, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil || parsed == nil || !strings.EqualFold(parsed.Hostname(), downloadDispatcherHostname) {
		return "", false, nil
	}
	if !strings.EqualFold(parsed.Scheme, "https") || parsed.User != nil || parsed.Port() != "" ||
		parsed.EscapedPath() != downloadDispatcherPath || parsed.Fragment != "" {
		return "", true, fmt.Errorf("%w: invalid endpoint", errInvalidDownloadDispatcherURL)
	}
	query, err := url.ParseQuery(parsed.RawQuery)
	if err != nil {
		return "", true, fmt.Errorf("%w: invalid query", errInvalidDownloadDispatcherURL)
	}
	pathValues := query["path"]
	if len(pathValues) != 1 {
		return "", true, fmt.Errorf("%w: exactly one path parameter is required", errInvalidDownloadDispatcherURL)
	}
	assetPath := strings.TrimSpace(pathValues[0])
	if err := validateDownloadDispatcherAssetPath(assetPath); err != nil {
		return "", true, err
	}
	return assetPath, true, nil
}

func validateDownloadDispatcherAssetPath(assetPath string) error {
	if !strings.HasPrefix(assetPath, "/") || strings.HasPrefix(assetPath, "//") || strings.HasSuffix(assetPath, "/") ||
		strings.Contains(assetPath, "%") || strings.Contains(assetPath, "\\") || strings.ContainsRune(assetPath, '\x00') {
		return fmt.Errorf("%w: invalid asset path", errInvalidDownloadDispatcherURL)
	}
	parts := strings.Split(strings.TrimPrefix(assetPath, "/"), "/")
	for _, part := range parts {
		if part == "" || part == "." || part == ".." {
			return fmt.Errorf("%w: invalid asset path segment", errInvalidDownloadDispatcherURL)
		}
	}
	isMutable := assetPath == "/gonavi/releases/latest/latest.json" ||
		assetPath == "/gonavi/dev/releases/latest/latest-dev.json" ||
		assetPath == "/drivers/releases/latest/GoNavi-DriverAgents-Index.json" ||
		assetPath == "/drivers/dev/releases/latest/GoNavi-DriverAgents-Index.json"
	isStableImmutable := len(parts) == 5 && (parts[0] == "gonavi" || parts[0] == "drivers") &&
		parts[1] == "releases" && parts[2] == "download"
	isDevImmutable := len(parts) == 6 && (parts[0] == "gonavi" || parts[0] == "drivers") &&
		parts[1] == "dev" && parts[2] == "releases" && parts[3] == "download"
	if !isMutable && !isStableImmutable && !isDevImmutable {
		return fmt.Errorf("%w: unsupported asset path", errInvalidDownloadDispatcherURL)
	}
	return nil
}

func downloadDispatcherAssetPath(rawURL string) (string, bool) {
	assetPath, recognized, err := parseDownloadDispatcherAssetPath(rawURL)
	return assetPath, recognized && err == nil
}

// staticDriverDispatcherDownloadCandidates derives the immutable driver data
// plane locally. Driver release URLs already contain the exact tag and asset,
// so stale Dispatcher health/KV state must not collapse the fallback chain to
// GitHub only.
func staticDispatcherDownloadCandidates(rawURL string) ([]string, error) {
	assetPath, recognized, err := parseDownloadDispatcherAssetPath(rawURL)
	if !recognized {
		return nil, errNotStaticDispatcherAsset
	}
	if err != nil {
		return nil, err
	}
	var relativePath string
	var githubURL string
	switch assetPath {
	case "/gonavi/releases/latest/latest.json":
		relativePath = assetPath
		githubURL = "https://github.com/Syngnat/GoNavi/releases/latest/download/latest.json"
	case "/gonavi/dev/releases/latest/latest-dev.json":
		relativePath = assetPath
		githubURL = "https://github.com/Syngnat/GoNavi/releases/download/dev-latest/latest-dev.json"
	case "/drivers/releases/latest/GoNavi-DriverAgents-Index.json":
		relativePath = assetPath
		githubURL = "https://github.com/Syngnat/GoNavi-DriverAgents/releases/latest/download/GoNavi-DriverAgents-Index.json"
	case "/drivers/dev/releases/latest/GoNavi-DriverAgents-Index.json":
		relativePath = assetPath
		githubURL = "https://github.com/Syngnat/GoNavi-DriverAgents/releases/download/dev-latest/GoNavi-DriverAgents-Index.json"
	default:
		parts := strings.Split(strings.TrimPrefix(assetPath, "/"), "/")
		isDriver := parts[0] == "drivers"
		isDev := len(parts) == 6 && parts[1] == "dev" && parts[2] == "releases" && parts[3] == "download"
		isStable := len(parts) == 5 && parts[1] == "releases" && parts[2] == "download"
		if (!isDev && !isStable) || (!isDriver && parts[0] != "gonavi") {
			return nil, errNotStaticDispatcherAsset
		}
		tagIndex := 3
		githubTag := parts[tagIndex]
		if isDev {
			tagIndex = 4
			githubTag = "dev-latest"
		}
		assetName := parts[len(parts)-1]
		relativeParts := make([]string, 0, len(parts))
		for _, part := range parts {
			relativeParts = append(relativeParts, url.PathEscape(part))
		}
		relativePath = "/" + strings.Join(relativeParts, "/")
		repository := "Syngnat/GoNavi"
		if isDriver {
			repository = "Syngnat/GoNavi-DriverAgents"
		}
		githubURL = "https://github.com/" + repository + "/releases/download/" +
			url.PathEscape(githubTag) + "/" + url.PathEscape(assetName)
	}
	return []string{
		downloadCstBaseURL + relativePath,
		downloadBeroBaseURL + relativePath,
		githubURL,
	}, nil
}

func staticDriverDispatcherDownloadCandidates(rawURL string) ([]string, error) {
	assetPath, recognized, err := parseDownloadDispatcherAssetPath(rawURL)
	if !recognized {
		return nil, errNotImmutableDriverDispatcherAsset
	}
	if err != nil {
		return nil, err
	}
	parts := strings.Split(strings.TrimPrefix(assetPath, "/"), "/")
	isDev := len(parts) == 6 && parts[0] == "drivers" && parts[1] == "dev" && parts[2] == "releases" && parts[3] == "download"
	isStable := len(parts) == 5 && parts[0] == "drivers" && parts[1] == "releases" && parts[2] == "download"
	if !isDev && !isStable {
		return nil, errNotImmutableDriverDispatcherAsset
	}
	return staticDispatcherDownloadCandidates(rawURL)
}

func downloadDispatcherURLRequiringCurrentDevAsset(rawURL string) string {
	assetPath, ok := downloadDispatcherAssetPath(rawURL)
	if !ok || !strings.HasPrefix(assetPath, "/gonavi/dev/releases/download/") {
		return strings.TrimSpace(rawURL)
	}
	parsed, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil {
		return strings.TrimSpace(rawURL)
	}
	query := parsed.Query()
	query.Set("require-current", "1")
	parsed.RawQuery = query.Encode()
	return parsed.String()
}

func dispatcherURLRequiresCurrentDevAsset(rawURL string) bool {
	assetPath, ok := downloadDispatcherAssetPath(rawURL)
	if !ok || !strings.HasPrefix(assetPath, "/gonavi/dev/releases/download/") {
		return false
	}
	parsed, err := url.Parse(strings.TrimSpace(rawURL))
	return err == nil && parsed.Query().Get("require-current") == "1"
}

func isCurrentDevAssetTerminalError(downloadErr error) bool {
	if downloadErr == nil {
		return false
	}
	if errors.Is(downloadErr, errInvalidDownloadDispatcherURL) {
		return true
	}
	var terminal downloadCurrentAssetTerminalError
	if errors.As(downloadErr, &terminal) {
		return true
	}
	var currentAssetMismatch downloadCurrentAssetMismatchError
	if errors.As(downloadErr, &currentAssetMismatch) {
		return true
	}
	return false
}

func isCurrentAssetTerminalHTTPStatus(status int) bool {
	return status == http.StatusConflict || status == http.StatusNotFound || status == http.StatusGone
}

// markGatedDispatcherTerminalError preserves the current-asset gate when the
// resolver itself answers with an identity status. Errors from redirected
// origins are classified at the response boundary and remain ordinary
// candidate failures so the caller can continue through Cst/Bero/GitHub.
func markGatedDispatcherTerminalError(rawURL string, downloadErr error) (error, bool) {
	if downloadErr == nil || !dispatcherURLRequiresCurrentDevAsset(rawURL) {
		return downloadErr, false
	}
	var terminal downloadCurrentAssetTerminalError
	if errors.As(downloadErr, &terminal) {
		return downloadErr, true
	}
	var localized localizedUpdateError
	if errors.As(downloadErr, &localized) && isCurrentAssetTerminalHTTPStatus(localized.httpStatus) {
		return downloadCurrentAssetTerminalError{cause: downloadErr}, true
	}
	return downloadErr, false
}

func shouldResolveDispatcherFallback(rawURL string, expectedSize int64, downloadErr error) bool {
	if expectedSize <= 0 {
		return false
	}
	if isCurrentDevAssetTerminalError(downloadErr) {
		// A missing or gone gated asset is an identity failure, not a source
		// outage. Keep the existing manifest-refresh path for those responses.
		return false
	}
	_, isDispatcher := downloadDispatcherAssetPath(rawURL)
	return isDispatcher
}

func validatedHTTPSDownloadCandidates(value dispatcherDownloadResponse) []string {
	result := make([]string, 0, len(value.Candidates))
	seen := make(map[string]struct{}, len(value.Candidates))
	for _, candidate := range value.Candidates {
		if len(result) >= 8 {
			break
		}
		rawURL := strings.TrimSpace(candidate.URL)
		parsed, err := url.Parse(rawURL)
		if err != nil || !strings.EqualFold(parsed.Scheme, "https") || parsed.Host == "" || parsed.User != nil || parsed.Fragment != "" {
			continue
		}
		if _, ok := seen[rawURL]; ok {
			continue
		}
		seen[rawURL] = struct{}{}
		result = append(result, rawURL)
	}
	return result
}

func resolveDispatcherDownloadCandidates(client *http.Client, rawURL string) ([]string, error) {
	_, recognized, parseErr := parseDownloadDispatcherAssetPath(rawURL)
	if !recognized {
		return []string{strings.TrimSpace(rawURL)}, nil
	}
	if parseErr != nil {
		return nil, parseErr
	}
	if candidates, err := staticDriverDispatcherDownloadCandidates(rawURL); err == nil {
		return candidates, nil
	} else if !errors.Is(err, errNotImmutableDriverDispatcherAsset) {
		return nil, err
	}
	staticFallback := func(primaryErr error, response *http.Response) ([]string, error) {
		// A gated dev 409/404/410 is an asset-identity signal. Do not bypass it
		// with a locally derived URL; the caller must refresh the manifest first.
		// A response that followed the Dispatcher redirect belongs to the mirror,
		// not to the Dispatcher itself, so its 404/410 must remain an ordinary
		// candidate failure. Network errors have no response and are attributed to
		// the logical Dispatcher request.
		markedErr := primaryErr
		if response == nil || gatedDispatcherResponse(rawURL, response) {
			var terminal bool
			markedErr, terminal = markGatedDispatcherTerminalError(rawURL, primaryErr)
			if terminal {
				return nil, markedErr
			}
		}
		if candidates, staticErr := staticDispatcherDownloadCandidates(rawURL); staticErr == nil {
			return candidates, nil
		}
		return nil, markedErr
	}
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return nil, err
	}
	query := parsed.Query()
	query.Set("format", "json")
	parsed.RawQuery = query.Encode()
	req, err := http.NewRequest(http.MethodGet, parsed.String(), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	resp, err := doUpdateRequest(client, req)
	if err != nil {
		return staticFallback(err, nil)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, downloadDispatcherMaxResponse))
		return staticFallback(classifyGitHubUpdateHTTPError(resp.StatusCode, body, resp.Header, false), resp)
	}
	var value dispatcherDownloadResponse
	decoder := json.NewDecoder(io.LimitReader(resp.Body, downloadDispatcherMaxResponse))
	if err := decoder.Decode(&value); err != nil {
		return staticFallback(fmt.Errorf("decode download dispatcher response: %w", err), resp)
	}
	candidates := validatedHTTPSDownloadCandidates(value)
	if len(candidates) == 0 {
		return staticFallback(errors.New("download dispatcher returned no valid HTTPS candidates"), resp)
	}
	return candidates, nil
}
