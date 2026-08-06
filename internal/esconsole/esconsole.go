// Package esconsole parses and classifies Elasticsearch REST console input.
package esconsole

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/url"
	"strings"
	"unicode"
)

const (
	// MaxSourceBytes caps a complete console batch before parsing.
	MaxSourceBytes = 32 << 20
	// MaxRequests caps the number of REST requests in one batch.
	MaxRequests = 100
	// MaxNDJSONLineBytes caps one Bulk or multi-search line.
	MaxNDJSONLineBytes = 8 << 20
	// MaxBulkActions caps the number of operations in one Bulk request.
	MaxBulkActions = 10_000
	// MaxWriteTargets caps unique indices that require execution-time resolution.
	MaxWriteTargets = 100
)

// ErrorCode is a stable machine-readable parse or policy error category.
type ErrorCode string

const (
	CodeEmptySource         ErrorCode = "empty_source"
	CodeSourceTooLarge      ErrorCode = "source_too_large"
	CodeTooManyRequests     ErrorCode = "too_many_requests"
	CodeInvalidHeader       ErrorCode = "invalid_header"
	CodeUnsupportedMethod   ErrorCode = "unsupported_method"
	CodeUnsafePath          ErrorCode = "unsafe_path"
	CodeDefaultIndexNeeded  ErrorCode = "default_index_required"
	CodeInvalidJSON         ErrorCode = "invalid_json"
	CodeBodyRequired        ErrorCode = "body_required"
	CodeInvalidNDJSON       ErrorCode = "invalid_ndjson"
	CodeNDJSONLineTooLarge  ErrorCode = "ndjson_line_too_large"
	CodeTooManyBulkActions  ErrorCode = "too_many_bulk_actions"
	CodeTooManyWriteTargets ErrorCode = "too_many_write_targets"
	CodeInvalidAliasAction  ErrorCode = "invalid_alias_action"
)

// ParseError reports a stable error code and, when available, request and line positions.
type ParseError struct {
	Code         ErrorCode `json:"code"`
	RequestIndex int       `json:"requestIndex,omitempty"`
	Line         int       `json:"line,omitempty"`
	Message      string    `json:"message"`
	Cause        error     `json:"-"`
}

func (e *ParseError) Error() string {
	if e == nil {
		return ""
	}
	return e.Message
}

func (e *ParseError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Cause
}

func parseError(code ErrorCode, message string, cause error) *ParseError {
	return &ParseError{Code: code, RequestIndex: -1, Message: message, Cause: cause}
}

// Kind describes how a request was expressed by the user.
type Kind string

const (
	KindREST    Kind = "rest"
	KindJSONDSL Kind = "json_dsl"
)

// BodyKind describes the wire representation of a request body.
type BodyKind string

const (
	BodyNone   BodyKind = "none"
	BodyJSON   BodyKind = "json"
	BodyNDJSON BodyKind = "ndjson"
)

// Risk is the execution policy assigned to a parsed request.
type Risk string

const (
	RiskRead        Risk = "read"
	RiskNormalWrite Risk = "normal_write"
	RiskDangerous   Risk = "dangerous"
	RiskBlocked     Risk = "blocked"
)

// Request is one parsed Elasticsearch console request.
type Request struct {
	Method               string   `json:"method"`
	Path                 string   `json:"path"`
	Body                 string   `json:"body,omitempty"`
	Kind                 Kind     `json:"kind"`
	BodyKind             BodyKind `json:"bodyKind"`
	Route                string   `json:"route"`
	Target               string   `json:"target,omitempty"`
	Risk                 Risk     `json:"risk"`
	IsWrite              bool     `json:"isWrite"`
	BlockReason          string   `json:"blockReason,omitempty"`
	ContainsScript       bool     `json:"containsScript,omitempty"`
	MayRunIngestPipeline bool     `json:"mayRunIngestPipeline,omitempty"`
	IngestTargets        []string `json:"ingestTargets,omitempty"`
	OperationCount       int      `json:"operationCount,omitempty"`
	BodySHA256           string   `json:"bodySha256"`
}

// Batch is an ordered group of Elasticsearch console requests.
type Batch struct {
	Requests             []Request `json:"requests"`
	Fingerprint          string    `json:"fingerprint"`
	ContainsWrite        bool      `json:"containsWrite"`
	ContainsScript       bool      `json:"containsScript"`
	RequiresConfirmation bool      `json:"requiresConfirmation"`
	Blocked              bool      `json:"blocked"`
}

// ParseSource parses Elasticsearch DevTools-style input.
func ParseSource(source, defaultIndex string) (Batch, error) {
	return ParseSourceForMajor(source, defaultIndex, 0)
}

// ParseSourceForMajor parses input with version-gated support for legacy typed
// document APIs. Unknown versions intentionally use the modern typeless policy.
func ParseSourceForMajor(source, defaultIndex string, serverMajor int) (Batch, error) {
	if len(source) > MaxSourceBytes {
		return Batch{}, parseError(CodeSourceTooLarge, "Elasticsearch console source exceeds 32 MiB", nil)
	}
	source = strings.ReplaceAll(source, "\r\n", "\n")
	trimmedSource := strings.TrimSpace(stripFullLineComments(source))
	if strings.HasPrefix(trimmedSource, "{") {
		return parseJSONDSL(trimmedSource, defaultIndex, serverMajor)
	}
	var batch Batch
	var current *Request
	var body strings.Builder
	flush := func() error {
		if current == nil {
			return nil
		}
		current.Body = body.String()
		batch.Requests = append(batch.Requests, *current)
		if len(batch.Requests) > MaxRequests {
			return parseError(CodeTooManyRequests, "Elasticsearch console batch exceeds 100 requests", nil)
		}
		current = nil
		body.Reset()
		return nil
	}

	lineIndex := 0
	for remaining := source; ; lineIndex++ {
		line := remaining
		if newline := strings.IndexByte(remaining, '\n'); newline >= 0 {
			line = remaining[:newline]
			remaining = remaining[newline+1:]
		} else {
			remaining = ""
		}
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") || strings.HasPrefix(trimmed, "//") {
			if remaining == "" {
				break
			}
			continue
		}
		method, requestPath, recognized, err := parseHeader(trimmed)
		if err != nil {
			if parseErr, ok := err.(*ParseError); ok {
				parseErr.Line = lineIndex + 1
			}
			return Batch{}, err
		}
		if recognized {
			if err := flush(); err != nil {
				return Batch{}, err
			}
			current = &Request{Method: method, Path: requestPath, Kind: KindREST, BodyKind: BodyNone}
		} else {
			if current == nil {
				return parseCompatibilityQuery(trimmedSource, defaultIndex, serverMajor)
			}
			if body.Len() > 0 {
				body.WriteByte('\n')
			}
			body.WriteString(line)
		}
		if remaining == "" {
			break
		}
	}
	if err := flush(); err != nil {
		return Batch{}, err
	}

	if len(batch.Requests) == 0 {
		return Batch{}, parseError(CodeEmptySource, "Elasticsearch console source is empty", nil)
	}
	if err := prepareBatch(&batch, serverMajor); err != nil {
		return Batch{}, err
	}
	finalizeBatch(&batch)
	return batch, nil
}

func stripFullLineComments(source string) string {
	var kept strings.Builder
	for remaining := source; ; {
		line := remaining
		if newline := strings.IndexByte(remaining, '\n'); newline >= 0 {
			line = remaining[:newline]
			remaining = remaining[newline+1:]
		} else {
			remaining = ""
		}
		trimmed := strings.TrimSpace(line)
		if !strings.HasPrefix(trimmed, "#") && !strings.HasPrefix(trimmed, "//") {
			if kept.Len() > 0 {
				kept.WriteByte('\n')
			}
			kept.WriteString(line)
		}
		if remaining == "" {
			break
		}
	}
	return kept.String()
}

func parseCompatibilityQuery(source, defaultIndex string, serverMajor int) (Batch, error) {
	trimmed := strings.TrimSpace(source)
	fields := strings.Fields(trimmed)
	if len(fields) > 0 && strings.EqualFold(fields[0], "SELECT") {
		return buildSimplifiedSelectRequest(trimmed, serverMajor)
	}
	if len(fields) == 0 || !strings.EqualFold(fields[0], "SELECT") {
		target := strings.TrimSpace(defaultIndex)
		if target == "" {
			target = "*"
		} else if err := validateDefaultIndex(target); err != nil {
			return Batch{}, err
		}
		body, err := json.Marshal(struct {
			Query map[string]map[string]string `json:"query"`
			Size  int                          `json:"size"`
		}{
			Query: map[string]map[string]string{"query_string": {"query": trimmed}},
			Size:  200,
		})
		if err != nil {
			return Batch{}, parseError(CodeInvalidJSON, "unable to encode Elasticsearch query_string request", err)
		}
		requestPath, _, err := normalizeRequestTarget("/" + target + "/_search")
		if err != nil {
			return Batch{}, err
		}
		batch := Batch{Requests: []Request{{
			Method:   "POST",
			Path:     requestPath,
			Body:     string(body),
			Kind:     KindREST,
			BodyKind: BodyJSON,
		}}}
		if err := prepareBatch(&batch, serverMajor); err != nil {
			return Batch{}, err
		}
		finalizeBatch(&batch)
		return batch, nil
	}
	return Batch{}, parseError(CodeInvalidHeader, "unsupported Elasticsearch compatibility query", nil)
}

func parseJSONDSL(source, defaultIndex string, serverMajor int) (Batch, error) {
	defaultIndex = strings.TrimSpace(defaultIndex)
	if defaultIndex == "" {
		return Batch{}, parseError(CodeDefaultIndexNeeded, "a default Elasticsearch index is required for JSON DSL", nil)
	}
	if err := validateDefaultIndex(defaultIndex); err != nil {
		return Batch{}, err
	}
	var compact bytes.Buffer
	if err := json.Compact(&compact, []byte(source)); err != nil {
		return Batch{}, parseError(CodeInvalidJSON, "invalid Elasticsearch JSON DSL", err)
	}
	requestPath, _, err := normalizeRequestTarget("/" + defaultIndex + "/_search")
	if err != nil {
		return Batch{}, err
	}
	req := Request{
		Method:   "POST",
		Path:     requestPath,
		Body:     compact.String(),
		Kind:     KindJSONDSL,
		BodyKind: BodyJSON,
		Risk:     RiskRead,
	}
	batch := Batch{Requests: []Request{req}}
	if err := prepareBatch(&batch, serverMajor); err != nil {
		return Batch{}, err
	}
	finalizeBatch(&batch)
	return batch, nil
}

func validateDefaultIndex(defaultIndex string) error {
	if defaultIndex == "." || defaultIndex == ".." || strings.ContainsAny(defaultIndex, "/\\?#%:") {
		return parseError(CodeUnsafePath, "Elasticsearch default index contains an unsafe path component", nil)
	}
	for _, r := range defaultIndex {
		if r < 0x20 || r == 0x7f || unicode.IsSpace(r) {
			return parseError(CodeUnsafePath, "Elasticsearch default index contains whitespace or a control character", nil)
		}
	}
	return nil
}

func finalizeBatch(batch *Batch) {
	batch.ContainsWrite = false
	batch.ContainsScript = false
	batch.RequiresConfirmation = false
	batch.Blocked = false
	h := sha256.New()
	for i := range batch.Requests {
		req := &batch.Requests[i]
		bodyDigest := sha256.Sum256([]byte(req.Body))
		req.BodySHA256 = hex.EncodeToString(bodyDigest[:])
		_, _ = fmt.Fprintf(h, "%s\x00%s\x00%s\x00%s\x00%s\x00", req.Kind, req.Method, req.Path, req.BodyKind, req.Body)
		batch.ContainsScript = batch.ContainsScript || req.ContainsScript
		if req.IsWrite {
			batch.ContainsWrite = true
		}
		switch req.Risk {
		case RiskDangerous:
			batch.RequiresConfirmation = true
		case RiskBlocked:
			batch.Blocked = true
		}
	}
	batch.Fingerprint = hex.EncodeToString(h.Sum(nil))
}

func parseHeader(line string) (method, requestPath string, recognized bool, err error) {
	separator := strings.IndexAny(line, " \t")
	if separator < 0 {
		return "", "", false, nil
	}
	method = strings.ToUpper(strings.TrimSpace(line[:separator]))
	rawTarget := strings.TrimSpace(line[separator:])
	if !isAllowedMethod(method) {
		if isHTTPMethod(method) || (looksLikeMethod(method) && strings.HasPrefix(rawTarget, "/")) {
			return "", "", true, parseError(CodeUnsupportedMethod, fmt.Sprintf("Elasticsearch console method %s is not supported", method), nil)
		}
		return "", "", false, nil
	}
	requestPath, _, err = normalizeRequestTarget(rawTarget)
	if err != nil {
		return "", "", true, err
	}
	return method, requestPath, true, nil
}

func looksLikeMethod(value string) bool {
	if value == "" {
		return false
	}
	for _, r := range value {
		if r < 'A' || r > 'Z' {
			return false
		}
	}
	return true
}

func isAllowedMethod(method string) bool {
	switch method {
	case "GET", "POST", "PUT", "DELETE", "HEAD":
		return true
	default:
		return false
	}
}

func isHTTPMethod(method string) bool {
	switch method {
	case "GET", "POST", "PUT", "DELETE", "HEAD", "PATCH", "OPTIONS", "CONNECT", "TRACE":
		return true
	default:
		return false
	}
}

func normalizeRequestTarget(rawTarget string) (normalized, decodedPath string, err error) {
	rawTarget = strings.TrimSpace(rawTarget)
	if rawTarget == "" || !strings.HasPrefix(rawTarget, "/") || strings.HasPrefix(rawTarget, "//") {
		return "", "", parseError(CodeUnsafePath, "Elasticsearch request target must be a relative path", nil)
	}
	if strings.Contains(rawTarget, "#") || strings.Contains(rawTarget, "\\") || strings.Contains(rawTarget, "://") {
		return "", "", parseError(CodeUnsafePath, "Elasticsearch request target contains an unsafe component", nil)
	}
	for _, r := range rawTarget {
		if r < 0x20 || r == 0x7f || unicode.IsSpace(r) {
			return "", "", parseError(CodeUnsafePath, "Elasticsearch request target contains whitespace or control characters", nil)
		}
	}

	lowerTarget := strings.ToLower(rawTarget)
	if strings.Contains(lowerTarget, "%2f") || strings.Contains(lowerTarget, "%5c") || strings.Contains(lowerTarget, "%25") {
		return "", "", parseError(CodeUnsafePath, "Elasticsearch request target contains forbidden encoded separators", nil)
	}

	parsed, parseErr := url.ParseRequestURI(rawTarget)
	if parseErr != nil || parsed.IsAbs() || parsed.Host != "" || parsed.User != nil || parsed.Fragment != "" {
		return "", "", parseError(CodeUnsafePath, "Elasticsearch request target is not a safe relative URI", parseErr)
	}
	decodedPath, parseErr = url.PathUnescape(parsed.EscapedPath())
	if parseErr != nil || decodedPath == "" || !strings.HasPrefix(decodedPath, "/") || strings.Contains(decodedPath, "//") || strings.Contains(decodedPath, "\\") {
		return "", "", parseError(CodeUnsafePath, "Elasticsearch request path is invalid", parseErr)
	}
	for _, segment := range strings.Split(decodedPath, "/") {
		if segment == "." || segment == ".." {
			return "", "", parseError(CodeUnsafePath, "Elasticsearch request path contains a dot segment", nil)
		}
		for _, r := range segment {
			if r < 0x20 || r == 0x7f {
				return "", "", parseError(CodeUnsafePath, "Elasticsearch request path contains a control character", nil)
			}
		}
	}
	if parsed.RawQuery != "" {
		values, queryErr := url.ParseQuery(parsed.RawQuery)
		if queryErr != nil {
			return "", "", parseError(CodeUnsafePath, "Elasticsearch request query is invalid", queryErr)
		}
		for key, entries := range values {
			if strings.EqualFold(key, "source") || strings.EqualFold(key, "source_content_type") {
				return "", "", parseError(CodeUnsafePath, "Elasticsearch request bodies in query parameters are not allowed", nil)
			}
			if containsControl(key) {
				return "", "", parseError(CodeUnsafePath, "Elasticsearch request query contains a control character", nil)
			}
			for _, value := range entries {
				if containsControl(value) {
					return "", "", parseError(CodeUnsafePath, "Elasticsearch request query contains a control character", nil)
				}
			}
		}
	}

	normalized = normalizePercentHex(parsed.EscapedPath())
	if parsed.RawQuery != "" {
		normalized += "?" + normalizePercentHex(parsed.RawQuery)
	}
	return normalized, decodedPath, nil
}

func containsControl(value string) bool {
	for _, r := range value {
		if r < 0x20 || r == 0x7f {
			return true
		}
	}
	return false
}

func normalizePercentHex(value string) string {
	const hexDigits = "0123456789ABCDEF"
	bytesValue := []byte(value)
	for i := 0; i+2 < len(bytesValue); i++ {
		if bytesValue[i] != '%' {
			continue
		}
		for offset := 1; offset <= 2; offset++ {
			c := bytesValue[i+offset]
			switch {
			case c >= 'a' && c <= 'f':
				bytesValue[i+offset] = hexDigits[int(c-'a')+10]
			}
		}
		i += 2
	}
	return string(bytesValue)
}
