package provider

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"

	"GoNavi-Wails/internal/ai"
)

type providerErrorRoundTripper func(*http.Request) (*http.Response, error)

func (fn providerErrorRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	return fn(req)
}

type trackingErrorBody struct {
	reader       *strings.Reader
	readBytes    int
	closed       bool
	readErrAfter int
	readErr      error
}

func newTrackingErrorBody(content string) *trackingErrorBody {
	return &trackingErrorBody{reader: strings.NewReader(content)}
}

func (b *trackingErrorBody) Read(p []byte) (int, error) {
	if b.readErr != nil && b.readBytes >= b.readErrAfter {
		return 0, b.readErr
	}
	if b.readErr != nil && b.readErrAfter-b.readBytes < len(p) {
		p = p[:b.readErrAfter-b.readBytes]
	}
	n, err := b.reader.Read(p)
	b.readBytes += n
	if n > 0 && b.readErr != nil && b.readBytes >= b.readErrAfter {
		return n, b.readErr
	}
	return n, err
}

func (b *trackingErrorBody) Close() error {
	b.closed = true
	return nil
}

func TestReadProviderErrorBodyLimitsUnknownLength(t *testing.T) {
	body := newTrackingErrorBody(strings.Repeat("x", int(maxProviderErrorBodyBytes)+32))

	got := readProviderErrorBody(body, -1)
	if body.readBytes != int(maxProviderErrorBodyBytes)+1 {
		t.Fatalf("expected at most limit+1 bytes read, got %d", body.readBytes)
	}
	if !strings.Contains(got, "error response body truncated") {
		t.Fatalf("expected truncation marker, got %q", got)
	}
	if len(got) <= int(maxProviderErrorBodyBytes) {
		t.Fatalf("expected diagnostic suffix after limited body, got length %d", len(got))
	}
}

func TestReadProviderErrorBodySkipsDeclaredOversizedBody(t *testing.T) {
	body := newTrackingErrorBody(strings.Repeat("x", int(maxProviderErrorBodyBytes)+1))

	got := readProviderErrorBody(body, maxProviderErrorBodyBytes+1)
	if body.readBytes != 0 {
		t.Fatalf("declared oversized body should not be read, got %d bytes", body.readBytes)
	}
	if !strings.Contains(got, "declared Content-Length") || !strings.Contains(got, "truncated") {
		t.Fatalf("expected declared-length truncation diagnostic, got %q", got)
	}
}

func TestReadProviderErrorBodyPreservesPartialBodyOnReadError(t *testing.T) {
	body := newTrackingErrorBody("upstream diagnostic")
	body.readErrAfter = len("upstream ")
	body.readErr = errors.New("connection reset")

	got := readProviderErrorBody(body, -1)
	if !strings.Contains(got, "upstream ") {
		t.Fatalf("expected partial upstream diagnostic to be preserved, got %q", got)
	}
	if !strings.Contains(got, "failed to read error response body: connection reset") {
		t.Fatalf("expected read failure marker, got %q", got)
	}
}

func TestProvidersLimitAndCloseOversizedErrorBodies(t *testing.T) {
	newClient := func(body *trackingErrorBody) *http.Client {
		return &http.Client{Transport: providerErrorRoundTripper(func(req *http.Request) (*http.Response, error) {
			return &http.Response{
				StatusCode:    http.StatusBadGateway,
				ContentLength: -1,
				Header:        make(http.Header),
				Body:          body,
				Request:       req,
			}, nil
		})}
	}

	tests := []struct {
		name string
		call func(*trackingErrorBody) error
	}{
		{
			name: "openai",
			call: func(body *trackingErrorBody) error {
				p := &OpenAIProvider{config: ai.ProviderConfig{APIKey: "test"}, baseURL: "http://provider.test", client: newClient(body)}
				_, err := p.doRequest(context.Background(), map[string]any{})
				return err
			},
		},
		{
			name: "openai responses",
			call: func(body *trackingErrorBody) error {
				p := &OpenAIResponsesProvider{config: ai.ProviderConfig{APIKey: "test"}, baseURL: "http://provider.test", client: newClient(body)}
				_, err := p.doRequest(context.Background(), openAIResponsesRequest{})
				return err
			},
		},
		{
			name: "anthropic",
			call: func(body *trackingErrorBody) error {
				p := &AnthropicProvider{config: ai.ProviderConfig{APIKey: "test"}, baseURL: "http://provider.test", client: newClient(body)}
				_, err := p.doRequest(context.Background(), map[string]any{})
				return err
			},
		},
		{
			name: "gemini",
			call: func(body *trackingErrorBody) error {
				p := &GeminiProvider{config: ai.ProviderConfig{APIKey: "test"}, baseURL: "http://provider.test", client: newClient(body)}
				_, err := p.doRequest(context.Background(), "http://provider.test", map[string]any{})
				return err
			},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			body := newTrackingErrorBody(strings.Repeat("x", int(maxProviderErrorBodyBytes)+32))
			err := tc.call(body)
			if err == nil || !strings.Contains(err.Error(), "error response body truncated") {
				t.Fatalf("expected limited upstream error, got %v", err)
			}
			if body.readBytes != int(maxProviderErrorBodyBytes)+1 {
				t.Fatalf("expected at most limit+1 bytes read, got %d", body.readBytes)
			}
			if !body.closed {
				t.Fatal("expected provider to close the error response body")
			}
		})
	}
}

var _ io.ReadCloser = (*trackingErrorBody)(nil)
