//go:build gonavi_full_drivers || gonavi_weaviate_driver

package db

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"

	"GoNavi-Wails/internal/connection"
)

// weaviateHTTPError 是服务端已返回的 HTTP 错误；传输层错误不是这个类型，写入时据此判断结果是否未知。
type weaviateHTTPError struct {
	status  int
	message string
}

func (e *weaviateHTTPError) Error() string { return e.message }

// normalizeWeaviateConfig 解析 http(s):// 与 weaviate:// 连接串，补默认主机与端口。
func normalizeWeaviateConfig(config connection.ConnectionConfig) connection.ConnectionConfig {
	return normalizeRegistryHTTPConfig(config, defaultWeaviatePort, "weaviate")
}

func weaviateConnectionParams(config connection.ConnectionConfig) url.Values {
	return registryHTTPConnectionParams(config, "weaviate")
}

// weaviateTenantFromConfig 返回当前租户：导航树选中的库（default 表示不指定租户），其次是 tenant 连接参数。
func weaviateTenantFromConfig(config connection.ConnectionConfig) string {
	if name := strings.TrimSpace(config.Database); name != "" && name != weaviateDefaultNamespace {
		return name
	}
	return strings.TrimSpace(weaviateConnectionParams(config).Get("tenant"))
}

// weaviateAuthHeaders 组装认证头：API key（密码字段或 apiKey 参数）走 Bearer；
// header.<名称>=<值> 参数原样带上，用于向量化模块的密钥（如 header.X-OpenAI-Api-Key）。
func weaviateAuthHeaders(config connection.ConnectionConfig) map[string]string {
	headers := make(map[string]string)
	params := weaviateConnectionParams(config)
	apiKey := ""
	for _, name := range []string{"apiKey", "apikey", "api-key", "token", "authToken"} {
		if value := strings.TrimSpace(params.Get(name)); value != "" {
			apiKey = value
			break
		}
	}
	if apiKey == "" {
		apiKey = strings.TrimSpace(config.Password)
	}
	if apiKey != "" {
		headers["Authorization"] = "Bearer " + apiKey
	}
	for name, value := range registryHTTPHeaderParams(params) {
		headers[name] = value
	}
	return headers
}

// doRaw 发出请求并返回 2xx 响应体；body 为 nil 时不带请求体。
func (w *WeaviateDB) doRaw(ctx context.Context, method, path string, body []byte) ([]byte, error) {
	if w.client == nil {
		return nil, localizedDatabaseRuntimeError("db.backend.error.connection_not_open", nil)
	}
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, strings.TrimRight(w.baseURL, "/")+path, reader)
	if err != nil {
		return nil, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Accept", "application/json")
	for key, value := range w.authHeaders {
		req.Header.Set(key, value)
	}
	res, err := w.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	resBody, err := readLimitedJSONResponseBody(res.Body)
	if err != nil {
		return nil, err
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		detail := weaviateErrorDetail(resBody)
		if detail == "" {
			detail = res.Status
		}
		return nil, &weaviateHTTPError{
			status: res.StatusCode,
			message: localizedDriverRuntimeText("db.backend.error.weaviate_request_failed", map[string]any{
				"method": method,
				"path":   path,
				"detail": detail,
			}),
		}
	}
	return resBody, nil
}

// doJSON 发出 JSON 请求并把响应解码到 out（out 为 nil 时忽略响应体）。
func (w *WeaviateDB) doJSON(ctx context.Context, method, path string, body interface{}, out interface{}) error {
	var payload []byte
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return err
		}
		payload = encoded
	}
	resBody, err := w.doRaw(ctx, method, path, payload)
	if err != nil {
		return err
	}
	if out == nil || len(bytes.TrimSpace(resBody)) == 0 {
		return nil
	}
	return decodeJSONWithUseNumber(resBody, out)
}

// graphQL 执行 GraphQL 查询；响应带 errors 时整体按失败处理，避免部分结果被当成完整结果。
func (w *WeaviateDB) graphQL(ctx context.Context, query string) (map[string]interface{}, error) {
	var response struct {
		Data   map[string]interface{} `json:"data"`
		Errors []struct {
			Message string `json:"message"`
		} `json:"errors"`
	}
	if err := w.doJSON(ctx, http.MethodPost, "/v1/graphql", map[string]string{"query": query}, &response); err != nil {
		return nil, err
	}
	if len(response.Errors) > 0 {
		messages := make([]string, 0, len(response.Errors))
		for _, item := range response.Errors {
			if text := strings.TrimSpace(item.Message); text != "" {
				messages = append(messages, text)
			}
		}
		return nil, localizedDatabaseRuntimeError("db.backend.error.weaviate_graphql_failed", map[string]any{"detail": strings.Join(messages, "; ")})
	}
	return response.Data, nil
}

// weaviateErrorDetail 取出 {"error":[{"message":...}]} 或 {"message":...} 形式的错误说明。
func weaviateErrorDetail(body []byte) string {
	var payload struct {
		Error []struct {
			Message string `json:"message"`
		} `json:"error"`
		Message string `json:"message"`
	}
	if err := json.Unmarshal(body, &payload); err == nil {
		messages := make([]string, 0, len(payload.Error)+1)
		for _, item := range payload.Error {
			if text := strings.TrimSpace(item.Message); text != "" {
				messages = append(messages, text)
			}
		}
		if text := strings.TrimSpace(payload.Message); text != "" {
			messages = append(messages, text)
		}
		if len(messages) > 0 {
			return strings.Join(messages, "; ")
		}
	}
	return strings.TrimSpace(string(body))
}

// weaviateEscapePath 转义路径段（集合名、对象 ID、租户名）。
func weaviateEscapePath(segment string) string { return url.PathEscape(segment) }

// weaviateTenantQuery 返回带租户的查询串（含前导 ?）；租户为空时返回空串。
func weaviateTenantQuery(tenant string) string {
	if tenant == "" {
		return ""
	}
	return "?tenant=" + url.QueryEscape(tenant)
}
