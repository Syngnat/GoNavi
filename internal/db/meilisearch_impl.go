//go:build gonavi_full_drivers || gonavi_meilisearch_driver

package db

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/ssh"
)

const (
	defaultMeilisearchPort         = 7700
	meilisearchDatabaseName        = "default"
	defaultMeilisearchQueryTimeout = 60 * time.Second
	// meilisearchPageSize 是逐页读取索引列表与文档时的每页条数。
	meilisearchPageSize = 1000
	// meilisearchScanLimit 是客户端筛选 / 排序时最多扫描的文档数：超过时要求把字段设为可过滤 / 可排序。
	meilisearchScanLimit   = 50000
	meilisearchMetaTTL     = 15 * time.Second
	meilisearchScanTTL     = 30 * time.Second
	meilisearchSampleSize  = 100
	meilisearchTaskTimeout = 30 * time.Second
)

// MeilisearchDB 通过 REST 接口访问 Meilisearch。没有库的概念：导航树只有一个 default 库，索引对应表，
// 文档按主键（primaryKey）定位。写入都是异步任务，驱动等任务结束后再返回结果。
type MeilisearchDB struct {
	driverVariantState
	client    *http.Client
	baseURL   string
	headers   map[string]string
	forwarder *ssh.LocalForwarder

	mu        sync.Mutex
	metaCache map[string]*meilisearchIndexMeta
	scanCache *meilisearchScanEntry
}

var (
	_ Database              = (*MeilisearchDB)(nil)
	_ BatchApplierContext   = (*MeilisearchDB)(nil)
	_ QueryContexter        = (*MeilisearchDB)(nil)
	_ ExecContexter         = (*MeilisearchDB)(nil)
	_ DriverVariantReporter = (*MeilisearchDB)(nil)
)

// meilisearchHTTPError 是服务端返回的非 2xx 响应；code 是 Meilisearch 的错误码（0.20 是 errorCode）。
type meilisearchHTTPError struct {
	status  int
	code    string
	message string
}

func (e *meilisearchHTTPError) Error() string { return e.message }

// Connect 读取 /version 确定驱动档位；只有搜索权限的 key 读不了 /version 时改用 /indexes 校验 key，版本按所选档位。
func (m *MeilisearchDB) Connect(config connection.ConnectionConfig) (err error) {
	_ = m.Close()
	defer func() {
		if err != nil {
			_ = m.Close()
		}
	}()

	runConfig := normalizeRegistryHTTPConfig(config, defaultMeilisearchPort, "meilisearch")
	if runConfig.UseSSH {
		if runConfig, m.forwarder, err = forwardRegistryHTTPThroughSSH(runConfig, "Meilisearch"); err != nil {
			return err
		}
	}
	m.baseURL = registryHTTPBaseURL(runConfig)
	m.headers = meilisearchAuthHeaders(runConfig)
	m.client = buildRegistryHTTPClient(runConfig)

	ctx, cancel := context.WithTimeout(context.Background(), getConnectTimeout(runConfig))
	defer cancel()
	version, err := m.checkAccess(ctx)
	if err != nil {
		return err
	}
	return m.resolve("meilisearch", config, version)
}

// checkAccess 返回服务端版本；key 没有 version 权限但能列索引时版本为空。
func (m *MeilisearchDB) checkAccess(ctx context.Context) (string, error) {
	var info struct {
		PkgVersion string `json:"pkgVersion"`
	}
	err := m.doJSON(ctx, http.MethodGet, "/version", nil, &info)
	if err == nil {
		return info.PkgVersion, nil
	}
	var httpErr *meilisearchHTTPError
	if !errors.As(err, &httpErr) || (httpErr.status != http.StatusUnauthorized && httpErr.status != http.StatusForbidden) {
		return "", err
	}
	if _, listErr := m.doRaw(ctx, http.MethodGet, "/indexes", nil); listErr != nil {
		return "", err
	}
	return "", nil
}

// meilisearchAuthHeaders 组装认证头：master key / API key（密码字段或 apiKey 参数）同时放进 Authorization: Bearer
// （0.25 起）与 X-Meili-API-Key（0.25 之前），各版本只认自己的那个；header.<名称>=<值> 参数原样带上。
func meilisearchAuthHeaders(config connection.ConnectionConfig) map[string]string {
	headers := make(map[string]string)
	params := registryHTTPConnectionParams(config, "meilisearch")
	apiKey := strings.TrimSpace(firstNonEmptyParam(params, "apiKey", "apikey", "api-key", "masterKey", "key", "token"))
	if apiKey == "" {
		apiKey = strings.TrimSpace(config.Password)
	}
	if apiKey != "" {
		headers["Authorization"] = "Bearer " + apiKey
		headers["X-Meili-API-Key"] = apiKey
	}
	for name, value := range registryHTTPHeaderParams(params) {
		headers[name] = value
	}
	return headers
}

// Close 释放 SSH 转发并清空缓存。
func (m *MeilisearchDB) Close() error {
	releaseRegistryHTTPForwarder(m.forwarder, "Meilisearch")
	m.forwarder = nil
	m.client = nil
	m.invalidate("")
	return nil
}

// Ping 重新校验地址与 key：/health 不需要认证，不能代表 key 仍然有效。
func (m *MeilisearchDB) Ping() error {
	if m.client == nil {
		return localizedDatabaseRuntimeError("db.backend.error.connection_not_open", nil)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_, err := m.checkAccess(ctx)
	return err
}

// 各版本接口差异：0.21 起用 filter 参数（0.20 是旧语法的 filters），0.23 起可排序，0.28 起列表接口分页返回
// {results, total}、任务号字段改为 taskUid、设置用 PATCH 更新，0.29 起过滤支持 IN / EXISTS，0.30 起搜索可按
// hitsPerPage 返回精确总数，1.2 起文档接口可带过滤条件并支持 IS NULL / IS EMPTY，1.16 起文档接口可排序、
// 字符串可比较大小。

func (m *MeilisearchDB) supportsFilter() bool           { return m.atLeast("0.21") }
func (m *MeilisearchDB) supportsSort() bool             { return m.atLeast("0.23") }
func (m *MeilisearchDB) paginatedLists() bool           { return m.atLeast("0.28") }
func (m *MeilisearchDB) supportsInExists() bool         { return m.atLeast("0.29") }
func (m *MeilisearchDB) supportsExactSearchTotal() bool { return m.atLeast("0.30") }
func (m *MeilisearchDB) supportsDocumentFilter() bool   { return m.atLeast("1.2") }
func (m *MeilisearchDB) supportsDocumentSort() bool     { return m.atLeast("1.16") }

// doRaw 发出请求并返回 2xx 响应体；body 为 nil 时不带请求体。
func (m *MeilisearchDB) doRaw(ctx context.Context, method, path string, body []byte) ([]byte, error) {
	if m.client == nil {
		return nil, localizedDatabaseRuntimeError("db.backend.error.connection_not_open", nil)
	}
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, strings.TrimRight(m.baseURL, "/")+path, reader)
	if err != nil {
		return nil, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Accept", "application/json")
	for key, value := range m.headers {
		req.Header.Set(key, value)
	}
	res, err := m.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	resBody, err := readLimitedJSONResponseBody(res.Body)
	if err != nil {
		return nil, err
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		code, detail := meilisearchErrorDetail(resBody)
		if detail == "" {
			detail = res.Status
		}
		return nil, &meilisearchHTTPError{
			status: res.StatusCode,
			code:   code,
			message: localizedDriverRuntimeText("db.backend.error.meilisearch_request_failed", map[string]any{
				"method": method,
				"path":   path,
				"detail": detail,
			}),
		}
	}
	return resBody, nil
}

// doJSON 发出 JSON 请求并把响应解码到 out（out 为 nil 时忽略响应体）。
func (m *MeilisearchDB) doJSON(ctx context.Context, method, path string, body interface{}, out interface{}) error {
	var payload []byte
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return err
		}
		payload = encoded
	}
	resBody, err := m.doRaw(ctx, method, path, payload)
	if err != nil {
		return err
	}
	if out == nil || len(bytes.TrimSpace(resBody)) == 0 {
		return nil
	}
	return decodeJSONWithUseNumber(resBody, out)
}

// meilisearchErrorDetail 取错误响应里的错误码与消息（0.20 的字段是 errorCode）。
func meilisearchErrorDetail(body []byte) (string, string) {
	var payload struct {
		Message   string `json:"message"`
		Code      string `json:"code"`
		ErrorCode string `json:"errorCode"`
	}
	if err := json.Unmarshal(body, &payload); err != nil || payload.Message == "" {
		return "", strings.TrimSpace(string(body))
	}
	code := payload.Code
	if code == "" {
		code = payload.ErrorCode
	}
	return code, payload.Message
}

// isMeilisearchErrorCode 报告错误是否为指定错误码之一的服务端拒绝。
func isMeilisearchErrorCode(err error, codes ...string) bool {
	var httpErr *meilisearchHTTPError
	if !errors.As(err, &httpErr) {
		return false
	}
	for _, code := range codes {
		if httpErr.code == code {
			return true
		}
	}
	return false
}

func meilisearchIndexPath(uid string, suffix string) string {
	return "/indexes/" + url.PathEscape(uid) + suffix
}

// invalidate 让索引元数据与客户端扫描缓存失效；uid 为空时全部失效。
func (m *MeilisearchDB) invalidate(uid string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if uid == "" {
		m.metaCache = nil
	} else {
		delete(m.metaCache, uid)
	}
	if m.scanCache != nil && (uid == "" || m.scanCache.uid == uid) {
		m.scanCache = nil
	}
}
