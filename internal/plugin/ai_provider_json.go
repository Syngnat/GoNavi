package plugin

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"unicode/utf8"
)

// UnmarshalJSON rejects omitted capability flags and ambiguous declaration keys atomically.
func (provider *AIProvider) UnmarshalJSON(data []byte) error {
	if err := validateAIObject(data, []string{"id", "name", "command", "models", "supportsTools", "supportsImages"}, []string{"icon", "defaultBaseUrl"}); err != nil {
		return err
	}
	type wireProvider AIProvider
	var decoded wireProvider
	if err := json.Unmarshal(data, &decoded); err != nil {
		return fmt.Errorf("decode ai provider: %w", err)
	}
	*provider = AIProvider(decoded)
	return nil
}

// UnmarshalJSON requires every static model field and rejects ambiguous aliases.
func (model *AIModel) UnmarshalJSON(data []byte) error {
	if err := validateAIObject(data, []string{"id", "name", "contextWindow", "maxOutputTokens"}, nil); err != nil {
		return err
	}
	type wireModel AIModel
	var decoded wireModel
	if err := json.Unmarshal(data, &decoded); err != nil {
		return fmt.Errorf("decode ai model: %w", err)
	}
	*model = AIModel(decoded)
	return nil
}

func validateAIObject(data []byte, required, optional []string) error {
	if !utf8.Valid(data) {
		return fmt.Errorf("ai declaration must be UTF-8")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	token, err := decoder.Token()
	if err != nil {
		return fmt.Errorf("decode ai declaration: %w", err)
	}
	if token != json.Delim('{') {
		return fmt.Errorf("ai declaration must be an object")
	}
	allowed := make(map[string]bool, len(required)+len(optional))
	for _, key := range required {
		allowed[key] = true
	}
	for _, key := range optional {
		allowed[key] = true
	}
	seen := make(map[string]bool, len(required)+len(optional))
	for decoder.More() {
		token, err := decoder.Token()
		if err != nil {
			return fmt.Errorf("decode ai declaration key: %w", err)
		}
		key, ok := token.(string)
		if !ok || !allowed[key] || seen[key] {
			return fmt.Errorf("unknown or duplicate ai declaration key")
		}
		var value json.RawMessage
		if err = decoder.Decode(&value); err != nil {
			return fmt.Errorf("decode ai declaration value: %w", err)
		}
		if bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return fmt.Errorf("ai declaration fields cannot be null")
		}
		seen[key] = true
	}
	if _, err = decoder.Token(); err != nil {
		return fmt.Errorf("decode ai declaration object: %w", err)
	}
	if err = decoder.Decode(new(json.RawMessage)); err != io.EOF {
		return fmt.Errorf("ai declaration has trailing data")
	}
	for _, key := range required {
		if !seen[key] {
			return fmt.Errorf("ai declaration is missing required field %s", key)
		}
	}
	return nil
}
