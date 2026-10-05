package nativewindow

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

func (b *Bridge) setReadyHandler(handler func() OperationResult) {
	if b == nil {
		return
	}
	b.mu.Lock()
	b.onReady = handler
	b.mu.Unlock()
}

func (b *Bridge) presentFrontendReady() OperationResult {
	if b == nil {
		return operationFailure("detached bridge is unavailable")
	}
	b.mu.Lock()
	if b.ready {
		b.mu.Unlock()
		return OperationResult{Success: true, ID: b.windowID}
	}
	onReady := b.onReady
	b.mu.Unlock()
	if onReady == nil {
		return operationFailure("native window ready handler is unavailable")
	}
	result := onReady()
	if !result.Success {
		return result
	}
	b.mu.Lock()
	b.ready = true
	b.mu.Unlock()
	return OperationResult{Success: true, ID: b.windowID}
}

func (b *Bridge) frontendReady() bool {
	if b == nil {
		return false
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.ready
}

func (b *Bridge) notifyClosing() {
	if b == nil {
		return
	}
	b.closeOnce.Do(func() {
		b.mu.Lock()
		terminal := b.terminal
		b.mu.Unlock()
		if terminal == "attach" || terminal == "close" {
			return
		}
		ctx, cancel := context.WithTimeout(context.Background(), 750*time.Millisecond)
		defer cancel()
		var result OperationResult
		_, _ = b.doJSON(ctx, http.MethodPost, ActionPath, actionRequest{
			Action: "close",
			Payload: map[string]any{
				"id":   b.windowID,
				"kind": b.kind,
			},
		}, &result)
	})
}

func (b *Bridge) stop() {
	if b == nil {
		return
	}
	b.mu.Lock()
	cancel := b.cancel
	// lifecycleCtx is intentionally retained in its cancelled state after stop.
	b.cancel = nil
	b.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

func (b *Bridge) lifecycleContext() context.Context {
	if b == nil {
		return context.Background()
	}
	b.mu.Lock()
	lifecycleCtx := b.lifecycleCtx
	b.mu.Unlock()
	if lifecycleCtx != nil {
		return lifecycleCtx
	}
	return context.Background()
}

func (b *Bridge) rpcTimeoutDuration() time.Duration {
	if b == nil {
		return defaultDetachedRPCRequestTimeout
	}
	b.mu.Lock()
	timeout := b.rpcTimeout
	b.mu.Unlock()
	if timeout <= 0 {
		return defaultDetachedRPCRequestTimeout
	}
	return timeout
}

func (b *Bridge) doRPCJSON(method string, requestPath string, requestBody any, responseBody any) (int, error) {
	requestCtx, cancel := context.WithTimeout(b.lifecycleContext(), b.rpcTimeoutDuration())
	defer cancel()
	return b.doJSON(requestCtx, method, requestPath, requestBody, responseBody)
}

func (b *Bridge) doJSON(ctx context.Context, method string, requestPath string, requestBody any, responseBody any) (int, error) {
	if b == nil || b.client == nil {
		return 0, fmt.Errorf("detached bridge is unavailable")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	var body io.Reader
	if requestBody != nil {
		payload, err := json.Marshal(requestBody)
		if err != nil {
			return 0, err
		}
		body = bytes.NewReader(payload)
	}
	request, err := http.NewRequestWithContext(ctx, method, b.parentURL+requestPath, body)
	if err != nil {
		return 0, err
	}
	b.addHeaders(request)
	if requestBody != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := b.client.Do(request)
	if err != nil {
		return 0, err
	}
	defer response.Body.Close()
	if responseBody != nil {
		decoder := json.NewDecoder(io.LimitReader(response.Body, maxDetachedJSONBytes))
		if err := decoder.Decode(responseBody); err != nil && !errorsIsEOF(err) {
			return response.StatusCode, err
		}
	}
	return response.StatusCode, nil
}

func errorsIsEOF(err error) bool {
	return err == io.EOF
}

func (b *Bridge) addHeaders(request *http.Request) {
	request.Header.Set(HeaderToken, b.token)
	request.Header.Set(HeaderWindowID, b.windowID)
}
