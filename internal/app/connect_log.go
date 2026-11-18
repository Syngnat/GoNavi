package app

import (
	"fmt"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"
)

type connectFailureLogInfo struct {
	stage    string
	judgment string
	advice   string
}

func connectionNetworkMode(config connection.ConnectionConfig) string {
	if isFileDatabaseType(config.Type) {
		return "本地文件"
	}
	if config.UseHTTPTunnel {
		if isNavicatHTTPTunnelURL(config.HTTPTunnel.Host) {
			return "Navicat HTTP隧道"
		}
		return "HTTP隧道"
	}
	if config.UseProxy {
		return "代理转发"
	}
	if config.UseSSH {
		return "SSH隧道"
	}
	return "TCP直连"
}

func classifyConnectFailureForLog(err error) connectFailureLogInfo {
	if err == nil {
		return connectFailureLogInfo{stage: "未知", judgment: "没有收到错误详情", advice: "检查调用链是否丢失了原始错误"}
	}

	text := strings.ToLower(logger.ErrorChain(err))
	switch {
	case containsAnyConnectFailureHint(text, "navicat http 隧道", "navicat http tunnel"):
		return connectFailureLogInfo{
			stage:    "Navicat HTTP隧道",
			judgment: "HTTP脚本隧道请求或响应失败",
			advice:   "检查隧道URL、HTTP认证、ntunnel_mysql.php 和隧道服务端出口网络",
		}
	case containsAnyConnectFailureHint(text, "ssh 隧道", "ssh tunnel", "ssh dial", "ssh handshake", "ssh: handshake", "host key"):
		return connectFailureLogInfo{
			stage:    "SSH隧道",
			judgment: "SSH隧道建立或握手失败",
			advice:   "检查SSH主机、端口、账号、密钥和主机指纹，并确认跳板机到数据库可达",
		}
	case containsAnyConnectFailureHint(text, "代理连接", "代理转发", "proxy connect", "proxy tunnel"):
		return connectFailureLogInfo{
			stage:    "代理转发",
			judgment: "连接代理或代理隧道建立失败",
			advice:   "检查代理类型、地址、端口和认证信息，并确认代理能访问数据库地址",
		}
	case containsAnyConnectFailureHint(text, "tls handshake", "x509", "certificate", "ssl connection", "ssl error", "tls:"):
		return connectFailureLogInfo{
			stage:    "TLS/SSL握手",
			judgment: "TLS/SSL协商或证书校验失败",
			advice:   "检查SSL模式、CA证书、客户端证书和主机名校验配置",
		}
	case containsAnyConnectFailureHint(text, "access denied", "authentication failed", "password authentication failed", "error 1045", "28p01", "登录失败", "认证失败"):
		return connectFailureLogInfo{
			stage:    "数据库认证",
			judgment: "用户名、密码或账号权限校验失败",
			advice:   "检查用户名、密码、认证来源和账号授权范围",
		}
	case containsAnyConnectFailureHint(text, "unknown database", "error 1049", "database does not exist"):
		return connectFailureLogInfo{
			stage:    "选择数据库",
			judgment: "目标数据库不存在或当前账号无权访问",
			advice:   "检查数据库名和账号权限，或先不指定数据库再连接",
		}
	case containsAnyConnectFailureHint(text, "multistatements", "allowmultiqueries", "error 1064", "parametric information is abnormal", "charset"):
		return connectFailureLogInfo{
			stage:    "MySQL参数兼容",
			judgment: "连接参数或服务端兼容性校验失败",
			advice:   "检查 multiStatements、charset、连接参数和服务端版本兼容性",
		}
	case containsAnyConnectFailureHint(text, "i/o timeout", "connection timed out", "connect timeout", "deadline exceeded"):
		return connectFailureLogInfo{
			stage:    "TCP建连",
			judgment: "目标地址和端口在超时时间内未完成TCP连接",
			advice:   "检查地址和端口是否可达，以及防火墙、VPN、代理、SSH隧道或HTTP隧道配置",
		}
	case containsAnyConnectFailureHint(text, "connection refused", "connectex", "econnrefused"):
		return connectFailureLogInfo{
			stage:    "TCP建连",
			judgment: "目标端口拒绝TCP连接",
			advice:   "确认数据库监听地址和端口，以及服务端防火墙是否允许当前来源",
		}
	case containsAnyConnectFailureHint(text, "no route to host", "network is unreachable"):
		return connectFailureLogInfo{
			stage:    "网络路由",
			judgment: "目标网络没有可达路由",
			advice:   "检查网段、路由、VPN和出口网络",
		}
	case containsAnyConnectFailureHint(text, "dial tcp"):
		return connectFailureLogInfo{
			stage:    "TCP建连",
			judgment: "目标地址和端口建立TCP连接失败",
			advice:   "检查地址和端口是否可达，以及防火墙、VPN、代理或隧道配置",
		}
	case containsAnyConnectFailureHint(text, "invalid connection", "broken pipe", "connection reset by peer", "unexpected eof", "server has gone away"):
		return connectFailureLogInfo{
			stage:    "连接中断",
			judgment: "连接建立后被服务端或中间网络中断",
			advice:   "检查服务端连接限制、空闲超时、代理超时和网络稳定性",
		}
	default:
		return connectFailureLogInfo{
			stage:    "连接初始化",
			judgment: "错误未归入已知连接阶段",
			advice:   "结合错误链和详细日志继续排查",
		}
	}
}

func formatConnectFailureLogFields(info connectFailureLogInfo) string {
	fields := []string{
		fmt.Sprintf("失败阶段=%s", info.stage),
		fmt.Sprintf("初步判断=%s", info.judgment),
	}
	if strings.TrimSpace(info.advice) != "" {
		fields = append(fields, fmt.Sprintf("建议=%s", info.advice))
	}
	return strings.Join(fields, " | ")
}

func containsAnyConnectFailureHint(text string, candidates ...string) bool {
	for _, candidate := range candidates {
		if strings.Contains(text, candidate) {
			return true
		}
	}
	return false
}
