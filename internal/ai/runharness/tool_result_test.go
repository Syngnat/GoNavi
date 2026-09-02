package runharness

import (
	"encoding/json"
	"testing"
)

func TestEncodeToolResultUsesValidBoundedMarker(t *testing.T) {
	result := ToolExecutionResult{Value: map[string]any{"body": string(make([]byte, 512))}}
	encoded := encodeToolResult(result, nil, 64)
	if !encoded.Truncated {
		t.Fatal("expected result to be marked truncated")
	}
	if encoded.OriginalBytes <= 64 {
		t.Fatalf("original bytes = %d, want > 64", encoded.OriginalBytes)
	}
	if int64(len(encoded.JSON)) > 64 {
		t.Fatalf("encoded result length = %d, want <= 64", len(encoded.JSON))
	}
	if !json.Valid(encoded.JSON) {
		t.Fatalf("truncated result is invalid JSON: %s", encoded.JSON)
	}
	var marker struct {
		Truncated     bool  `json:"truncated"`
		OriginalBytes int64 `json:"originalBytes"`
	}
	if err := json.Unmarshal(encoded.JSON, &marker); err != nil {
		t.Fatal(err)
	}
	if !marker.Truncated || marker.OriginalBytes != encoded.OriginalBytes {
		t.Fatalf("marker = %#v, encoded = %#v", marker, encoded)
	}
}

func TestNormalizedFinishResultPreservesProvidedCanonicalJSON(t *testing.T) {
	encoded, err := normalizedFinishResult(FinishToolRequest{
		ResultJSON:     json.RawMessage(" { \"b\": 2, \"a\": 1 } "),
		MaxResultBytes: 1024,
	})
	if err != nil {
		t.Fatal(err)
	}
	if got, want := string(encoded.JSON), `{"a":1,"b":2}`; got != want {
		t.Fatalf("normalized JSON = %s, want %s", got, want)
	}
}
