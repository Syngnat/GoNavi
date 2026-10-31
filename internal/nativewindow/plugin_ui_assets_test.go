package nativewindow

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestPluginWindowUIAssetsAreTokenScoped(t *testing.T) {
	c, _ := newPluginTestController(t)
	entry := openPluginTestWindow(t, c, "test.one")

	response := servePluginTest(c, entry, http.MethodGet, pluginBridgePrefix+"ui/index.js", "")
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), "fixture") {
		t.Fatalf("ui asset response: %d %s", response.Code, response.Body.String())
	}
	if contentType := response.Header().Get("Content-Type"); !strings.HasPrefix(contentType, "application/javascript") {
		t.Fatalf("content type = %q", contentType)
	}
	style := servePluginTest(c, entry, http.MethodGet, pluginBridgePrefix+"ui/style.css", "")
	if style.Code != http.StatusOK {
		t.Fatalf("style status = %d", style.Code)
	}
	denied := pluginTestRequest(c, entry, http.MethodGet, pluginBridgePrefix+"ui/index.js", "")
	denied.Header.Set(pluginTokenHeader, "")
	recorder := httptest.NewRecorder()
	c.serveHTTP(recorder, denied)
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("missing token status = %d", recorder.Code)
	}
}
