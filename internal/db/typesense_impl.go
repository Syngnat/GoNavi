//go:build gonavi_full_drivers || gonavi_typesense_driver

package db

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/ssh"
)

const (
	defaultTypesensePort         = 8108
	typesenseDatabaseName        = "default"
	defaultTypesenseQueryTimeout = 60 * time.Second
	// typesenseDefaultSelectLimit 是 SELECT 没写 LIMIT 时的行数：读取全部（导出、备份与迁移按全表读取；
	// 控制台的 SELECT 由编辑器自动补上 LIMIT），按每页 250 条分段读取。
	typesenseDefaultSelectLimit = math.MaxInt32
	// typesenseMaxPerPage 是搜索接口每页条数上限（服务端限制 250）。
	typesenseMaxPerPage = 250
	// typesenseScanLimit 是客户端筛选 / 排序时最多扫描的文档数：超过时要求改用可过滤 / 可排序的字段。
	typesenseScanLimit  = 50000
	typesenseMetaTTL    = 15 * time.Second
	typesenseScanTTL    = 30 * time.Second
	typesenseSampleSize = 50
	// typesenseDeleteBatch 是按 id 批量删除时一条 filter_by 里的 id 个数。
	typesenseDeleteBatch = 200
)

// TypesenseDB 通过 REST 接口访问 Typesense。没有库的概念：导航树只有一个 default 库，集合对应表，
// 文档按字符串 id 定位。写入是同步的，接口直接返回结果。
type TypesenseDB struct {
	driverVariantState
	client    *http.Client
	baseURL   string
	headers   map[string]string
	forwarder *ssh.LocalForwarder

	mu        sync.Mutex
	metaCache map[string]*typesenseCollectionMeta
	scanCache *typesenseScanEntry
}

var (
	_ Database              = (*TypesenseDB)(nil)
	_ BatchApplierContext   = (*TypesenseDB)(nil)
	_ QueryContexter        = (*TypesenseDB)(nil)
	_ ExecContexter         = (*TypesenseDB)(nil)
	_ DriverVariantReporter = (*TypesenseDB)(nil)
)

// typesenseHTTPError 是服务端返回的非 2xx 响应。
type typesenseHTTPError struct {
	status  int
	detail  string
	message string
}

func (e *typesenseHTTPError) Error() string { return e.message }

// Connect 读取 /debug 确定驱动档位；key 没有 debug 权限时改用 /collections 校验 key，版本按所选档位。
func (t *TypesenseDB) Connect(config connection.ConnectionConfig) (err error) {
	_ = t.Close()
	defer func() {
		if err != nil {
			_ = t.Close()
		}
	}()

	runConfig := normalizeRegistryHTTPConfig(config, defaultTypesensePort, "typesense")
	if runConfig.UseSSH {
		if runConfig, t.forwarder, err = forwardRegistryHTTPThroughSSH(runConfig, "Typesense"); err != nil {
			return err
		}
	}
	t.baseURL = registryHTTPBaseURL(runConfig)
	t.headers = typesenseAuthHeaders(runConfig)
	t.client = buildRegistryHTTPClient(runConfig)

	ctx, cancel := context.WithTimeout(context.Background(), getConnectTimeout(runConfig))
	defer cancel()
	version, err := t.checkAccess(ctx)
	if err != nil {
		return err
	}
	return t.resolve("typesense", config, version)
}

// checkAccess 返回服务端版本；key 没有 debug 权限但能列集合时版本为空。
func (t *TypesenseDB) checkAccess(ctx context.Context) (string, error) {
	var debug struct {
		Version string `json:"version"`
	}
	err := t.doJSON(ctx, http.MethodGet, "/debug", nil, &debug)
	if err == nil {
		return debug.Version, nil
	}
	var httpErr *typesenseHTTPError
	if !errors.As(err, &httpErr) || (httpErr.status != http.StatusUnauthorized && httpErr.status != http.StatusForbidden) {
		return "", err
	}
	if _, listErr := t.doRaw(ctx, http.MethodGet, "/collections", nil); listErr != nil {
		return "", listErr
	}
	return "", nil
}

// typesenseAuthHeaders 组装认证头：API key（密码字段或 apiKey 参数）放进 X-TYPESENSE-API-KEY；
// header.<名称>=<值> 参数原样带上。
func typesenseAuthHeaders(config connection.ConnectionConfig) map[string]string {
	headers := make(map[string]string)
	params := registryHTTPConnectionParams(config, "typesense")
	apiKey := strings.TrimSpace(firstNonEmptyParam(params, "apiKey", "apikey", "api_key", "api-key", "key"))
	if apiKey == "" {
		apiKey = strings.TrimSpace(config.Password)
	}
	if apiKey != "" {
		headers["X-TYPESENSE-API-KEY"] = apiKey
	}
	for name, value := range registryHTTPHeaderParams(params) {
		headers[name] = value
	}
	return headers
}

// Close 释放 SSH 转发并清空缓存。
func (t *TypesenseDB) Close() error {
	releaseRegistryHTTPForwarder(t.forwarder, "Typesense")
	t.forwarder = nil
	t.client = nil
	t.invalidate("")
	return nil
}

// Ping 重新校验地址与 key：/health 不需要认证，不能代表 key 仍然有效。
func (t *TypesenseDB) Ping() error {
	if t.client == nil {
		return localizedDatabaseRuntimeError("db.backend.error.connection_not_open", nil)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_, err := t.checkAccess(ctx)
	return err
}

// 各版本接口差异：0.23 起搜索结果跨页稳定、非 facet 字符串可精确过滤、id 可过滤、导出可带 filter_by、部分更新写 null 即删除字段；
// 0.24 起过滤支持 || 与括号；0.25 起数值字段可用 !=、搜索支持 offset / limit；26 起 id 可用 !=；29 起可 truncate 清空。

func (t *TypesenseDB) supportsExactFilter() bool  { return t.atLeast("0.23") }
func (t *TypesenseDB) supportsOrFilter() bool     { return t.atLeast("0.24") }
func (t *TypesenseDB) supportsNumericNotEq() bool { return t.atLeast("0.25") }
func (t *TypesenseDB) supportsOffsetLimit() bool  { return t.atLeast("0.25") }
func (t *TypesenseDB) supportsIDNotEq() bool      { return t.atLeast("26.0") }
func (t *TypesenseDB) supportsTruncate() bool     { return t.atLeast("29.0") }
func (t *TypesenseDB) nullRemovesOptional() bool  { return t.atLeast("0.23") }
func (t *TypesenseDB) stableSearchPaging() bool   { return t.atLeast("0.23") }

// newRequest 组装带认证头的请求；contentType 为空时不带请求体类型。
func (t *TypesenseDB) newRequest(ctx context.Context, method, path string, body []byte, contentType string) (*http.Request, error) {
	if t.client == nil {
		return nil, localizedDatabaseRuntimeError("db.backend.error.connection_not_open", nil)
	}
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, strings.TrimRight(t.baseURL, "/")+path, reader)
	if err != nil {
		return nil, err
	}
	if body != nil && contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	req.Header.Set("Accept", "application/json")
	for key, value := range t.headers {
		req.Header.Set(key, value)
	}
	return req, nil
}

// doRaw 发出 JSON 请求并返回 2xx 响应体；导入接口的请求体是 JSON Lines，按纯文本发送。
func (t *TypesenseDB) doRaw(ctx context.Context, method, path string, body []byte) ([]byte, error) {
	contentType := "application/json"
	if strings.Contains(path, "/documents/import") {
		contentType = "text/plain"
	}
	req, err := t.newRequest(ctx, method, path, body, contentType)
	if err != nil {
		return nil, err
	}
	res, err := t.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	resBody, err := readLimitedJSONResponseBody(res.Body)
	if err != nil {
		return nil, err
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, typesenseResponseError(method, path, res, resBody)
	}
	return resBody, nil
}

// doStream 发出请求并返回 2xx 响应体流（导出接口可能很大，不整体读入内存）。
func (t *TypesenseDB) doStream(ctx context.Context, method, path string) (io.ReadCloser, error) {
	req, err := t.newRequest(ctx, method, path, nil, "")
	if err != nil {
		return nil, err
	}
	res, err := t.client.Do(req)
	if err != nil {
		return nil, err
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		defer res.Body.Close()
		resBody, _ := readLimitedJSONResponseBody(res.Body)
		return nil, typesenseResponseError(method, path, res, resBody)
	}
	return res.Body, nil
}

func typesenseResponseError(method, path string, res *http.Response, body []byte) error {
	detail := typesenseErrorDetail(body)
	if detail == "" {
		detail = res.Status
	}
	return &typesenseHTTPError{
		status: res.StatusCode,
		detail: detail,
		message: localizedDriverRuntimeText("db.backend.error.typesense_request_failed", map[string]any{
			"method": method,
			"path":   path,
			"detail": detail,
		}),
	}
}

// doJSON 发出 JSON 请求并把响应解码到 out（out 为 nil 时忽略响应体）。
func (t *TypesenseDB) doJSON(ctx context.Context, method, path string, body interface{}, out interface{}) error {
	var payload []byte
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return err
		}
		payload = encoded
	}
	resBody, err := t.doRaw(ctx, method, path, payload)
	if err != nil {
		return err
	}
	if out == nil || len(bytes.TrimSpace(resBody)) == 0 {
		return nil
	}
	return decodeJSONWithUseNumber(resBody, out)
}

func typesenseErrorDetail(body []byte) string {
	var payload struct {
		Message string `json:"message"`
	}
	if err := json.Unmarshal(body, &payload); err != nil || payload.Message == "" {
		return strings.TrimSpace(string(body))
	}
	return payload.Message
}

// typesenseStatus 报告错误是否为指定 HTTP 状态的服务端拒绝。
func typesenseStatus(err error, status int) bool {
	var httpErr *typesenseHTTPError
	return errors.As(err, &httpErr) && httpErr.status == status
}

func typesenseCollectionPath(name string, suffix string) string {
	return "/collections/" + url.PathEscape(name) + suffix
}

// typesenseWriteError 区分服务端拒绝与传输失败：后者请求可能已经生效，标记为结果未知。
func typesenseWriteError(err error) error {
	var httpErr *typesenseHTTPError
	if errors.As(err, &httpErr) || errors.Is(err, context.Canceled) {
		return err
	}
	return MarkWriteOutcomeUnknown(err)
}

// invalidate 让集合元数据与客户端扫描缓存失效；name 为空时全部失效。
func (t *TypesenseDB) invalidate(name string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if name == "" {
		t.metaCache = nil
	} else {
		delete(t.metaCache, name)
	}
	if t.scanCache != nil && (name == "" || t.scanCache.collection == name) {
		t.scanCache = nil
	}
}
