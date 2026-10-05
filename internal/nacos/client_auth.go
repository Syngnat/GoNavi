package nacos

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"time"

	"golang.org/x/sync/singleflight"
)

func (c *ClientImpl) ensureAuth(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}

	c.mu.Lock()
	username := strings.TrimSpace(c.config.User)
	if username == "" {
		c.mu.Unlock()
		return nil
	}
	c.ensureAuthLifecycleLocked()
	if c.accessTokenValidLocked(time.Now()) {
		c.mu.Unlock()
		return nil
	}
	authGroup := c.authGroup
	lifecycleCtx := c.lifecycleCtx
	generation := c.lifecycleGeneration
	c.mu.Unlock()

	resultCh := authGroup.DoChan("login", func() (any, error) {
		c.mu.Lock()
		if c.lifecycleGeneration != generation || c.lifecycleCtx == nil || c.httpClient == nil {
			c.mu.Unlock()
			return nil, context.Canceled
		}
		if c.accessTokenValidLocked(time.Now()) {
			c.mu.Unlock()
			return nil, nil
		}
		loginUser := strings.TrimSpace(c.config.User)
		loginPassword := c.config.Password
		// Cached clients may be shared by operations with different deadlines.
		// The caller context still controls how long that caller waits, while
		// the shared login uses a stable lifecycle timeout so the first
		// connection's short operation timeout cannot poison later refreshes.
		loginTimeout := defaultNacosTimeout
		c.mu.Unlock()

		loginCtx, cancel := context.WithTimeout(lifecycleCtx, loginTimeout)
		defer cancel()
		authResult, err := c.login(loginCtx, loginUser, loginPassword)
		if err != nil {
			return nil, err
		}

		c.mu.Lock()
		defer c.mu.Unlock()
		if c.lifecycleGeneration != generation || c.lifecycleCtx == nil ||
			c.httpClient == nil || lifecycleCtx.Err() != nil {
			return nil, context.Canceled
		}
		c.accessToken = authResult.token
		c.tokenExpiry = authResult.expiry
		c.tokenRefreshAt = authResult.refreshAt
		return nil, nil
	})

	select {
	case <-ctx.Done():
		return ctx.Err()
	case result := <-resultCh:
		return result.Err
	}
}

func (c *ClientImpl) ensureAuthLifecycleLocked() {
	if c.authGroup != nil && c.lifecycleCtx != nil {
		return
	}
	lifecycleCtx, lifecycleCancel := context.WithCancel(context.Background())
	c.lifecycleGeneration++
	c.authGroup = &singleflight.Group{}
	c.lifecycleCtx = lifecycleCtx
	c.lifecycleCancel = lifecycleCancel
}

func (c *ClientImpl) accessTokenValidLocked(now time.Time) bool {
	if c.accessToken == "" {
		return false
	}
	refreshAt := c.tokenRefreshAt
	if refreshAt.IsZero() {
		refreshAt = c.tokenExpiry.Add(-maxTokenRefreshSkew)
	}
	return now.Before(refreshAt)
}

func (c *ClientImpl) login(ctx context.Context, username, password string) (nacosAuthResult, error) {
	query := url.Values{}
	query.Set("username", username)
	form := url.Values{}
	form.Set("password", password)

	var (
		body   []byte
		status int
		err    error
	)
	loginPaths := []string{"/v3/auth/user/login", "/v1/auth/users/login", "/v1/auth/login"}
	for index, loginPath := range loginPaths {
		body, status, err = c.doRequestRaw(ctx, http.MethodPost, loginPath, query, form, false)
		if err != nil {
			return nacosAuthResult{}, err
		}
		if status >= 200 && status < 300 {
			break
		}
		if index < len(loginPaths)-1 && isUnsupportedNacosLogin(status) {
			continue
		}
		return nacosAuthResult{}, localizedNacosBackendError("nacos.backend.error.login_failed", map[string]any{
			"status": status,
			"body":   truncateForError(string(body)),
		})
	}

	var payload struct {
		AccessToken string `json:"accessToken"`
		TokenTtl    int64  `json:"tokenTtl"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return nacosAuthResult{}, localizedNacosBackendError("nacos.backend.error.login_parse", map[string]any{
			"detail": err.Error(),
		})
	}
	token := strings.TrimSpace(payload.AccessToken)
	if token == "" {
		return nacosAuthResult{}, localizedNacosBackendError("nacos.backend.error.login_empty_token", nil)
	}
	ttl := payload.TokenTtl
	if ttl <= 0 {
		ttl = 18000
	}
	issuedAt := time.Now()
	ttlDuration := time.Duration(ttl) * time.Second
	refreshSkew := ttlDuration / 10
	if refreshSkew > maxTokenRefreshSkew {
		refreshSkew = maxTokenRefreshSkew
	}
	expiry := issuedAt.Add(ttlDuration)

	return nacosAuthResult{
		token:     token,
		expiry:    expiry,
		refreshAt: expiry.Add(-refreshSkew),
	}, nil
}

func isUnsupportedNacosLogin(status int) bool {
	return status == http.StatusNotFound ||
		status == http.StatusMethodNotAllowed ||
		status == http.StatusNotImplemented
}
