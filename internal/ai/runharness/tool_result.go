package runharness

import (
	"bytes"
	"encoding/json"
	"errors"
	"strconv"
)

// encodedToolResult is the one representation shared by the tool message,
// typed event and encrypted tool record. OriginalBytes describes the result
// before applying the run/descriptor cap; JSON is always valid JSON.
type encodedToolResult struct {
	JSON          json.RawMessage
	OriginalBytes int64
	Truncated     bool
}

// encodeToolResult marshals an executor outcome once and applies a byte cap
// without ever cutting through a JSON token. A compact marker is preferable
// to a partial payload: providers can safely parse it and the original size is
// still available for diagnostics.
func encodeToolResult(result ToolExecutionResult, execErr error, maxBytes int64) encodedToolResult {
	var raw []byte
	if len(result.ResultJSON) > 0 {
		if json.Valid(result.ResultJSON) {
			// Decode and re-encode caller-provided JSON so equivalent object
			// representations produce identical hashes and message/event payloads.
			raw = canonicalJSON(result.ResultJSON)
		}
	}
	if len(raw) == 0 {
		raw = marshalToolValue(result, execErr)
	}
	original := result.OriginalBytes
	if original <= 0 {
		original = int64(len(raw))
	}
	truncated := result.Truncated
	if maxBytes > 0 && int64(len(raw)) > maxBytes {
		truncated = true
		raw = truncatedToolJSON(original, maxBytes)
	}
	if len(raw) == 0 {
		raw = []byte("null")
	}
	return encodedToolResult{JSON: append(json.RawMessage(nil), raw...), OriginalBytes: original, Truncated: truncated}
}

func canonicalJSON(input []byte) []byte {
	decoder := json.NewDecoder(bytes.NewReader(input))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return append([]byte(nil), input...)
	}
	// A valid JSON document has no second value. Keep the original bytes if a
	// caller supplied an unusual stream so this helper never silently merges it.
	var extra any
	if err := decoder.Decode(&extra); err == nil {
		return append([]byte(nil), input...)
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return append([]byte(nil), input...)
	}
	return encoded
}

func marshalToolValue(result ToolExecutionResult, execErr error) []byte {
	if execErr != nil {
		payload := map[string]any{"error": execErr.Error()}
		if result.ErrorCode != "" {
			payload["errorCode"] = result.ErrorCode
		}
		encoded, err := json.Marshal(payload)
		if err == nil {
			return encoded
		}
		return []byte(`{"error":"tool_result_encode_failed"}`)
	}
	if result.Value == nil && result.ErrorCode != "" {
		encoded, err := json.Marshal(map[string]any{"errorCode": result.ErrorCode})
		if err == nil {
			return encoded
		}
	}
	encoded, err := json.Marshal(result.Value)
	if err != nil {
		return []byte(`{"error":"tool_result_encode_failed"}`)
	}
	return encoded
}

func truncatedToolJSON(originalBytes, maxBytes int64) []byte {
	// Keep this structure deterministic; encoding/json sorts map keys but a
	// struct also documents the wire shape for consumers.
	marker := []byte(`{"truncated":true,"originalBytes":` + strconv.FormatInt(originalBytes, 10) + `}`)
	if maxBytes <= 0 || int64(len(marker)) <= maxBytes {
		return marker
	}
	// A caller may configure an unrealistically tiny cap. Returning a valid
	// scalar is still safer than violating the cap with malformed JSON.
	if maxBytes >= 4 {
		return []byte("null")
	}
	return []byte("0")
}

func normalizedFinishResult(request FinishToolRequest) (encodedToolResult, error) {
	if len(request.ResultJSON) > 0 && !json.Valid(request.ResultJSON) {
		return encodedToolResult{}, errors.New("tool result JSON is invalid")
	}
	result := ToolExecutionResult{Value: request.Result, ResultJSON: request.ResultJSON,
		ErrorCode: request.ErrorCode, Truncated: request.Truncated, OriginalBytes: request.OriginalBytes}
	encoded := encodeToolResult(result, nil, request.MaxResultBytes)
	return encoded, nil
}
