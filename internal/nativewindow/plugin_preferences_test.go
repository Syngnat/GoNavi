package nativewindow

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestPluginPreferenceUpdatesAreBoundedAndDoNotReplaceWindow(t *testing.T) {
	c, _ := newPluginTestController(t)
	first := json.RawMessage(`{"locale":"zh-CN","theme":"light","palette":{"bg":"rgb(17, 34, 51)","secret":"file:///private"},"appearance":{"fontSize":14,"background":{"enabled":true,"url":"file:///private"}}}`)
	if err := c.UpdatePreferences(first); err != nil {
		t.Fatal(err)
	}
	entry := openPluginTestWindow(t, c, "test.one")
	initial := servePluginTest(c, entry, http.MethodGet, pluginBridgePrefix+"bootstrap", "")
	if strings.Contains(initial.Body.String(), "private") || strings.Contains(initial.Body.String(), "secret") {
		t.Fatal(initial.Body.String())
	}
	var boot pluginBootstrap
	if err := json.Unmarshal(initial.Body.Bytes(), &boot); err != nil || boot.PreferencesRevision != 1 {
		t.Fatal(initial.Body.String())
	}
	if err := c.UpdatePreferences(first); err != nil {
		t.Fatal(err)
	}
	second := json.RawMessage(`{"locale":"zh-CN","theme":"light","palette":{"bg":"rgb(68, 85, 102)"}}`)
	if err := c.UpdatePreferences(second); err != nil {
		t.Fatal(err)
	}
	beat := servePluginTest(c, entry, http.MethodPost, pluginBridgePrefix+"heartbeat", `{"sequence":1}`)
	if err := json.Unmarshal(beat.Body.Bytes(), &boot); err != nil || boot.PreferencesRevision != 2 || !strings.Contains(string(boot.Preferences), "68, 85, 102") {
		t.Fatal(beat.Body.String())
	}
	c.mu.Lock()
	current := c.windows["test.one"]
	c.mu.Unlock()
	if current != entry {
		t.Fatal("preference update rebuilt window")
	}
	for _, invalid := range []string{
		`{"locale":"zh-CN","theme":"light","rawCSS":"body{}"}`,
		`{"locale":"zh-CN","theme":"light","palette":{"bg":"url(file:///private)"}}`,
		`{"locale":"zh-CN","theme":"light","palette":{"bg":"rgb(garbage)"}}`,
		`{"locale":"zh-CN","theme":"light","appearance":{"fontFamily":"x; color:red"}}`,
		`{"locale":"zh-CN","theme":"light","appearance":{"fontSize":99}}`,
		`{"locale":"zh-CN","theme":"light","appearance":{"fontFamily":"inherit"}}`,
		`{"locale":"zh-CN","theme":"light","appearance":{"radius":null}}`,
		`{"locale":"zh-CN","theme":"light","appearance":{"background":{"enabled":null}}}`,
		strings.Repeat(" ", 8193),
	} {
		if err := c.UpdatePreferences(json.RawMessage(invalid)); err == nil {
			t.Fatalf("invalid preference accepted: %s", invalid[:min(len(invalid), 100)])
		}
	}
	c.mu.Lock()
	revision := c.preferencesRevision
	c.mu.Unlock()
	if revision != 2 {
		t.Fatalf("invalid data changed revision: %d", revision)
	}
}

func TestPluginPreferenceRequestFence(t *testing.T) {
	c, _ := newPluginTestController(t)
	newest := json.RawMessage(`{"locale":"en-US","theme":"dark","requestRevision":200,"palette":{"bg":"#445566"}}`)
	if err := c.UpdatePreferences(newest); err != nil {
		t.Fatal(err)
	}
	entry := openPluginTestWindow(t, c, "test.one")
	for _, raw := range []string{
		`{"locale":"zh-CN","theme":"light","requestRevision":100}`,
		`{"locale":"zh-CN","theme":"light","requestRevision":200}`,
	} {
		if err := c.UpdatePreferences(json.RawMessage(raw)); err == nil {
			t.Fatal("late request accepted")
		}
	}
	for _, path := range []string{"bootstrap", "heartbeat"} {
		method, body := http.MethodGet, ""
		if path == "heartbeat" {
			method, body = http.MethodPost, `{"sequence":1}`
		}
		response := servePluginTest(c, entry, method, pluginBridgePrefix+path, body)
		var boot pluginBootstrap
		if err := json.Unmarshal(response.Body.Bytes(), &boot); err != nil {
			t.Fatal(err)
		}
		if boot.PreferencesRevision != 1 || strings.Contains(string(boot.Preferences), "requestRevision") || !strings.Contains(string(boot.Preferences), "#445566") {
			t.Fatalf("late request replaced or leaked preferences: %s", response.Body.String())
		}
	}
	if err := c.UpdatePreferences(json.RawMessage(`{"locale":"ja-JP","theme":"light"}`)); err != nil {
		t.Fatalf("legacy snapshot rejected: %v", err)
	}
	if err := c.UpdatePreferences(json.RawMessage(`{"locale":"en-US","theme":"dark","requestRevision":199}`)); err == nil {
		t.Fatal("legacy snapshot cleared request fence")
	}
	if err := c.UpdatePreferences(json.RawMessage(`{"locale":"en-US","theme":"dark","requestRevision":201}`)); err != nil {
		t.Fatalf("new request rejected: %v", err)
	}
}

func TestInvalidPluginPreferenceRequestDoesNotAdvanceFence(t *testing.T) {
	for _, invalid := range []string{
		`{"locale":"en-US","theme":"dark","requestRevision":0}`,
		`{"locale":"en-US","theme":"dark","requestRevision":null}`,
		`{"locale":"en-US","theme":"dark","requestRevision":-1}`,
		`{"locale":"en-US","theme":"dark","requestRevision":1.5}`,
		`{"locale":"en-US","theme":"dark","requestRevision":9007199254740992}`,
		`{"locale":"en-US","theme":"dark","requestRevision":300,"rawCSS":"body{}"}`,
		`{"locale":"en-US","theme":"dark","requestRevision":300,"palette":{"bg":"url(file:///private)"}}`,
	} {
		t.Run(invalid, func(t *testing.T) {
			c, _ := newPluginTestController(t)
			if err := c.UpdatePreferences(json.RawMessage(invalid)); err == nil {
				t.Fatal("invalid ordered preferences accepted")
			}
			if err := c.UpdatePreferences(json.RawMessage(`{"locale":"en-US","theme":"light","requestRevision":1}`)); err != nil {
				t.Fatalf("failed request advanced fence: %v", err)
			}
		})
	}
}

func TestPluginInitialHTMLPreferencesSurviveChildFallback(t *testing.T) {
	c, _ := newPluginTestController(t)
	raw := json.RawMessage(`{"locale":"en-US","theme":"light","palette":{"bg":"rgb(17, 34, 51)"}}`)
	if err := c.UpdatePreferences(raw); err != nil {
		t.Fatal(err)
	}
	entry := openPluginTestWindow(t, c, "test.one")
	response := servePluginTest(c, entry, http.MethodGet, pluginAssetPrefix+"index.html", "")
	html := response.Body.String()
	marker := "window.__gonaviPluginBootstrap="
	at := strings.Index(html, marker)
	if at < 0 {
		t.Fatal("missing initial snapshot")
	}
	end := strings.Index(html[at:], ";window.gonaviHostPrefs")
	if end < 0 {
		t.Fatal("missing initial assignment")
	}
	var boot pluginBootstrap
	if err := json.Unmarshal([]byte(html[at+len(marker):at+end]), &boot); err != nil || string(boot.Preferences) != string(raw) {
		t.Fatalf("invalid initial preferences: %s", html)
	}
	if strings.Index(html, "window.gonaviHostPrefs=window.__gonaviPluginBootstrap.preferences") > strings.Index(html, pluginBridgePrefix+"runtime.js") {
		t.Fatal("snapshot installed after plugin runtime")
	}
	fallback := injectHostPrefs{locale: "zh-CN", theme: "dark"}
	resp := &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"text/html"}}, Body: io.NopCloser(strings.NewReader(html))}
	if err := fallback.modifyHTML(resp); err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(body), "if(!window.gonaviHostPrefs)") || !strings.Contains(string(body), marker) {
		t.Fatal("child fallback lost full host snapshot")
	}
}

func TestPluginHeartbeatCarriesCurrentPreferences(t *testing.T) {
	c, _ := newPluginTestController(t)
	entry := openPluginTestWindow(t, c, "test.one")
	response := servePluginTest(c, entry, http.MethodPost, pluginBridgePrefix+"heartbeat", `{"sequence":1}`)
	if response.Code != 200 || !json.Valid(response.Body.Bytes()) {
		t.Fatalf("missing heartbeat preferences: code=%d body=%s", response.Code, response.Body.String())
	}
}

func TestPluginBootstrapCarriesHostPreferences(t *testing.T) {
	c, _ := newPluginTestController(t)
	entry := openPluginTestWindow(t, c, "test.one")
	response := servePluginTest(c, entry, http.MethodGet, pluginBridgePrefix+"bootstrap", "")
	var value map[string]json.RawMessage
	if err := json.Unmarshal(response.Body.Bytes(), &value); err != nil {
		t.Fatal(err)
	}
	if string(value["preferences"]) != `{"locale":"zh-CN","theme":"dark"}` {
		t.Fatalf("bootstrap missing host preferences: %s", response.Body.String())
	}
}
