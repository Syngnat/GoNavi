package nacos

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"
)

func TestContentMD5(t *testing.T) {
	t.Parallel()
	// md5("hello") = 5d41402abc4b2a76b9719d911017c592
	if got := ContentMD5("hello"); got != "5d41402abc4b2a76b9719d911017c592" {
		t.Fatalf("md5 = %q", got)
	}
}

func TestParseListenResponse(t *testing.T) {
	t.Parallel()
	raw := "app.yaml" + string(byte(2)) + "DEFAULT_GROUP" + string(byte(2)) + "dev-id" + string(byte(1))
	got := parseListenResponse(raw)
	if len(got) != 1 || got[0].DataID != "app.yaml" || got[0].NamespaceID != "dev-id" {
		t.Fatalf("parsed = %#v", got)
	}
	if len(parseListenResponse("")) != 0 {
		t.Fatal("empty response should be no change")
	}
	encoded := url.QueryEscape(raw)
	got = parseListenResponse(encoded)
	if len(got) != 1 || got[0].DataID != "app.yaml" || got[0].NamespaceID != "dev-id" {
		t.Fatalf("parsed encoded response = %#v", got)
	}
}

func TestNacosListenRequestErrorRedactsAccessToken(t *testing.T) {
	const accessToken = "listen-error-secret+/= token"
	baseURL, err := url.Parse("http://nacos.example.test/nacos")
	if err != nil {
		t.Fatal(err)
	}
	client := &ClientImpl{
		httpClient: &http.Client{
			Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
				return nil, errors.New("dial failed")
			}),
		},
		baseURL:     baseURL,
		accessToken: accessToken,
	}

	_, _, err = client.doListenRequest(context.Background(), url.Values{
		"Listening-Configs": {"app.yaml"},
	}, defaultListenTimeoutMs)
	if err == nil {
		t.Fatal("expected listen request failure")
	}
	if strings.Contains(err.Error(), accessToken) {
		t.Fatalf("listen request error exposed access token: %q", err)
	}
	if strings.Contains(err.Error(), url.QueryEscape(accessToken)) {
		t.Fatalf("listen request error exposed encoded access token: %q", err)
	}
}

func TestListenOnceReturnsTransportErrorAfterReauthentication(t *testing.T) {
	const (
		oldToken = "old-token"
		newToken = "new-token"
	)
	baseURL, err := url.Parse("http://nacos.example.test/nacos")
	if err != nil {
		t.Fatal(err)
	}
	listenRequests := 0
	loginRequests := 0
	client := &ClientImpl{
		config: connection.ConnectionConfig{
			Type:     "nacos",
			User:     "nacos",
			Password: "nacos-password",
		},
		httpClient: &http.Client{
			Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
				switch {
				case strings.HasSuffix(request.URL.Path, "/v1/cs/configs/listener"):
					listenRequests++
					if listenRequests == 1 {
						return &http.Response{
							StatusCode: http.StatusUnauthorized,
							Header:     make(http.Header),
							Body:       io.NopCloser(strings.NewReader("unauthorized")),
						}, nil
					}
					return nil, errors.New("retry transport failed")
				case strings.HasSuffix(request.URL.Path, "/v3/auth/user/login"):
					loginRequests++
					return &http.Response{
						StatusCode: http.StatusOK,
						Header:     make(http.Header),
						Body: io.NopCloser(strings.NewReader(
							`{"accessToken":"` + newToken + `","tokenTtl":3600}`,
						)),
					}, nil
				default:
					return nil, errors.New("unexpected request: " + request.URL.Path)
				}
			}),
		},
		baseURL:     baseURL,
		apiFamily:   nacosAPIV1,
		accessToken: oldToken,
		tokenExpiry: time.Now().Add(time.Hour),
	}

	_, err = client.ListenOnce(context.Background(), []ConfigListenTarget{{
		DataID:      "app.yaml",
		Group:       "DEFAULT_GROUP",
		ContentMD5:  ContentMD5("old"),
		NamespaceID: "dev",
	}}, minListenTimeoutMs)
	if err == nil || !strings.Contains(err.Error(), "retry transport failed") {
		t.Fatalf("ListenOnce error = %v, want retry transport failure", err)
	}
	if listenRequests != 2 {
		t.Fatalf("listen requests = %d, want 2", listenRequests)
	}
	if loginRequests != 1 {
		t.Fatalf("login requests = %d, want 1", loginRequests)
	}
}

func TestListenOnceChanged(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/v1/console/namespaces"):
			_, _ = io.WriteString(w, `{"code":200,"data":[]}`)
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/v1/cs/configs/listener"):
			if r.Header.Get("Long-Pulling-Timeout") == "" {
				t.Errorf("missing Long-Pulling-Timeout")
			}
			_ = r.ParseForm()
			listening := r.Form.Get("Listening-Configs")
			if !strings.Contains(listening, "app.yaml") {
				t.Errorf("listening packet = %q", listening)
			}
			// changed packet
			packet := "app.yaml" + string(byte(2)) + "DEFAULT_GROUP" + string(byte(2)) + "dev" + string(byte(1))
			_, _ = io.WriteString(w, url.QueryEscape(packet))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	u, err := url.Parse(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	port, _ := strconv.Atoi(u.Port())
	client := NewClient()
	if err := client.Connect(connection.ConnectionConfig{
		Type:             "nacos",
		Host:             u.Hostname(),
		Port:             port,
		Timeout:          5,
		ConnectionParams: "contextPath=/",
	}); err != nil {
		t.Fatalf("Connect: %v", err)
	}
	defer client.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	changed, err := client.ListenOnce(ctx, []ConfigListenTarget{{
		NamespaceID: "dev",
		DataID:      "app.yaml",
		Group:       "DEFAULT_GROUP",
		ContentMD5:  ContentMD5("old"),
	}}, 5000)
	if err != nil {
		t.Fatalf("ListenOnce: %v", err)
	}
	if len(changed) != 1 || changed[0].DataID != "app.yaml" {
		t.Fatalf("changed = %#v", changed)
	}
}

func TestListenOnceV3PollsConfigByMD5(t *testing.T) {
	var legacyListenRequests int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, nacosV3ReadinessPath):
			_, _ = io.WriteString(w, `{"code":0,"message":"success","data":"ok"}`)
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/v3/admin/cs/config"):
			if r.URL.Query().Get("dataId") != "app.yaml" || r.URL.Query().Get("groupName") != "DEFAULT_GROUP" ||
				r.URL.Query().Get("namespaceId") != "dev" {
				t.Errorf("v3 config query = %#v", r.URL.Query())
			}
			_, _ = io.WriteString(w, `{"code":0,"message":"success","data":{"dataId":"app.yaml","groupName":"DEFAULT_GROUP","namespaceId":"dev","content":"new"}}`)
		case strings.HasSuffix(r.URL.Path, "/v1/cs/configs/listener"):
			legacyListenRequests++
			http.NotFound(w, r)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	u, err := url.Parse(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	port, _ := strconv.Atoi(u.Port())
	client := NewClient()
	if err := client.Connect(connection.ConnectionConfig{
		Type:             "nacos",
		Host:             u.Hostname(),
		Port:             port,
		Timeout:          5,
		ConnectionParams: "contextPath=/",
	}); err != nil {
		t.Fatalf("Connect: %v", err)
	}
	defer client.Close()

	changed, err := client.ListenOnce(context.Background(), []ConfigListenTarget{{
		NamespaceID: "dev",
		DataID:      "app.yaml",
		Group:       "DEFAULT_GROUP",
		ContentMD5:  ContentMD5("old"),
	}}, 5000)
	if err != nil {
		t.Fatalf("ListenOnce: %v", err)
	}
	if len(changed) != 1 || changed[0].DataID != "app.yaml" {
		t.Fatalf("changed = %#v", changed)
	}
	if legacyListenRequests != 0 {
		t.Fatalf("legacy listener requests = %d, want 0", legacyListenRequests)
	}
}

func TestListenOnceV3BoundsSlowPollByListenTimeout(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, nacosV3ReadinessPath):
			_, _ = io.WriteString(w, `{"code":0,"message":"success","data":"ok"}`)
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/v3/admin/cs/config"):
			<-r.Context().Done()
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	u, err := url.Parse(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	port, _ := strconv.Atoi(u.Port())
	client := NewClient().(*ClientImpl)
	if err := client.Connect(connection.ConnectionConfig{
		Type:             "nacos",
		Host:             u.Hostname(),
		Port:             port,
		Timeout:          5,
		ConnectionParams: "contextPath=/",
	}); err != nil {
		t.Fatalf("Connect: %v", err)
	}
	defer client.Close()

	start := time.Now()
	changed, err := client.listenOnceV3(context.Background(), []ConfigListenTarget{{
		NamespaceID: "dev",
		DataID:      "app.yaml",
		Group:       "DEFAULT_GROUP",
		ContentMD5:  ContentMD5("old"),
	}}, 25)
	if err != nil {
		t.Fatalf("listenOnceV3: %v", err)
	}
	if len(changed) != 0 {
		t.Fatalf("changed = %#v, want none on timeout", changed)
	}
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("listenOnceV3 elapsed = %v, want bounded by listen timeout", elapsed)
	}

	canceledCtx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err = client.listenOnceV3(canceledCtx, []ConfigListenTarget{{
		DataID: "app.yaml", Group: "DEFAULT_GROUP",
	}}, 100)
	if err != context.Canceled {
		t.Fatalf("canceled listen error = %v, want context.Canceled", err)
	}
}
