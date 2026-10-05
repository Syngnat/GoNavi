package db

import (
	"context"
	"errors"
	"fmt"
	"runtime"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
)

// 本文件承载驱动代理客户端的协议探测与能力归类：metadata 探测、connect
// 请求构造、connect 响应中的连接信息，以及按错误文本归类的可选能力判定。
// 参数绑定协议版本常量与门控见 optional_driver_agent_params.go。

// optionalAgentConnectionInfo 是 connect 响应中的连接级信息。
// ProtocolSchema 由新版 agent 回显，旧版 agent 不携带该字段（解码为空串），
// 客户端据此做参数绑定等协议能力的门控。
// InFlightCancel 是 agent 对在途查询取消通道的显式声明：只有它为 true 时，
// 主进程才会用取消通知代替杀进程（见 optional_driver_agent_cancel.go）。
type optionalAgentConnectionInfo struct {
	ElasticsearchServerMajor int    `json:"elasticsearchServerMajor,omitempty"`
	ProtocolSchema           string `json:"protocolSchema,omitempty"`
	InFlightCancel           bool   `json:"inFlightCancel,omitempty"`
	DriverVariant            string `json:"driverVariant,omitempty"`
	ServerVersion            string `json:"serverVersion,omitempty"`
}

// OptionalDriverAgentProtocolSchemaV2 是携带参数绑定通道（Args）的协议版本。
const OptionalDriverAgentProtocolSchemaV2 = "json-lines-v2"

func ProbeOptionalDriverAgentMetadata(driverType string, executablePath string) (OptionalDriverAgentMetadata, error) {
	metadata, err := probeOptionalDriverAgentMetadataWithRetry(func(timeout time.Duration) (OptionalDriverAgentMetadata, error) {
		client, clientErr := newOptionalDriverAgentClient(driverType, executablePath)
		if clientErr != nil {
			return OptionalDriverAgentMetadata{}, clientErr
		}
		defer func() {
			_ = client.close()
		}()

		var result OptionalDriverAgentMetadata
		if callErr := client.callWithTimeout(optionalAgentRequest{Method: optionalAgentMethodMetadata}, &result, nil, nil, nil, timeout); callErr != nil {
			return OptionalDriverAgentMetadata{}, callErr
		}
		return result, nil
	}, runtime.GOOS == "windows", optionalAgentMetadataProbeRetryDelay)
	if err != nil {
		return OptionalDriverAgentMetadata{}, err
	}
	metadata.DriverType = normalizeRuntimeDriverType(metadata.DriverType)
	metadata.AgentRevision = strings.TrimSpace(metadata.AgentRevision)
	metadata.ProtocolSchema = strings.TrimSpace(metadata.ProtocolSchema)
	return metadata, nil
}

func probeOptionalDriverAgentMetadataWithRetry(
	probe func(time.Duration) (OptionalDriverAgentMetadata, error),
	retryOnTimeout bool,
	delay time.Duration,
) (OptionalDriverAgentMetadata, error) {
	if probe == nil {
		return OptionalDriverAgentMetadata{}, errors.New("driver-agent metadata probe is nil")
	}

	metadata, firstErr := probe(optionalAgentMetadataProbeTimeout)
	if firstErr == nil || !retryOnTimeout || !errors.Is(firstErr, context.DeadlineExceeded) {
		return metadata, firstErr
	}
	if delay > 0 {
		time.Sleep(delay)
	}

	metadata, retryErr := probe(optionalAgentMetadataProbeRetryTimeout)
	if retryErr == nil {
		return metadata, nil
	}
	// Preserve the 30s primary timeout as the causal error while retaining the
	// second attempt's detail for logs and localized error rendering.
	return OptionalDriverAgentMetadata{}, fmt.Errorf("首次 metadata 探测失败：%w；冷启动重试失败：%v", firstErr, retryErr)
}

func newOptionalAgentConnectRequest(config connection.ConnectionConfig) optionalAgentRequest {
	request := optionalAgentRequest{
		Method:            optionalAgentMethodConnect,
		Config:            &config,
		StreamSSHProgress: config.UseSSH,
	}
	if config.UseSSH {
		request.SSHRuntime = config.SSH.RuntimeSnapshot()
	}
	return request
}

func isOptionalAgentStreamUnsupportedError(err error) bool {
	if err == nil {
		return false
	}
	text := strings.TrimSpace(err.Error())
	if text == "" {
		return false
	}
	return strings.Contains(text, "不支持的方法") || strings.Contains(text, "不支持流式查询")
}

func isOptionalAgentMultiResultUnsupportedError(err error) bool {
	if err == nil {
		return false
	}
	text := strings.TrimSpace(err.Error())
	if text == "" {
		return false
	}
	return strings.Contains(text, "不支持的方法") ||
		strings.Contains(text, "不支持原生多结果集查询") ||
		strings.Contains(text, "不支持多结果集查询")
}
