//go:build gonavi_full_drivers || gonavi_elasticsearch_driver || gonavi_opensearch_driver

package db

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"time"

	"GoNavi-Wails/internal/esconsole"
	"GoNavi-Wails/internal/ssh"

	"github.com/elastic/go-elasticsearch/v8"
)

const (
	defaultEsPingTimeout      = 5 * time.Second
	defaultEsQueryTimeout     = 30 * time.Second
	defaultEsIndexListTimeout = 10 * time.Second
	maxEsCatIndexListTimeout  = 4 * time.Second
)

// ElasticsearchDB 实现 Database 接口，提供 Elasticsearch 数据源连接能力。
type ElasticsearchDB struct {
	client           *elasticsearch.Client
	consoleClient    *elasticsearch.Client
	database         string // 默认索引名
	serverMajor      int
	pingTimeout      time.Duration
	indexListTimeout time.Duration // 0 表示使用默认索引枚举总超时
	forwarder        *ssh.LocalForwarder
}

var _ BatchApplierContext = (*ElasticsearchDB)(nil)

func (e *ElasticsearchDB) ElasticsearchConsoleTransportUsable() bool {
	return e.consoleClient != nil
}

// ExecuteElasticsearchConsoleRequest sends one parsed Elasticsearch REST
// request and preserves the raw HTTP response, including structured 4xx/5xx
// payloads. Transport or response-read failures are returned as errors.
func (e *ElasticsearchDB) ExecuteElasticsearchConsoleRequest(ctx context.Context, request ElasticsearchConsoleRequest) (ElasticsearchConsoleResponse, error) {
	validatedRequest, err := validateElasticsearchConsoleDriverRequest(request, e.serverMajor)
	if err != nil {
		return ElasticsearchConsoleResponse{}, err
	}
	request = validatedRequest
	client := e.consoleClient
	if client == nil {
		return ElasticsearchConsoleResponse{}, fmt.Errorf("Elasticsearch Console retry-disabled transport is unavailable")
	}
	if ctx == nil {
		ctx = context.Background()
	}

	requestBody := request.Body
	if request.BodyKind == ElasticsearchConsoleBodyKindNDJSON && requestBody != "" {
		requestBody = strings.TrimRight(requestBody, "\r\n") + "\n"
	}
	httpRequest, err := http.NewRequestWithContext(ctx, request.Method, request.Path, strings.NewReader(requestBody))
	if err != nil {
		return ElasticsearchConsoleResponse{}, fmt.Errorf("构造 Elasticsearch Console 请求失败：%w", err)
	}
	if request.Body != "" {
		switch request.BodyKind {
		case ElasticsearchConsoleBodyKindNDJSON:
			httpRequest.Header.Set("Content-Type", "application/x-ndjson")
		default:
			httpRequest.Header.Set("Content-Type", "application/json")
		}
	}

	httpResponse, err := client.Perform(httpRequest)
	if err != nil {
		return ElasticsearchConsoleResponse{}, fmt.Errorf("Elasticsearch Console 请求失败：%w", err)
	}
	defer httpResponse.Body.Close()

	body, err := readResponseBodyWithLimit(httpResponse.Body, maxElasticsearchConsoleResponseBytes, "Elasticsearch Console 响应")
	if err != nil {
		return ElasticsearchConsoleResponse{}, fmt.Errorf("读取 Elasticsearch Console 响应失败：%w", err)
	}
	return ElasticsearchConsoleResponse{
		StatusCode:  httpResponse.StatusCode,
		ContentType: httpResponse.Header.Get("Content-Type"),
		RawBody:     string(body),
		ServerMajor: e.serverMajor,
	}, nil
}

func validateElasticsearchConsoleDriverRequest(request ElasticsearchConsoleRequest, serverMajor int) (ElasticsearchConsoleRequest, error) {
	source := strings.TrimSpace(request.Method) + " " + strings.TrimSpace(request.Path)
	if request.Body != "" {
		source += "\n" + request.Body
	}
	batch, err := esconsole.ParseSourceForMajor(source, "", serverMajor)
	if err != nil {
		return ElasticsearchConsoleRequest{}, fmt.Errorf("Elasticsearch Console 请求校验失败：%w", err)
	}
	if len(batch.Requests) != 1 {
		return ElasticsearchConsoleRequest{}, fmt.Errorf("Elasticsearch Console driver 仅接受单个请求")
	}
	parsed := batch.Requests[0]
	if parsed.Risk == esconsole.RiskBlocked {
		return ElasticsearchConsoleRequest{}, fmt.Errorf("Elasticsearch Console 请求被策略拒绝：%s", parsed.BlockReason)
	}
	bodyKind := ElasticsearchConsoleBodyKindNone
	switch parsed.BodyKind {
	case esconsole.BodyJSON:
		bodyKind = ElasticsearchConsoleBodyKindJSON
	case esconsole.BodyNDJSON:
		bodyKind = ElasticsearchConsoleBodyKindNDJSON
	case esconsole.BodyNone:
	default:
		return ElasticsearchConsoleRequest{}, fmt.Errorf("Elasticsearch Console driver 不支持 body 类型 %s", parsed.BodyKind)
	}
	return ElasticsearchConsoleRequest{
		Method:   parsed.Method,
		Path:     parsed.Path,
		Body:     parsed.Body,
		BodyKind: bodyKind,
	}, nil
}

type esHTTPStatusError struct {
	statusCode int
	status     string
}

func (e *ElasticsearchDB) ElasticsearchServerMajor() int {
	if e == nil {
		return 0
	}
	return e.serverMajor
}

func (e *esHTTPStatusError) Error() string {
	return e.status
}
