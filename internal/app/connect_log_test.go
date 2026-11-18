package app

import (
	"errors"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
)

func TestConnectionNetworkMode(t *testing.T) {
	tests := []struct {
		name   string
		config connection.ConnectionConfig
		want   string
	}{
		{
			name:   "direct tcp",
			config: connection.ConnectionConfig{Type: "mysql", Host: "db.internal", Port: 3306},
			want:   "TCP直连",
		},
		{
			name: "ssh tunnel",
			config: connection.ConnectionConfig{
				Type: "mysql", UseSSH: true,
			},
			want: "SSH隧道",
		},
		{
			name: "proxy",
			config: connection.ConnectionConfig{
				Type: "mysql", UseProxy: true,
			},
			want: "代理转发",
		},
		{
			name: "navicat http tunnel",
			config: connection.ConnectionConfig{
				Type:          "mysql",
				UseHTTPTunnel: true,
				HTTPTunnel:    connection.HTTPTunnelConfig{Host: "https://gateway.example/ntunnel_mysql.php"},
			},
			want: "Navicat HTTP隧道",
		},
		{
			name: "legacy http tunnel",
			config: connection.ConnectionConfig{
				Type:          "mysql",
				UseHTTPTunnel: true,
				HTTPTunnel:    connection.HTTPTunnelConfig{Host: "proxy.internal", Port: 8080},
			},
			want: "HTTP隧道",
		},
		{
			name:   "local file",
			config: connection.ConnectionConfig{Type: "sqlite", Host: "/tmp/demo.db"},
			want:   "本地文件",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := connectionNetworkMode(test.config); got != test.want {
				t.Fatalf("connectionNetworkMode() = %q, want %q", got, test.want)
			}
		})
	}
}

func TestFormatConnSummaryIncludesNetworkMode(t *testing.T) {
	summary := formatConnSummary(connection.ConnectionConfig{
		Type:     "mysql",
		Host:     "db.internal",
		Port:     3306,
		User:     "app",
		Database: "demo",
	})
	if !strings.Contains(summary, "网络方式=TCP直连") {
		t.Fatalf("formatConnSummary() missing network mode: %q", summary)
	}
}

func TestClassifyConnectFailureForLog(t *testing.T) {
	tests := []struct {
		name             string
		err              error
		wantStage        string
		wantJudgmentPart string
		wantAdvicePart   string
	}{
		{
			name:             "tcp timeout",
			err:              errors.New("dial tcp 47.98.49.192:13306: i/o timeout"),
			wantStage:        "TCP建连",
			wantJudgmentPart: "超时",
			wantAdvicePart:   "防火墙",
		},
		{
			name:             "connection refused",
			err:              errors.New("dial tcp 127.0.0.1:3306: connect: connection refused"),
			wantStage:        "TCP建连",
			wantJudgmentPart: "拒绝",
			wantAdvicePart:   "监听地址",
		},
		{
			name:             "network unreachable",
			err:              errors.New("dial tcp 10.0.0.8:3306: connect: network is unreachable"),
			wantStage:        "网络路由",
			wantJudgmentPart: "没有可达路由",
			wantAdvicePart:   "VPN",
		},
		{
			name:             "mysql authentication",
			err:              errors.New("Error 1045: Access denied for user 'root'@'10.0.0.2'"),
			wantStage:        "数据库认证",
			wantJudgmentPart: "校验失败",
			wantAdvicePart:   "用户名",
		},
		{
			name:             "tls certificate",
			err:              errors.New("tls: failed to verify certificate: x509: certificate signed by unknown authority"),
			wantStage:        "TLS/SSL握手",
			wantJudgmentPart: "证书校验失败",
			wantAdvicePart:   "CA证书",
		},
		{
			name:             "unknown database",
			err:              errors.New("Error 1049: Unknown database 'missing'"),
			wantStage:        "选择数据库",
			wantJudgmentPart: "数据库不存在",
			wantAdvicePart:   "数据库名",
		},
		{
			name:             "mysql compatibility",
			err:              errors.New("multiStatements compatibility failed: Error 1064 syntax error"),
			wantStage:        "MySQL参数兼容",
			wantJudgmentPart: "兼容性",
			wantAdvicePart:   "multiStatements",
		},
		{
			name:             "ssh tunnel",
			err:              errors.New("ssh: handshake failed: known host key mismatch"),
			wantStage:        "SSH隧道",
			wantJudgmentPart: "SSH隧道",
			wantAdvicePart:   "跳板机",
		},
		{
			name:             "navicat tunnel",
			err:              errors.New("Navicat HTTP 隧道返回 HTTP 502"),
			wantStage:        "Navicat HTTP隧道",
			wantJudgmentPart: "HTTP脚本隧道",
			wantAdvicePart:   "ntunnel_mysql.php",
		},
		{
			name:             "connection interruption",
			err:              errors.New("read tcp 10.0.0.2:54321->10.0.0.8:3306: broken pipe"),
			wantStage:        "连接中断",
			wantJudgmentPart: "中断",
			wantAdvicePart:   "空闲超时",
		},
		{
			name:             "invalid mysql connection",
			err:              errors.New("invalid connection"),
			wantStage:        "连接中断",
			wantJudgmentPart: "中断",
			wantAdvicePart:   "代理超时",
		},
		{
			name:             "unknown error",
			err:              errors.New("unexpected internal failure"),
			wantStage:        "连接初始化",
			wantJudgmentPart: "未归入",
			wantAdvicePart:   "错误链",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			info := classifyConnectFailureForLog(test.err)
			if info.stage != test.wantStage {
				t.Fatalf("stage = %q, want %q", info.stage, test.wantStage)
			}
			if !strings.Contains(info.judgment, test.wantJudgmentPart) {
				t.Fatalf("judgment = %q, want substring %q", info.judgment, test.wantJudgmentPart)
			}
			if !strings.Contains(info.advice, test.wantAdvicePart) {
				t.Fatalf("advice = %q, want substring %q", info.advice, test.wantAdvicePart)
			}
		})
	}
}

func TestFormatConnectFailureLogFields(t *testing.T) {
	got := formatConnectFailureLogFields(connectFailureLogInfo{
		stage:    "TCP建连",
		judgment: "连接超时",
		advice:   "检查防火墙",
	})
	for _, want := range []string{"失败阶段=TCP建连", "初步判断=连接超时", "建议=检查防火墙"} {
		if !strings.Contains(got, want) {
			t.Fatalf("formatConnectFailureLogFields() = %q, want substring %q", got, want)
		}
	}
}
