package app

import (
	"fmt"
	"net/http"
	"net/url"
	"testing"
	"time"
)

type roundTripperFunc func(*http.Request) (*http.Response, error)

func (fn roundTripperFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return fn(request)
}

func localDispatcherClient(t *testing.T, serverURL string) *http.Client {
	t.Helper()
	target, err := url.Parse(serverURL)
	if err != nil {
		t.Fatalf("parse local Dispatcher server URL: %v", err)
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	return &http.Client{Timeout: 30 * time.Second, Transport: roundTripperFunc(func(request *http.Request) (*http.Response, error) {
		if request.URL.Hostname() != downloadDispatcherHostname {
			return nil, fmt.Errorf("unexpected Dispatcher request host %q", request.URL.Hostname())
		}
		forwarded := request.Clone(request.Context())
		rewrittenURL := *request.URL
		rewrittenURL.Scheme = target.Scheme
		rewrittenURL.Host = target.Host
		forwarded.URL = &rewrittenURL
		forwarded.Host = ""
		response, err := transport.RoundTrip(forwarded)
		if response != nil {
			// Preserve the logical Dispatcher URL for source-aware status handling;
			// the forwarding target is only an in-process test implementation.
			response.Request = request
		}
		return response, err
	})}
}
