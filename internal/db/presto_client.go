//go:build gonavi_full_drivers || gonavi_presto_driver

package db

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"maps"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"time"
)

// Presto 客户端协议：POST /v1/statement 提交语句，沿响应里的 nextUri 轮询取数，直到没有 nextUri；
// 中途放弃时对 nextUri 发 DELETE 取消查询。PrestoDB 与 PrestoSQL（Trino 改名前）都使用 X-Presto-* 请求头。

const (
	prestoMaxErrorBodyBytes = 8 << 10
	prestoMaxRetryDelay     = time.Second
	prestoCancelTimeout     = 10 * time.Second
	prestoTransportRetries  = 3
)

// errPrestoStopFetching 由页处理函数返回，表示后续数据不再需要（结果预算用尽、模拟 OFFSET 已取够）。
var errPrestoStopFetching = errors.New("presto: stop fetching")

type prestoClient struct {
	http    *http.Client
	baseURL string
	user    string
	// headers 是每个请求都带的固定请求头：认证、来源、客户端能力、时区与 header.* 自定义头。
	headers map[string]string
	// properties 是连接级会话属性（连接参数与档位需要的属性），语句里的 SET SESSION 会覆盖同名属性。
	properties map[string]string
}

type prestoColumn struct {
	Name string `json:"name"`
	Type string `json:"type"`
}

type prestoErrorInfo struct {
	Message       string `json:"message"`
	ErrorCode     int    `json:"errorCode"`
	ErrorName     string `json:"errorName"`
	ErrorType     string `json:"errorType"`
	ErrorLocation *struct {
		LineNumber   int `json:"lineNumber"`
		ColumnNumber int `json:"columnNumber"`
	} `json:"errorLocation"`
}

type prestoQueryResults struct {
	ID          string           `json:"id"`
	NextURI     string           `json:"nextUri"`
	Columns     []prestoColumn   `json:"columns"`
	Data        [][]interface{}  `json:"data"`
	Error       *prestoErrorInfo `json:"error"`
	UpdateType  string           `json:"updateType"`
	UpdateCount *int64           `json:"updateCount"`
}

// prestoQueryError 是服务端判定失败的语句（语法、权限、连接器不支持等），语句确定没有生效。
type prestoQueryError struct {
	queryID string
	info    prestoErrorInfo
}

func (e *prestoQueryError) Error() string {
	name := strings.TrimSpace(e.info.ErrorName)
	if name == "" {
		name = strings.TrimSpace(e.info.ErrorType)
	}
	message := strings.TrimSpace(e.info.Message)
	if location := e.info.ErrorLocation; location != nil && location.LineNumber > 0 {
		return localizedDriverRuntimeText("db.backend.error.presto_query_failed_at", map[string]any{
			"name":    name,
			"message": message,
			"line":    location.LineNumber,
			"column":  location.ColumnNumber,
		})
	}
	return localizedDriverRuntimeText("db.backend.error.presto_query_failed", map[string]any{"name": name, "message": message})
}

// prestoHTTPError 是非 200 的 HTTP 响应（认证失败、网关错误、地址不是 Presto 等）。
type prestoHTTPError struct {
	status  int
	message string
}

func (e *prestoHTTPError) Error() string { return e.message }

func newPrestoHTTPError(status int, body []byte) error {
	detail := strings.TrimSpace(string(body))
	if len(detail) > 512 {
		detail = detail[:512] + "…"
	}
	if detail == "" {
		detail = http.StatusText(status)
	}
	key := "db.backend.error.presto_http_failed"
	if status == http.StatusUnauthorized || status == http.StatusForbidden {
		key = "db.backend.error.presto_auth_failed"
	}
	return &prestoHTTPError{status: status, message: localizedDriverRuntimeText(key, map[string]any{"status": status, "detail": detail})}
}

// prestoResultSink 接收一条语句的结果：列在第一次出现时回调一次（空结果也回调），数据按页回调。
type prestoResultSink interface {
	columns(columns []prestoColumn) error
	rows(columns []prestoColumn, page [][]interface{}) error
}

// prestoOutcome 是语句执行结束后的汇总；submitted 表示语句已被服务端接收（写语句之后的传输错误结果未知）。
type prestoOutcome struct {
	queryID     string
	columns     []prestoColumn
	updateType  string
	updateCount *int64
	firstValue  interface{}
	submitted   bool
}

// execute 提交一条语句并取完全部结果。prepared 是本条语句额外带上的预编译语句（EXECUTE 参数化查询用），
// sink 为 nil 时只关心执行结果（写语句、DDL、会话语句）。语句末尾的分号会被去掉：协议只接受单条语句。
func (c *prestoClient) execute(ctx context.Context, session *prestoSession, query string, prepared map[string]string, sink prestoResultSink) (prestoOutcome, error) {
	var outcome prestoOutcome
	headers := c.requestHeaders(session, prepared)
	statement := strings.TrimRight(strings.TrimSpace(query), "; \t\r\n")
	results, err := c.roundTrip(ctx, session, http.MethodPost, c.baseURL+"/v1/statement", []byte(statement), headers)
	if err != nil {
		return outcome, err
	}
	outcome.submitted = true
	columnsSent := false
	for {
		outcome.queryID = results.ID
		if results.Error != nil {
			return outcome, &prestoQueryError{queryID: results.ID, info: *results.Error}
		}
		if results.UpdateType != "" {
			outcome.updateType = results.UpdateType
		}
		if results.UpdateCount != nil {
			outcome.updateCount = results.UpdateCount
		}
		if outcome.columns == nil && len(results.Columns) > 0 {
			outcome.columns = results.Columns
		}
		if len(results.Data) > 0 && outcome.firstValue == nil && len(results.Data[0]) > 0 {
			outcome.firstValue = results.Data[0][0]
		}
		if sink != nil && outcome.columns != nil {
			if !columnsSent {
				columnsSent = true
				if err := sink.columns(outcome.columns); err != nil {
					return outcome, c.abandon(results.NextURI, err)
				}
			}
			if len(results.Data) > 0 {
				if err := sink.rows(outcome.columns, results.Data); err != nil {
					return outcome, c.abandon(results.NextURI, err)
				}
			}
		}
		if results.NextURI == "" {
			return outcome, nil
		}
		next, err := c.roundTrip(ctx, session, http.MethodGet, results.NextURI, nil, c.pollHeaders())
		if err != nil {
			return outcome, c.abandon(results.NextURI, err)
		}
		results = next
	}
}

// abandon 在提前结束时取消服务端查询；errPrestoStopFetching 视为正常结束。
func (c *prestoClient) abandon(nextURI string, cause error) error {
	if nextURI != "" {
		go c.cancel(nextURI)
	}
	if errors.Is(cause, errPrestoStopFetching) {
		return nil
	}
	return cause
}

func (c *prestoClient) cancel(nextURI string) {
	ctx, cancel := context.WithTimeout(context.Background(), prestoCancelTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, nextURI, nil)
	if err != nil {
		return
	}
	for name, value := range c.pollHeaders() {
		req.Header[name] = value
	}
	if res, err := c.http.Do(req); err == nil {
		_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, prestoMaxErrorBodyBytes))
		_ = res.Body.Close()
	}
}

// roundTrip 发一次协议请求：503（协调节点繁忙）一律重试；GET 轮询在传输错误与网关错误时重试，POST 不重试，避免重复提交。
func (c *prestoClient) roundTrip(ctx context.Context, session *prestoSession, method, target string, body []byte, headers http.Header) (*prestoQueryResults, error) {
	if c == nil || c.http == nil {
		return nil, localizedDatabaseRuntimeError("db.backend.error.connection_not_open", nil)
	}
	delay := 50 * time.Millisecond
	failures := 0
	for {
		var reader io.Reader
		if body != nil {
			reader = bytes.NewReader(body)
		}
		req, err := http.NewRequestWithContext(ctx, method, target, reader)
		if err != nil {
			return nil, err
		}
		for name, value := range headers {
			req.Header[name] = value
		}
		res, err := c.http.Do(req)
		if err != nil {
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			if method != http.MethodGet || failures >= prestoTransportRetries {
				return nil, err
			}
			failures++
		} else {
			retry := res.StatusCode == http.StatusServiceUnavailable ||
				(method == http.MethodGet && (res.StatusCode == http.StatusBadGateway || res.StatusCode == http.StatusGatewayTimeout))
			if !retry {
				return c.decodeResults(res, session)
			}
			_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, prestoMaxErrorBodyBytes))
			_ = res.Body.Close()
		}
		if err := sleepContext(ctx, delay); err != nil {
			return nil, err
		}
		if delay *= 2; delay > prestoMaxRetryDelay {
			delay = prestoMaxRetryDelay
		}
	}
}

func (c *prestoClient) decodeResults(res *http.Response, session *prestoSession) (*prestoQueryResults, error) {
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		detail, _ := io.ReadAll(io.LimitReader(res.Body, prestoMaxErrorBodyBytes))
		return nil, newPrestoHTTPError(res.StatusCode, detail)
	}
	if session != nil {
		session.absorb(res.Header)
	}
	payload, err := readLimitedJSONResponseBody(res.Body)
	if err != nil {
		return nil, err
	}
	var results prestoQueryResults
	if err := decodeJSONWithUseNumber(payload, &results); err != nil {
		return nil, localizedDatabaseRuntimeError("db.backend.error.presto_unexpected_response", map[string]any{"detail": err.Error()})
	}
	return &results, nil
}

// requestHeaders 组装提交语句的请求头：固定头 + 会话状态 + 本条语句的预编译语句。
func (c *prestoClient) requestHeaders(session *prestoSession, prepared map[string]string) http.Header {
	headers := c.pollHeaders()
	headers.Set("Content-Type", "text/plain; charset=utf-8")
	if session == nil {
		session = newPrestoSession("", "")
	}
	session.writeHeaders(headers, c.properties, prepared)
	return headers
}

// pollHeaders 是轮询与取消请求的头：只带身份与认证，会话状态以服务端为准。
func (c *prestoClient) pollHeaders() http.Header {
	headers := make(http.Header, len(c.headers)+2)
	headers.Set("Accept", "application/json")
	headers.Set("X-Presto-User", c.user)
	for name, value := range c.headers {
		headers.Set(name, value)
	}
	return headers
}

// encodePrestoKeyValues 按协议编码 name=value 列表（值做 URL 编码），用于 X-Presto-Session 等请求头。
func encodePrestoKeyValues(values map[string]string) string {
	parts := make([]string, 0, len(values))
	for _, name := range slices.Sorted(maps.Keys(values)) {
		parts = append(parts, name+"="+url.QueryEscape(values[name]))
	}
	return strings.Join(parts, ",")
}

// decodePrestoKeyValue 解析响应头里的 name=value（值经过 URL 编码）。
func decodePrestoKeyValue(text string) (string, string, bool) {
	name, value, ok := strings.Cut(strings.TrimSpace(text), "=")
	if !ok || strings.TrimSpace(name) == "" {
		return "", "", false
	}
	decoded, err := url.QueryUnescape(value)
	if err != nil {
		decoded = value
	}
	return strings.TrimSpace(name), decoded, true
}

func sleepContext(ctx context.Context, delay time.Duration) error {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

// prestoAffectedRows 取写语句的影响行数：优先 updateCount，其次 INSERT / CTAS / DELETE 返回的单列 rows。
func prestoAffectedRows(outcome prestoOutcome) int64 {
	if outcome.updateCount != nil {
		return *outcome.updateCount
	}
	if len(outcome.columns) != 1 || !strings.EqualFold(outcome.columns[0].Name, "rows") {
		return 0
	}
	switch value := outcome.firstValue.(type) {
	case json.Number:
		if count, err := strconv.ParseInt(value.String(), 10, 64); err == nil {
			return count
		}
	case float64:
		return int64(value)
	}
	return 0
}
