package nacos

import (
	"context"
	"crypto/md5"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const (
	defaultListenTimeoutMs = 30000
	maxListenTimeoutMs     = 60000
	minListenTimeoutMs     = 5000
	nacosV3PollInterval    = 2 * time.Second
)

// ContentMD5 returns the hex MD5 used by Nacos config listening.
func ContentMD5(content string) string {
	sum := md5.Sum([]byte(content))
	return hex.EncodeToString(sum[:])
}

// ListenOnce performs one Nacos config long-poll request.
func (c *ClientImpl) ListenOnce(ctx context.Context, targets []ConfigListenTarget, timeoutMs int) ([]ConfigListenTarget, error) {
	cleaned := make([]ConfigListenTarget, 0, len(targets))
	for _, target := range targets {
		dataID := strings.TrimSpace(target.DataID)
		group := strings.TrimSpace(target.Group)
		if dataID == "" {
			continue
		}
		if group == "" {
			group = "DEFAULT_GROUP"
		}
		cleaned = append(cleaned, ConfigListenTarget{
			NamespaceID: normalizeNamespaceID(target.NamespaceID),
			DataID:      dataID,
			Group:       group,
			ContentMD5:  strings.TrimSpace(target.ContentMD5),
		})
	}
	if len(cleaned) == 0 {
		return nil, localizedNacosBackendError("nacos.backend.error.listen_target_required", nil)
	}

	timeoutMs = normalizeListenTimeoutMs(timeoutMs)
	if c.currentAPIFamily() == nacosAPIV3 {
		return c.listenOnceV3(ctx, cleaned, timeoutMs)
	}
	if err := c.ensureAuth(ctx); err != nil {
		return nil, err
	}

	// Build Listening-Configs packet:
	// dataId\x02group\x02md5\x02tenant\x01  (tenant optional for public)
	var b strings.Builder
	for _, target := range cleaned {
		b.WriteString(target.DataID)
		b.WriteByte(2)
		b.WriteString(target.Group)
		b.WriteByte(2)
		b.WriteString(target.ContentMD5)
		if target.NamespaceID != "" {
			b.WriteByte(2)
			b.WriteString(target.NamespaceID)
		}
		b.WriteByte(1)
	}

	form := url.Values{}
	form.Set("Listening-Configs", b.String())

	// Long poll needs a client timeout larger than Long-Pulling-Timeout.
	listenCtx, cancel := context.WithTimeout(ctx, time.Duration(timeoutMs+10000)*time.Millisecond)
	defer cancel()

	response, err := c.doListenRequestResult(listenCtx, form, timeoutMs)
	if err != nil {
		// Context cancel/deadline is expected when stopping listeners.
		if listenCtx.Err() != nil && (ctx.Err() != nil || listenCtx.Err() == context.DeadlineExceeded) {
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			// Server-side timeout with empty body is normal; treat as no change.
			return []ConfigListenTarget{}, nil
		}
		return nil, err
	}
	if response.status == http.StatusForbidden || response.status == http.StatusUnauthorized {
		retry, authErr := c.reauthenticateAfterUnauthorized(ctx, response.usedToken)
		if authErr != nil {
			return nil, authErr
		}
		if retry {
			response, err = c.doListenRequestResult(listenCtx, form, timeoutMs)
			if err != nil {
				if ctx.Err() != nil {
					return nil, ctx.Err()
				}
				if listenCtx.Err() == context.DeadlineExceeded {
					return []ConfigListenTarget{}, nil
				}
				return nil, err
			}
		}
	}
	if response.status < 200 || response.status >= 300 {
		return nil, localizedNacosBackendError("nacos.backend.error.http_status", map[string]any{
			"status": response.status,
			"body":   truncateForError(string(response.body)),
		})
	}

	changed := parseListenResponse(string(response.body))
	if len(changed) == 0 {
		return []ConfigListenTarget{}, nil
	}
	return changed, nil
}

func (c *ClientImpl) doListenRequest(ctx context.Context, form url.Values, timeoutMs int) ([]byte, int, error) {
	response, err := c.doListenRequestResult(ctx, form, timeoutMs)
	return response.body, response.status, err
}

func (c *ClientImpl) doListenRequestResult(
	ctx context.Context,
	form url.Values,
	timeoutMs int,
) (nacosRawResponse, error) {
	c.mu.Lock()
	baseClient := c.httpClient
	baseURL := c.baseURL
	requestHost := c.requestHost
	token := c.accessToken
	generation := c.lifecycleGeneration
	c.mu.Unlock()
	result := nacosRawResponse{
		usedToken: nacosTokenSnapshot{
			value:      token,
			generation: generation,
		},
	}

	if baseClient == nil || baseURL == nil {
		return result, localizedNacosBackendError("nacos.backend.error.not_connected", nil)
	}

	// Avoid inherited short Timeout from the shared client.
	listenClient := &http.Client{
		Transport: baseClient.Transport,
		// Zero Timeout: rely on request context deadline.
		Timeout: 0,
	}

	rel := &url.URL{Path: joinAPIPath(baseURL.Path, "/v1/cs/configs/listener")}
	query := url.Values{}
	if strings.TrimSpace(token) != "" {
		query.Set("accessToken", token)
	}
	rel.RawQuery = query.Encode()
	fullURL := baseURL.ResolveReference(rel).String()

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, fullURL, strings.NewReader(form.Encode()))
	if err != nil {
		return result, localizedNacosBackendError("nacos.backend.error.build_request", map[string]any{
			"detail": err.Error(),
		})
	}
	if requestHost != "" {
		req.Host = requestHost
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Long-Pulling-Timeout", strconv.Itoa(timeoutMs))
	req.Header.Set("Accept", "*/*")

	resp, err := listenClient.Do(req)
	if err != nil {
		return result, localizedNacosBackendError("nacos.backend.error.request_failed", map[string]any{
			"detail": redactNacosAccessToken(err.Error(), token),
		})
	}
	defer resp.Body.Close()
	result.status = resp.StatusCode

	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return result, localizedNacosBackendError("nacos.backend.error.read_body", map[string]any{
			"detail": err.Error(),
		})
	}
	result.body = body
	return result, nil
}

func parseListenResponse(raw string) []ConfigListenTarget {
	text := strings.TrimSpace(raw)
	if text == "" {
		return nil
	}
	if decoded, err := url.QueryUnescape(text); err == nil {
		text = decoded
	}
	// Response packets are separated by \x01, fields by \x02.
	// Format: dataId\x02group\x02tenant\x01  (tenant optional)
	parts := strings.Split(text, string(byte(1)))
	result := make([]ConfigListenTarget, 0, len(parts))
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		fields := strings.Split(part, string(byte(2)))
		if len(fields) < 2 {
			continue
		}
		dataID := strings.TrimSpace(fields[0])
		group := strings.TrimSpace(fields[1])
		tenant := ""
		if len(fields) >= 3 {
			tenant = strings.TrimSpace(fields[2])
		}
		if dataID == "" {
			continue
		}
		if group == "" {
			group = "DEFAULT_GROUP"
		}
		result = append(result, ConfigListenTarget{
			NamespaceID: normalizeNamespaceID(tenant),
			DataID:      dataID,
			Group:       group,
		})
	}
	return result
}

func (c *ClientImpl) listenOnceV3(
	ctx context.Context,
	targets []ConfigListenTarget,
	timeoutMs int,
) ([]ConfigListenTarget, error) {
	listenCtx, cancel := context.WithTimeout(ctx, time.Duration(timeoutMs)*time.Millisecond)
	defer cancel()
	ticker := time.NewTicker(nacosV3PollInterval)
	defer ticker.Stop()

	for {
		changed, err := c.pollV3ConfigTargets(listenCtx, targets)
		if err != nil {
			if listenCtx.Err() != nil {
				if ctx.Err() != nil {
					return nil, ctx.Err()
				}
				return []ConfigListenTarget{}, nil
			}
			return nil, err
		}
		if len(changed) > 0 {
			return changed, nil
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-listenCtx.Done():
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			return []ConfigListenTarget{}, nil
		case <-ticker.C:
		}
	}
}

func (c *ClientImpl) pollV3ConfigTargets(
	ctx context.Context,
	targets []ConfigListenTarget,
) ([]ConfigListenTarget, error) {
	changed := make([]ConfigListenTarget, 0, len(targets))
	for _, target := range targets {
		params := url.Values{}
		params.Set("dataId", target.DataID)
		params.Set("groupName", target.Group)
		params.Set("namespaceId", normalizeNamespaceID(target.NamespaceID))
		body, status, err := c.doRequest(ctx, http.MethodGet, routesForNacosAPI(nacosAPIV3).config, params, nil)
		if err != nil {
			return nil, err
		}
		if status == http.StatusNotFound {
			if target.ContentMD5 != "" {
				changed = append(changed, target)
			}
			continue
		}
		if status < 200 || status >= 300 {
			return nil, nacosHTTPStatusError(status, body)
		}
		data, err := unwrapNacosResult(body)
		if err != nil {
			return nil, err
		}
		var payload struct {
			Content string `json:"content"`
			MD5     string `json:"md5"`
		}
		if err := json.Unmarshal(data, &payload); err != nil {
			return nil, localizedNacosBackendError("nacos.backend.error.parse_configs", map[string]any{
				"detail": err.Error(),
			})
		}
		remoteMD5 := strings.TrimSpace(payload.MD5)
		if remoteMD5 == "" {
			remoteMD5 = ContentMD5(payload.Content)
		}
		if remoteMD5 != target.ContentMD5 {
			changed = append(changed, target)
		}
	}
	return changed, nil
}

func normalizeListenTimeoutMs(timeoutMs int) int {
	if timeoutMs <= 0 {
		return defaultListenTimeoutMs
	}
	if timeoutMs < minListenTimeoutMs {
		return minListenTimeoutMs
	}
	if timeoutMs > maxListenTimeoutMs {
		return maxListenTimeoutMs
	}
	return timeoutMs
}
