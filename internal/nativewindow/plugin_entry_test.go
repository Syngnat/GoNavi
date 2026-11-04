package nativewindow

import (
	"net/http"
	"strings"
	"testing"
)

// The Wails child treats this handler's response as the window document, so the
// entry has to arrive as HTML in one response. A redirect is not followed there
// and the window renders the redirect body ("Temporary Redirect.") instead.
func TestPluginEntryServesDocumentWithoutRedirect(t *testing.T) {
	controller, _ := newPluginTestController(t)
	entry := openPluginTestWindow(t, controller, "test.one")
	response := servePluginTest(controller, entry, http.MethodGet, "/", "")
	if response.Code != http.StatusOK {
		t.Fatalf("entry must be served directly, got %d", response.Code)
	}
	if location := response.Header().Get("Location"); location != "" {
		t.Fatalf("entry must not redirect, got Location %q", location)
	}
	if contentType := response.Header().Get("Content-Type"); !strings.Contains(contentType, "text/html") {
		t.Fatalf("unexpected content type: %q", contentType)
	}
	if !strings.Contains(response.Body.String(), "fixture") {
		t.Fatalf("entry body missing: %q", response.Body.String())
	}
}

func TestPluginEntryRejectsNonGetRequests(t *testing.T) {
	controller, _ := newPluginTestController(t)
	entry := openPluginTestWindow(t, controller, "test.one")
	response := servePluginTest(controller, entry, http.MethodPost, "/", "{}")
	if response.Code != http.StatusMethodNotAllowed {
		t.Fatalf("entry accepted a non-GET request: %d", response.Code)
	}
}
