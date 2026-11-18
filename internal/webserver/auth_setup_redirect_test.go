package webserver

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestListenHostIsLoopback(t *testing.T) {
	cases := []struct {
		addr string
		want bool
	}{
		{addr: "127.0.0.1:34116", want: true},
		{addr: "[::1]:34116", want: true},
		{addr: "localhost:34116", want: true},
		{addr: "0.0.0.0:34116", want: false},
		{addr: "[::]:34116", want: false},
		{addr: ":34116", want: false},
		{addr: "192.168.1.8:34116", want: false},
	}
	for _, testCase := range cases {
		t.Run(testCase.addr, func(t *testing.T) {
			if got := listenHostIsLoopback(testCase.addr); got != testCase.want {
				t.Fatalf("listenHostIsLoopback(%q) = %v, want %v", testCase.addr, got, testCase.want)
			}
		})
	}
}

func newUnconfiguredAuthServer(t *testing.T, listenAddr string) (*Server, string) {
	t.Helper()
	t.Setenv("GONAVI_WEB_PASSWORD", "")
	t.Setenv("GONAVI_WEB_SETUP_TOKEN", "gate-token")
	manager, err := newWebAuthManager(t.TempDir())
	if err != nil {
		t.Fatalf("newWebAuthManager: %v", err)
	}
	server := &Server{options: Options{Addr: listenAddr}, auth: manager}
	server.boundAddr.Store(listenAddr)
	return server, manager.SetupToken()
}

func TestLoopbackRootRedirectCarriesSetupToken(t *testing.T) {
	server, token := newUnconfiguredAuthServer(t, "127.0.0.1:34116")
	request := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:34116/", nil)
	recorder := httptest.NewRecorder()

	server.routes().ServeHTTP(recorder, request)

	location := recorder.Header().Get("Location")
	if recorder.Code != http.StatusSeeOther {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusSeeOther)
	}
	if !strings.Contains(location, "setup="+token) || !strings.Contains(location, "next=%2F") {
		t.Fatalf("Location = %q, want setup token and next=/", location)
	}
}

func TestPublicRootRedirectDoesNotLeakSetupToken(t *testing.T) {
	server, token := newUnconfiguredAuthServer(t, "0.0.0.0:34116")
	request := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:34116/", nil)
	request.RemoteAddr = "127.0.0.1:4321"
	recorder := httptest.NewRecorder()

	server.routes().ServeHTTP(recorder, request)

	location := recorder.Header().Get("Location")
	if recorder.Code != http.StatusSeeOther {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusSeeOther)
	}
	if strings.Contains(location, token) || strings.Contains(location, "setup=") {
		t.Fatalf("public bind leaked setup token in Location %q", location)
	}
	if location != "/setup?next=%2F" {
		t.Fatalf("Location = %q, want /setup?next=%%2F", location)
	}
}

func TestLoopbackSetupPageWithoutTokenRedirectsToGateURL(t *testing.T) {
	server, token := newUnconfiguredAuthServer(t, "127.0.0.1:34116")
	request := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:34116/setup?next=%2F", nil)
	recorder := httptest.NewRecorder()

	server.routes().ServeHTTP(recorder, request)

	location := recorder.Header().Get("Location")
	if recorder.Code != http.StatusSeeOther {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusSeeOther)
	}
	if !strings.Contains(location, "setup="+token) {
		t.Fatalf("Location = %q, want it to add setup token", location)
	}
}

func TestLoopbackSetupPageWithTokenDoesNotRedirectAgain(t *testing.T) {
	server, token := newUnconfiguredAuthServer(t, "127.0.0.1:34116")
	request := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:34116/setup?setup="+token+"&next=%2F", nil)
	recorder := httptest.NewRecorder()

	server.routes().ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, Location = %q, want 200 without another redirect", recorder.Code, recorder.Header().Get("Location"))
	}
}

func TestPublicSetupPageWithoutTokenStaysGated(t *testing.T) {
	server, token := newUnconfiguredAuthServer(t, "0.0.0.0:34116")
	request := httptest.NewRequest(http.MethodGet, "http://192.168.1.8:34116/setup?next=%2F", nil)
	recorder := httptest.NewRecorder()

	server.routes().ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want the setup page so the gate error can be shown", recorder.Code)
	}
	if strings.Contains(recorder.Body.String(), token) {
		t.Fatalf("public setup page embedded the gate token")
	}
	if location := recorder.Header().Get("Location"); strings.Contains(location, token) {
		t.Fatalf("public setup page redirected with the gate token: %s", location)
	}
}
