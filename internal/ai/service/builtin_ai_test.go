package aiservice

import (
	"bytes"
	"io"
	"net/http"
	"strings"
	"testing"

	"GoNavi-Wails/internal/ai"
	"GoNavi-Wails/internal/dailysecret"
)

func TestLoadBuiltinAIConfigNormalizesGatewayURL(t *testing.T) {
	t.Setenv("GONAVI_AI_GATEWAY_URL", "https://ai.example.test/v1/")
	t.Setenv("GONAVI_AI_MODEL", "gonavi-sql-test")
	t.Setenv("GONAVI_AI_CLIENT_ID", "desktop-test")

	config, err := loadBuiltinAIConfig()
	if err != nil {
		t.Fatalf("loadBuiltinAIConfig returned error: %v", err)
	}
	if config.gatewayURL != "https://ai.example.test" {
		t.Fatalf("gatewayURL = %q, want normalized URL", config.gatewayURL)
	}
	if config.model != "gonavi-sql-test" || config.clientID != "desktop-test" {
		t.Fatalf("config overrides not applied: %+v", config)
	}
	if config.deviceURL != "https://ai.example.test/oauth/device/code" {
		t.Fatalf("deviceURL = %q", config.deviceURL)
	}
}

func TestLoadBuiltinAIConfigUsesProductionGatewayByDefault(t *testing.T) {
	t.Setenv("GONAVI_AI_GATEWAY_URL", "")
	config, err := loadBuiltinAIConfig()
	if err != nil {
		t.Fatalf("loadBuiltinAIConfig returned error: %v", err)
	}
	if config.gatewayURL != "https://ai.syngnat.top" || config.loginURL != "https://ai.syngnat.top/device" {
		t.Fatalf("default config = %+v", config)
	}
}

func TestNormalizeBuiltinAIProviderConfigRestoresGatewayAddress(t *testing.T) {
	t.Setenv("GONAVI_AI_GATEWAY_URL", "https://ai.example.test")
	config := normalizeBuiltinAIProviderConfig(ai.ProviderConfig{ID: builtinAIProviderID, HasSecret: true})
	if config.BaseURL != "https://ai.example.test/v1" || config.Model != builtinAIDefaultModel || config.AuthMode != "bearer" {
		t.Fatalf("normalized builtin provider = %+v", config)
	}
}

func TestAITestProviderUsesBuiltinGatewayStatus(t *testing.T) {
	t.Setenv("GONAVI_AI_GATEWAY_URL", "https://ai.example.test")
	previous := builtinAIHTTPDo
	builtinAIHTTPDo = func(req *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(`{"dailyTokensUsed":0,"dailyTokenLimit":100,"rolling5hTokensUsed":0,"rolling5hTokenLimit":50}`))}, nil
	}
	t.Cleanup(func() { builtinAIHTTPDo = previous })
	service := NewServiceWithSecretStore(nil)
	service.configDir = t.TempDir()
	if err := service.dailySecretStore().PutAIProvider(builtinAIAccountKey, dailysecret.ProviderBundle{APIKey: "access-1"}); err != nil {
		t.Fatalf("PutAIProvider: %v", err)
	}
	result := service.AITestProvider(ai.ProviderConfig{ID: builtinAIProviderID, HasSecret: true})
	if result["success"] != true || result["checkKind"] != "endpoint" {
		t.Fatalf("builtin test result = %#v", result)
	}
}

func TestAIStartBuiltinAILoginRequestsDeviceCode(t *testing.T) {
	t.Setenv("GONAVI_AI_GATEWAY_URL", "https://ai.example.test")
	var gotMethod string
	var gotURL string
	var gotBody []byte
	previous := builtinAIHTTPDo
	builtinAIHTTPDo = func(req *http.Request) (*http.Response, error) {
		gotMethod = req.Method
		gotURL = req.URL.String()
		gotBody, _ = io.ReadAll(req.Body)
		return &http.Response{
			StatusCode: http.StatusOK,
			Body:       io.NopCloser(strings.NewReader(`{"device_code":"device-1","user_code":"ABCD-EFGH","verification_uri":"https://ai.example.test/device","expires_in":600,"interval":4}`)),
		}, nil
	}
	t.Cleanup(func() { builtinAIHTTPDo = previous })

	service := NewServiceWithSecretStore(nil)
	device, err := service.AIStartBuiltinAILogin()
	if err != nil {
		t.Fatalf("AIStartBuiltinAILogin returned error: %v", err)
	}
	if gotMethod != http.MethodPost || gotURL != "https://ai.example.test/oauth/device/code" {
		t.Fatalf("request = %s %s", gotMethod, gotURL)
	}
	if !bytes.Contains(gotBody, []byte(`"client_id":"gonavi-desktop"`)) {
		t.Fatalf("request body did not contain client id: %s", gotBody)
	}
	if device.DeviceCode != "device-1" || device.UserCode != "ABCD-EFGH" || device.IntervalSeconds != 4 {
		t.Fatalf("unexpected device code: %+v", device)
	}
}

func TestAIPollBuiltinAILoginPersistsToken(t *testing.T) {
	t.Setenv("GONAVI_AI_GATEWAY_URL", "https://ai.example.test")
	previous := builtinAIHTTPDo
	builtinAIHTTPDo = func(req *http.Request) (*http.Response, error) {
		if req.URL.Path != "/oauth/token" {
			t.Fatalf("unexpected token URL: %s", req.URL)
		}
		return &http.Response{
			StatusCode: http.StatusOK,
			Body:       io.NopCloser(strings.NewReader(`{"access_token":"access-1","refresh_token":"refresh-1","token_type":"Bearer","expires_in":3600}`)),
		}, nil
	}
	t.Cleanup(func() { builtinAIHTTPDo = previous })

	service := NewServiceWithSecretStore(nil)
	service.configDir = t.TempDir()
	result, err := service.AIPollBuiltinAILogin("device-1")
	if err != nil {
		t.Fatalf("AIPollBuiltinAILogin returned error: %v", err)
	}
	if result.Status != "authorized" || !result.Authenticated {
		t.Fatalf("unexpected login result: %+v", result)
	}
	bundle, ok, err := service.dailySecretStore().GetAIProvider(builtinAIAccountKey)
	if err != nil || !ok {
		t.Fatalf("stored token missing: ok=%v err=%v", ok, err)
	}
	if bundle.APIKey != "access-1" || bundle.SensitiveHeaders[builtinAIRefreshTokenKey] != "refresh-1" {
		t.Fatalf("stored token bundle = %+v", bundle)
	}
}

func TestAIGetBuiltinAIStatusReadsQuota(t *testing.T) {
	t.Setenv("GONAVI_AI_GATEWAY_URL", "https://ai.example.test")
	previous := builtinAIHTTPDo
	builtinAIHTTPDo = func(req *http.Request) (*http.Response, error) {
		if req.URL.Path != "/v1/quota" || req.Header.Get("Authorization") != "Bearer access-1" {
			t.Fatalf("unexpected quota request: %s %s", req.URL.Path, req.Header.Get("Authorization"))
		}
		return &http.Response{
			StatusCode: http.StatusOK,
			Body:       io.NopCloser(strings.NewReader(`{"dailyTokensUsed":12,"dailyTokenLimit":100,"rolling5hTokensUsed":5,"rolling5hTokenLimit":50}`)),
		}, nil
	}
	t.Cleanup(func() { builtinAIHTTPDo = previous })

	service := NewServiceWithSecretStore(nil)
	service.configDir = t.TempDir()
	if err := service.dailySecretStore().PutAIProvider(builtinAIAccountKey, dailysecret.ProviderBundle{APIKey: "access-1"}); err != nil {
		t.Fatalf("PutAIProvider returned error: %v", err)
	}
	status, err := service.AIGetBuiltinAIStatus()
	if err != nil {
		t.Fatalf("AIGetBuiltinAIStatus returned error: %v", err)
	}
	if !status.Enabled || !status.Authenticated || status.Quota == nil {
		t.Fatalf("unexpected status: %+v", status)
	}
	if status.Quota.DailyTokensUsed != 12 || status.Quota.Rolling5HTokenLimit != 50 {
		t.Fatalf("unexpected quota: %+v", status.Quota)
	}
}
