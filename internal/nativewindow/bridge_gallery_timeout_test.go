//go:build !wails3

package nativewindow

import (
	"context"
	"errors"
	"net/http"
	"testing"
	"time"
)

func TestBridgeGalleryNetworkMethodsUseDomainBudgetAndRemainCancelable(t *testing.T) {
	for _, method := range []string{"BackgroundGalleryRefresh", "BackgroundGalleryDownload", "FontGalleryRefresh", "FontGalleryDownload", "FontGalleryPreview"} {
		t.Run(method, func(t *testing.T) {
			bridge := newTimeoutTestBridge(20 * time.Millisecond)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			observed := make(chan bool, 1)
			bridge.client.Transport = roundTripFunc(func(request *http.Request) (*http.Response, error) {
				if request.URL.Path == EventsPath {
					return emptyBridgeResponse(http.StatusNoContent), nil
				}
				_, hasDeadline := request.Context().Deadline()
				observed <- hasDeadline
				<-request.Context().Done()
				return nil, request.Context().Err()
			})
			InitializeBridge(bridge, ctx)
			defer bridge.stop()
			done := make(chan error, 1)
			go func() { _, err := bridge.Invoke("app", "App", method, nil); done <- err }()
			select {
			case bounded := <-observed:
				if bounded {
					t.Error("gallery inherited ordinary RPC deadline instead of domain budget")
				}
			case <-time.After(time.Second):
				t.Fatal("request did not start")
			}
			cancel()
			select {
			case err := <-done:
				if !errors.Is(err, context.Canceled) {
					t.Fatalf("cancellation: %v", err)
				}
			case <-time.After(time.Second):
				t.Fatal("gallery request did not cancel")
			}
		})
	}
}
