//go:build gonavi_full_drivers || gonavi_opensearch_driver

package db

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"
)

// openSearchCompatibleMajor 是控制台按 Elasticsearch 主版本校验端点、生成模板时使用的版本：
// OpenSearch 从 Elasticsearch 7.10 分出，1.x / 2.x / 3.x 的 REST 语义都按 7.x 处理（无 type、_doc 端点）。
const openSearchCompatibleMajor = 7

// OpenSearchDB 复用 Elasticsearch 实现：REST、DSL、映射、文档编辑与控制台都与 Elasticsearch 7.10 一致。
// 差异在服务端识别（version.distribution = opensearch）、版本档位，以及 _plugins 下的 SQL / PPL 端点。
type OpenSearchDB struct {
	ElasticsearchDB
	driverVariantState
}

var (
	_ Database              = (*OpenSearchDB)(nil)
	_ DriverVariantReporter = (*OpenSearchDB)(nil)
)

type openSearchServerInfo struct {
	Version struct {
		Distribution string `json:"distribution"`
		Number       string `json:"number"`
	} `json:"version"`
}

// Connect 复用 Elasticsearch 的连接链路（SSH、代理、SSL 回退），再按根端点的版本信息确定档位。
// opensearch:// 连接串按 http 处理。
func (o *OpenSearchDB) Connect(config connection.ConnectionConfig) error {
	if err := o.ElasticsearchDB.Connect(rewriteURIScheme(config, "http", "opensearch")); err != nil {
		return err
	}
	info, err := o.probeServerInfo()
	if err != nil {
		logger.Warnf("OpenSearch 版本识别失败：%v", err)
	} else if distribution := strings.TrimSpace(info.Version.Distribution); distribution != "" && !strings.EqualFold(distribution, "opensearch") {
		logger.Warnf("OpenSearch 连接的服务端发行版为 %s，版本档位按 %s 识别", distribution, info.Version.Number)
	}
	o.serverMajor = openSearchCompatibleMajor
	if err := o.resolve("opensearch", config, info.Version.Number); err != nil {
		_ = o.ElasticsearchDB.Close()
		return err
	}
	return nil
}

func (o *OpenSearchDB) probeServerInfo() (openSearchServerInfo, error) {
	var info openSearchServerInfo
	if o.client == nil {
		return info, localizedDatabaseRuntimeError("db.backend.error.connection_not_open", nil)
	}
	timeout := o.pingTimeout
	if timeout <= 0 {
		timeout = defaultEsPingTimeout
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, "/", nil)
	if err != nil {
		return info, err
	}
	response, err := o.client.Perform(request)
	if err != nil {
		return info, err
	}
	defer response.Body.Close()
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return info, fmt.Errorf("根端点返回 HTTP %d", response.StatusCode)
	}
	body, err := readResponseBodyWithLimit(response.Body, 1<<20, "OpenSearch 版本响应")
	if err != nil {
		return info, err
	}
	if err := json.Unmarshal(body, &info); err != nil {
		return info, fmt.Errorf("解析版本响应失败：%w", err)
	}
	return info, nil
}
