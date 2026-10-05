//go:build gonavi_full_drivers || gonavi_elasticsearch_driver || gonavi_opensearch_driver

package db

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	proxytunnel "GoNavi-Wails/internal/proxy"

	"github.com/elastic/go-elasticsearch/v8"
)

// esProductCheckBypassTransport 包装 http.RoundTripper，
// 为 ES 6.x / 7.x 早期版本注入 X-Elastic-Product 响应头。
// go-elasticsearch/v8 在首次成功响应时强制校验此头部，
// 但 ES < 7.14 不返回该头，导致 "unknown product" 错误。
type esProductCheckBypassTransport struct {
	inner http.RoundTripper
}

func (t *esProductCheckBypassTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	resp, err := t.inner.RoundTrip(req)
	if err != nil {
		return resp, err
	}
	// 仅在缺失时注入，避免覆盖 ES 7.14+ 已有的合法头部
	if resp.Header.Get("X-Elastic-Product") == "" {
		resp.Header.Set("X-Elastic-Product", "Elasticsearch")
	}
	return resp, nil
}

// esSSLAttemptLabel 返回连接尝试的模式标签。
func esSSLAttemptLabel(config connection.ConnectionConfig, fallback bool) string {
	if fallback {
		return "明文回退"
	}
	if config.UseSSL {
		return "SSL"
	}
	return "明文"
}

// buildESClientConfig 从连接配置构建 ES 客户端配置。
func buildESClientConfig(config connection.ConnectionConfig) elasticsearch.Config {
	scheme := "http"
	if config.UseSSL {
		scheme = "https"
	}

	address := fmt.Sprintf("%s://%s:%d", scheme, config.Host, config.Port)

	cfg := elasticsearch.Config{
		Addresses:  []string{address},
		Username:   strings.TrimSpace(config.User),
		Password:   config.Password,
		MaxRetries: 1,
	}

	// 从 ConnectionParams 中提取 API Key（优先级高于 Basic Auth）
	if params := connectionParamsFromText(config.ConnectionParams); len(params) > 0 {
		apiKey := strings.TrimSpace(params.Get("apiKey"))
		if apiKey != "" {
			cfg.APIKey = apiKey
			// API Key 认证时清除 Basic Auth
			cfg.Username = ""
			cfg.Password = ""
		}
		// 移除认证参数，不拼入 address URL
		params.Del("apiKey")
		// 重新构建 address（不含认证参数）
		if len(params) > 0 {
			address = fmt.Sprintf("%s://%s:%d?%s", scheme, config.Host, config.Port, params.Encode())
		} else {
			address = fmt.Sprintf("%s://%s:%d", scheme, config.Host, config.Port)
		}
		cfg.Addresses = []string{address}
	}

	// TLS 配置
	tlsConfig, _ := resolveGenericTLSConfig(config)
	if tlsConfig != nil {
		cfg.Transport = &http.Transport{
			TLSClientConfig: tlsConfig,
		}
	}

	// Keep the connection dial bounded, but let the request context own query
	// cancellation. A connection timeout must not become a response deadline.
	timeout := getConnectTimeout(config)
	if cfg.Transport == nil {
		cfg.Transport = http.DefaultTransport.(*http.Transport).Clone()
	}
	if transport, ok := cfg.Transport.(*http.Transport); ok {
		transport.DialContext = (&net.Dialer{Timeout: timeout, KeepAlive: 30 * time.Second}).DialContext
		if config.UseProxy {
			proxyCfg := config.Proxy
			transport.DialContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
				dialCtx, cancel := context.WithTimeout(ctx, timeout)
				defer cancel()
				return proxytunnel.DialContext(dialCtx, proxyCfg, network, addr)
			}
		}
		transport.ResponseHeaderTimeout = 0
	}

	// 包装 transport：注入 X-Elastic-Product 头以兼容 ES 6.x / 7.x 早期版本。
	// go-elasticsearch/v8 要求响应中包含此头部，但 ES < 7.14 不返回。
	if cfg.Transport == nil {
		cfg.Transport = http.DefaultTransport.(*http.Transport).Clone()
	}
	cfg.Transport = &esProductCheckBypassTransport{inner: cfg.Transport}

	return cfg
}

// esReservedColumns ES 查询结果中的保留列名，业务字段不应覆盖。
var esReservedColumns = map[string]struct{}{
	"_index":        {},
	"_id":           {},
	"_score":        {},
	"_source":       {},
	"_aggregations": {},
}

// setESSourceField 安全地将 _source 字段写入结果行。
// 如果字段名与保留列冲突，则加 "source." 前缀避免覆盖。
func setESSourceField(row map[string]interface{}, key string, value interface{}) {
	if _, reserved := esReservedColumns[key]; reserved {
		row["source."+key] = value
		return
	}
	if _, exists := row[key]; exists {
		row["source."+key] = value
		return
	}
	row[key] = value
}

// flattenESSource 递归展开 _source 中的嵌套对象。
// 嵌套字段用点分路径表示（如 user.name），数组序列化为 JSON 字符串。
func flattenESSource(prefix string, value interface{}, row map[string]interface{}) {
	switch v := value.(type) {
	case map[string]interface{}:
		for k, child := range v {
			next := k
			if prefix != "" {
				next = prefix + "." + k
			}
			flattenESSource(next, child, row)
		}
	case []interface{}:
		b, _ := json.Marshal(v)
		setESSourceField(row, prefix, string(b))
	default:
		setESSourceField(row, prefix, v)
	}
}

// normalizeESFieldValue 将 ES fields 数组值转为单值或 JSON 字符串。
func normalizeESFieldValue(value interface{}) interface{} {
	arr, ok := value.([]interface{})
	if !ok {
		return value
	}
	if len(arr) == 1 {
		return arr[0]
	}
	b, err := json.Marshal(arr)
	if err != nil {
		return fmt.Sprint(arr)
	}
	return string(b)
}
