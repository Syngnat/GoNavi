package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

func TestRecoverAgentRequestPanicWritesErrorResponse(t *testing.T) {
	var buffer bytes.Buffer
	writer := newAgentResponseWriter(bufio.NewWriter(&buffer))
	func() {
		defer recoverAgentRequestPanic(agentRequest{ID: 7, Method: "query"}, writer)
		panic("unrecognized auth")
	}()
	line := strings.TrimSpace(buffer.String())
	var resp agentResponse
	if err := json.Unmarshal([]byte(line), &resp); err != nil {
		t.Fatalf("decode %q: %v", line, err)
	}
	if resp.ID != 7 || resp.Success || !strings.Contains(resp.Error, "unrecognized auth") {
		t.Fatalf("response = %#v", resp)
	}
}

func TestRecoverAgentRequestPanicIgnoresNormalReturn(t *testing.T) {
	var buffer bytes.Buffer
	writer := newAgentResponseWriter(bufio.NewWriter(&buffer))
	func() {
		defer recoverAgentRequestPanic(agentRequest{ID: 1, Method: "ping"}, writer)
	}()
	if buffer.Len() != 0 {
		t.Fatalf("unexpected response: %q", buffer.String())
	}
}
