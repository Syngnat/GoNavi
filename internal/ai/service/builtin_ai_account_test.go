package aiservice

import (
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"GoNavi-Wails/internal/ai"
	"GoNavi-Wails/internal/dailysecret"
)

func builtinTestService(t *testing.T) *Service {
	t.Helper()
	t.Setenv("GONAVI_AI_GATEWAY_URL", "https://ai.example.test")
	s := NewServiceWithSecretStore(nil)
	s.configDir = t.TempDir()
	return s
}

func putBuiltinToken(t *testing.T, s *Service, access, refresh string, expires time.Time) {
	t.Helper()
	if err := s.saveBuiltinAIToken(dailysecret.ProviderBundle{
		APIKey:           access,
		SensitiveHeaders: map[string]string{builtinAIRefreshTokenKey: refresh, builtinAITokenExpiresKey: expires.UTC().Format(time.RFC3339)},
	}); err != nil {
		t.Fatal(err)
	}
}

func stubBuiltinGateway(t *testing.T, handler func(*http.Request) (int, string)) {
	t.Helper()
	previous := builtinAIHTTPDo
	builtinAIHTTPDo = func(req *http.Request) (*http.Response, error) {
		status, body := handler(req)
		if status == 0 {
			return nil, errors.New("dial tcp: connection refused")
		}
		return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(body))}, nil
	}
	t.Cleanup(func() { builtinAIHTTPDo = previous })
}

func TestEnsureBuiltinAIAccessTokenRefreshesOnceForConcurrentCallers(t *testing.T) {
	s := builtinTestService(t)
	putBuiltinToken(t, s, "access-old", "refresh-old", time.Now().Add(-time.Minute))
	var refreshes atomic.Int32
	stubBuiltinGateway(t, func(req *http.Request) (int, string) {
		refreshes.Add(1)
		time.Sleep(20 * time.Millisecond)
		return 200, `{"access_token":"access-new","refresh_token":"refresh-new","token_type":"Bearer","expires_in":3600}`
	})
	config, _ := loadBuiltinAIConfig()

	var wg sync.WaitGroup
	tokens := make([]string, 8)
	for i := range tokens {
		wg.Add(1)
		go func() {
			defer wg.Done()
			bundle, err := s.ensureBuiltinAIAccessToken(config, false)
			if err != nil {
				t.Errorf("ensure: %v", err)
				return
			}
			tokens[i] = bundle.APIKey
		}()
	}
	wg.Wait()
	// The Gateway rotates refresh tokens, so a second refresh with the old one
	// would look like an expired login to the loser of the race.
	if refreshes.Load() != 1 {
		t.Fatalf("refresh requests = %d, want exactly 1", refreshes.Load())
	}
	for _, token := range tokens {
		if token != "access-new" {
			t.Fatalf("tokens = %v", tokens)
		}
	}
}

func TestBuiltinAIStatusDistinguishesExpiredLoginFromNetworkFailure(t *testing.T) {
	s := builtinTestService(t)
	if status, _ := s.AIGetBuiltinAIStatus(); status.State != ai.BuiltinAIStateLoginRequired || status.Authenticated {
		t.Fatalf("no credentials: %+v", status)
	}

	putBuiltinToken(t, s, "a", "r", time.Now().Add(-time.Minute))
	stubBuiltinGateway(t, func(*http.Request) (int, string) { return 0, "" })
	status, _ := s.AIGetBuiltinAIStatus()
	if status.State != ai.BuiltinAIStateNetworkError || !status.Authenticated {
		t.Fatalf("network failure must keep the user signed in: %+v", status)
	}
	if !s.builtinAIHasLocalToken() {
		t.Fatal("network failure must not delete stored credentials")
	}

	stubBuiltinGateway(t, func(*http.Request) (int, string) { return 400, `{"error":"invalid_client"}` })
	if status, _ = s.AIGetBuiltinAIStatus(); status.State == ai.BuiltinAIStateLoginExpired || !s.builtinAIHasLocalToken() {
		t.Fatalf("a bad client id is a configuration problem, not an expired login: %+v", status)
	}

	stubBuiltinGateway(t, func(*http.Request) (int, string) { return 401, `{"error":"invalid_grant"}` })
	status, _ = s.AIGetBuiltinAIStatus()
	if status.State != ai.BuiltinAIStateLoginExpired || status.Authenticated || s.builtinAIHasLocalToken() {
		t.Fatalf("refused refresh token must clear the login: %+v", status)
	}
}

func TestBuiltinAIStatusRetriesOnceWhenGatewayRejectsAValidLookingToken(t *testing.T) {
	s := builtinTestService(t)
	putBuiltinToken(t, s, "access-revoked", "refresh-1", time.Now().Add(time.Hour))
	var quotaCalls int
	stubBuiltinGateway(t, func(req *http.Request) (int, string) {
		if strings.HasSuffix(req.URL.Path, "/oauth/token") {
			return 200, `{"access_token":"access-2","refresh_token":"refresh-2","token_type":"Bearer","expires_in":3600}`
		}
		quotaCalls++
		if req.Header.Get("Authorization") == "Bearer access-2" {
			return 200, `{"dailyTokenLimit":10,"rolling5hTokenLimit":5,"serviceAvailable":true}`
		}
		return 401, `{"error":"invalid_access_token"}`
	})
	status, _ := s.AIGetBuiltinAIStatus()
	if status.State != ai.BuiltinAIStateReady || quotaCalls != 2 {
		t.Fatalf("status=%+v quotaCalls=%d", status, quotaCalls)
	}
}

func TestBuiltinAITokenMigratesFromLegacyProviderKey(t *testing.T) {
	s := builtinTestService(t)
	if err := s.dailySecretStore().PutAIProvider(builtinAILegacyAccountKey, dailysecret.ProviderBundle{
		APIKey: "legacy-access", SensitiveHeaders: map[string]string{builtinAIRefreshTokenKey: "legacy-refresh"},
	}); err != nil {
		t.Fatal(err)
	}
	bundle, ok, err := s.builtinAIToken()
	if err != nil || !ok || bundle.APIKey != "legacy-access" {
		t.Fatalf("legacy token not read: %+v ok=%v err=%v", bundle, ok, err)
	}
	if _, stillThere, _ := s.dailySecretStore().GetAIProvider(builtinAILegacyAccountKey); stillThere {
		t.Fatal("legacy key must be removed after migration so a provider save cannot touch it")
	}
	if moved, ok, _ := s.dailySecretStore().GetAIProvider(builtinAIAccountKey); !ok || moved.APIKey != "legacy-access" {
		t.Fatalf("token not moved to the account key: %+v", moved)
	}
}

func TestBuiltinAIFirstLoginCreatesCompleteProviderAndActivatesIt(t *testing.T) {
	s := builtinTestService(t)
	stubBuiltinGateway(t, func(*http.Request) (int, string) {
		return 200, `{"access_token":"access-1","refresh_token":"refresh-1","token_type":"Bearer","expires_in":3600}`
	})
	result, err := s.AIPollBuiltinAILogin("device-1")
	if err != nil || result.Status != "authorized" {
		t.Fatalf("poll = %+v err=%v", result, err)
	}
	providers := s.AIGetProviders()
	if len(providers) != 1 || providers[0].ID != builtinAIProviderID || !providers[0].HasSecret ||
		providers[0].BaseURL != "https://ai.example.test/v1" || providers[0].Model != "gonavi-sql" {
		t.Fatalf("first login must save a complete provider: %+v", providers)
	}
	if s.AIGetActiveProvider() != builtinAIProviderID {
		t.Fatalf("active provider = %q", s.AIGetActiveProvider())
	}
	// And the next send resolves without any further user action.
	if _, _, err := s.getActiveProviderRuntime(); err != nil {
		t.Fatalf("send path after first login: %v", err)
	}
}

func TestBuiltinAIPollKeepsPollingThroughTransientFailures(t *testing.T) {
	s := builtinTestService(t)
	stubBuiltinGateway(t, func(*http.Request) (int, string) { return 0, "" })
	result, err := s.AIPollBuiltinAILogin("device-1")
	if err != nil || result.Status != "pending" || result.RetryAfterSeconds == 0 {
		t.Fatalf("a dropped poll must not abort the login: %+v err=%v", result, err)
	}
	stubBuiltinGateway(t, func(*http.Request) (int, string) { return 400, `{"error":"slow_down"}` })
	if result, _ = s.AIPollBuiltinAILogin("device-1"); result.Status != "pending" || result.RetryAfterSeconds < 10 {
		t.Fatalf("slow_down must back off: %+v", result)
	}
	stubBuiltinGateway(t, func(*http.Request) (int, string) { return 400, `{"error":"expired_token"}` })
	if result, _ = s.AIPollBuiltinAILogin("device-1"); result.Status != "expired" {
		t.Fatalf("expired_token: %+v", result)
	}
}

func TestBuiltinAILogoutClearsLocallyEvenWhenRevokeFails(t *testing.T) {
	s := builtinTestService(t)
	putBuiltinToken(t, s, "access-1", "refresh-1", time.Now().Add(time.Hour))
	var revoked string
	stubBuiltinGateway(t, func(req *http.Request) (int, string) {
		if strings.HasSuffix(req.URL.Path, "/oauth/revoke") {
			body, _ := io.ReadAll(req.Body)
			revoked = string(body)
		}
		return 0, ""
	})
	if err := s.AILogoutBuiltinAI(); err != nil {
		t.Fatal(err)
	}
	if s.builtinAIHasLocalToken() {
		t.Fatal("logout must clear local credentials")
	}
	if !strings.Contains(revoked, "refresh-1") {
		t.Fatalf("revoke request = %q", revoked)
	}
}

func TestBuiltinAIConnectionTestReportsActionableState(t *testing.T) {
	s := builtinTestService(t)
	provider := ai.ProviderConfig{ID: builtinAIProviderID}
	if result := s.AITestProvider(provider); result["success"] != false || !strings.Contains(result["message"].(string), "GoNavi AI") {
		t.Fatalf("not signed in: %+v", result)
	}
	putBuiltinToken(t, s, "a", "r", time.Now().Add(time.Hour))
	stubBuiltinGateway(t, func(*http.Request) (int, string) {
		return 200, `{"dailyTokensUsed":100,"dailyTokenLimit":100,"rolling5hTokensUsed":1,"rolling5hTokenLimit":50,"dailyResetAt":"2026-10-03T00:00:00+08:00"}`
	})
	if result := s.AITestProvider(provider); result["success"] != false {
		t.Fatalf("an exhausted daily quota must not report success: %+v", result)
	}
	stubBuiltinGateway(t, func(*http.Request) (int, string) {
		return 200, `{"dailyTokenLimit":100,"rolling5hTokenLimit":50,"serviceAvailable":false}`
	})
	if result := s.AITestProvider(provider); result["success"] != false {
		t.Fatalf("no healthy node must not report success: %+v", result)
	}
	stubBuiltinGateway(t, func(*http.Request) (int, string) { return 404, `` })
	if result := s.AITestProvider(provider); result["success"] != false || strings.Contains(result["message"].(string), "file does not exist") {
		t.Fatalf("404: %+v", result)
	}
	stubBuiltinGateway(t, func(*http.Request) (int, string) { return 200, `{"dailyTokenLimit":100,"rolling5hTokenLimit":50}` })
	if result := s.AITestProvider(provider); result["success"] != true {
		t.Fatalf("healthy gateway: %+v", result)
	}
}

func TestBuiltinAIModelDiscoveryNeverNeedsCredentialsOrNetwork(t *testing.T) {
	s := builtinTestService(t)
	stubBuiltinGateway(t, func(*http.Request) (int, string) {
		t.Error("model discovery must not call the network")
		return 500, ``
	})
	partial := ai.ProviderConfig{ID: "provider-legacy", Name: "GoNavi AI", AuthMode: "bearer", HasSecret: true}
	result := s.AIListProviderModels(partial)
	if result["success"] != true || result["models"].([]string)[0] != "gonavi-sql" {
		t.Fatalf("editor model list = %+v", result)
	}
}

func TestBuiltinAIDetectionDoesNotCaptureUnrelatedProviders(t *testing.T) {
	t.Setenv("GONAVI_AI_GATEWAY_URL", "https://ai.example.test")
	for name, cfg := range map[string]ai.ProviderConfig{
		"different name":     {ID: "p1", Name: "My GoNavi AI", AuthMode: "bearer", BaseURL: "https://ai.example.test/v1"},
		"other endpoint":     {ID: "p2", Name: "GoNavi AI", AuthMode: "bearer", BaseURL: "https://api.openai.com/v1"},
		"other model":        {ID: "p3", Name: "GoNavi AI", AuthMode: "bearer", Model: "gpt-x"},
		"api key auth":       {ID: "p4", Name: "GoNavi AI", AuthMode: "api-key"},
		"plain custom entry": {ID: "p5", Name: "Custom", AuthMode: "bearer", BaseURL: "https://ai.example.test/v1"},
	} {
		if isBuiltinAIProviderConfig(cfg) {
			t.Errorf("%s was captured as the built-in provider", name)
		}
	}
	if !isBuiltinAIProviderConfig(ai.ProviderConfig{ID: "legacy", Name: " gonavi ai ", AuthMode: "Bearer", BaseURL: "https://ai.syngnat.top/v1/"}) {
		t.Error("legacy record with the default gateway must be recognized")
	}
}

func TestCanonicalizeBuiltinAIProvidersMergesDuplicatesAndRemapsActive(t *testing.T) {
	s := builtinTestService(t)
	s.providers = []ai.ProviderConfig{
		{ID: "provider-a", Name: "GoNavi AI", AuthMode: "bearer"},
		{ID: "other", Type: "openai", Name: "Other", BaseURL: "https://api.example.test/v1", Model: "m"},
		{ID: "provider-b", Name: "GoNavi AI", AuthMode: "bearer", BaseURL: "https://ai.example.test/v1"},
	}
	s.activeProvider = "provider-b"
	if !s.canonicalizeBuiltinAIProvidersLocked() {
		t.Fatal("expected a change")
	}
	if len(s.providers) != 2 || s.providers[0].ID != builtinAIProviderID || s.providers[1].ID != "other" || s.activeProvider != builtinAIProviderID {
		t.Fatalf("providers=%+v active=%q", s.providers, s.activeProvider)
	}
	if s.canonicalizeBuiltinAIProvidersLocked() {
		t.Fatal("canonicalization must be idempotent, otherwise every startup rewrites the config")
	}
}

func TestLoadBuiltinAIConfigRejectsPlainHTTPForRemoteGateway(t *testing.T) {
	t.Setenv("GONAVI_AI_GATEWAY_URL", "http://ai.example.com")
	if _, err := loadBuiltinAIConfig(); err == nil {
		t.Fatal("credentials must not be sent over plain http to a remote host")
	}
	t.Setenv("GONAVI_AI_GATEWAY_URL", "http://127.0.0.1:8080")
	if _, err := loadBuiltinAIConfig(); err != nil {
		t.Fatalf("loopback http is for local testing: %v", err)
	}
}

func TestBuiltinAIVerificationURLValidation(t *testing.T) {
	config := builtinAIConfig{gatewayURL: "https://ai.example.test"}
	for _, bad := range []string{"javascript:alert(1)", "file:///etc/passwd", "http://evil.example/device", "https://user:pw@ai.example.test/device", "https:///x"} {
		if _, err := validateBuiltinAIVerificationURL(bad, config); err == nil {
			t.Errorf("%q must be rejected", bad)
		}
	}
	if got, err := validateBuiltinAIVerificationURL("https://ai.example.test/device?user_code=ABCD-EFGH", config); err != nil || got == "" {
		t.Fatalf("valid url rejected: %v", err)
	}
	// A Gateway behind a TLS-terminating proxy may advertise its own page as http: upgrade, do not break sign-in.
	if got, err := validateBuiltinAIVerificationURL("http://ai.example.test/device", config); err != nil || got != "https://ai.example.test/device" {
		t.Fatalf("same-host http page must be upgraded to https: %q %v", got, err)
	}
}

func TestBuiltinAIContextProfileIsFixedAndPinnedForTheAgent(t *testing.T) {
	profile := ai.ResolveModelContextProfile("gonavi-sql")
	if profile.DefaultWindow != 4096 || len(profile.Options) != 1 {
		t.Fatalf("profile = %+v", profile)
	}
	pinned := pinBuiltinAIContextLimits(ai.ProviderConfig{ContextWindow: 0, MaxTokens: 16000, ThinkingIntensity: "xhigh", Effort: "max"})
	if pinned.ContextWindow != 4096 || pinned.MaxTokens != 1024 {
		t.Fatalf("a large max_tokens override would leave no prompt room: %+v", pinned)
	}
	if pinned.ThinkingIntensity != "" || pinned.Effort != "" {
		t.Fatalf("the hosted model has no reasoning mode; no level may be sent: %+v", pinned)
	}
}
