//go:build gonavi_full_drivers || gonavi_presto_driver

package db

import (
	"maps"
	"net/http"
	"net/url"
	"strings"
	"sync"
)

// prestoSession 是一个逻辑会话。Presto 的 HTTP 协议没有连接级状态：USE、SET SESSION、PREPARE、
// SET ROLE、START TRANSACTION 等语句的效果由响应头带回，客户端在后续请求里用请求头带上。
type prestoSession struct {
	mu sync.Mutex
	// fixed 为 true 时不接收响应头里的会话变更（元数据会话始终使用连接配置的命名空间）。
	fixed         bool
	catalog       string
	schema        string
	path          string
	properties    map[string]string
	cleared       map[string]struct{}
	prepared      map[string]string
	roles         map[string]string
	transactionID string
}

func newPrestoSession(catalog, schema string) *prestoSession {
	return &prestoSession{
		catalog:    strings.TrimSpace(catalog),
		schema:     strings.TrimSpace(schema),
		properties: map[string]string{},
		cleared:    map[string]struct{}{},
		prepared:   map[string]string{},
		roles:      map[string]string{},
	}
}

// writeHeaders 写入会话请求头。base 是连接级会话属性，RESET SESSION 清掉的属性不再发送；
// extraPrepared 是本条语句临时带上的预编译语句。
func (s *prestoSession) writeHeaders(headers http.Header, base map[string]string, extraPrepared map[string]string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.catalog != "" {
		headers.Set("X-Presto-Catalog", s.catalog)
	}
	if s.schema != "" {
		headers.Set("X-Presto-Schema", s.schema)
	}
	if s.path != "" {
		headers.Set("X-Presto-Path", s.path)
	}
	properties := make(map[string]string, len(base)+len(s.properties))
	for name, value := range base {
		if _, cleared := s.cleared[name]; !cleared {
			properties[name] = value
		}
	}
	maps.Copy(properties, s.properties)
	if len(properties) > 0 {
		headers.Set("X-Presto-Session", encodePrestoKeyValues(properties))
	}
	prepared := maps.Clone(s.prepared)
	maps.Copy(prepared, extraPrepared)
	if len(prepared) > 0 {
		headers.Set("X-Presto-Prepared-Statement", encodePrestoKeyValues(prepared))
	}
	if len(s.roles) > 0 {
		headers.Set("X-Presto-Role", encodePrestoKeyValues(s.roles))
	}
	// NONE 告知服务端客户端支持事务：用户手写 START TRANSACTION 时服务端才会返回事务号。
	if s.transactionID != "" {
		headers.Set("X-Presto-Transaction-Id", s.transactionID)
	} else {
		headers.Set("X-Presto-Transaction-Id", "NONE")
	}
}

// absorb 读取响应头里的会话变更。
func (s *prestoSession) absorb(headers http.Header) {
	if s == nil || s.fixed {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if value := headers.Get("X-Presto-Set-Catalog"); value != "" {
		s.catalog = value
	}
	if value := headers.Get("X-Presto-Set-Schema"); value != "" {
		s.schema = value
	}
	if value := headers.Get("X-Presto-Set-Path"); value != "" {
		s.path = value
	}
	for _, entry := range prestoHeaderEntries(headers, "X-Presto-Set-Session") {
		if name, value, ok := decodePrestoKeyValue(entry); ok {
			s.properties[name] = value
			delete(s.cleared, name)
		}
	}
	for _, name := range prestoHeaderEntries(headers, "X-Presto-Clear-Session") {
		delete(s.properties, name)
		s.cleared[name] = struct{}{}
	}
	for _, entry := range prestoHeaderEntries(headers, "X-Presto-Set-Role") {
		if name, value, ok := decodePrestoKeyValue(entry); ok {
			s.roles[name] = value
		}
	}
	for _, entry := range prestoHeaderEntries(headers, "X-Presto-Added-Prepare") {
		if name, value, ok := decodePrestoKeyValue(entry); ok {
			s.prepared[unescapePrestoName(name)] = value
		}
	}
	for _, name := range prestoHeaderEntries(headers, "X-Presto-Deallocated-Prepare") {
		delete(s.prepared, unescapePrestoName(name))
	}
	if value := headers.Get("X-Presto-Started-Transaction-Id"); value != "" {
		s.transactionID = value
	}
	if strings.EqualFold(headers.Get("X-Presto-Clear-Transaction-Id"), "true") {
		s.transactionID = ""
	}
}

// inTransaction 报告会话是否有未结束的显式事务。
func (s *prestoSession) inTransaction() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.transactionID != ""
}

// prestoHeaderEntries 展开同名响应头：服务端每项一行，经过代理时可能被合并为逗号分隔（值都做过 URL 编码，逗号只会是分隔符）。
func prestoHeaderEntries(headers http.Header, name string) []string {
	var entries []string
	for _, value := range headers.Values(name) {
		for _, part := range strings.Split(value, ",") {
			if part = strings.TrimSpace(part); part != "" {
				entries = append(entries, part)
			}
		}
	}
	return entries
}

func unescapePrestoName(name string) string {
	if decoded, err := url.QueryUnescape(name); err == nil {
		return decoded
	}
	return name
}
