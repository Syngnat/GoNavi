package app

import (
	"errors"
	"testing"
)

func TestShouldRefreshCachedConnectionCoversDriverAgentRuntimeFailures(t *testing.T) {
	cases := []struct {
		name     string
		err      error
		expected bool
	}{
		{"代理传输关闭", errors.New("人大金仓 驱动代理传输已关闭"), true},
		{"代理调用失败", errors.New("调用 人大金仓 驱动代理失败：read |0: bad file descriptor"), true},
		{"代理请求超时", errors.New("人大金仓 驱动代理 查询 请求超时：context deadline exceeded"), true},
		{"代理响应读取失败", errors.New("读取 人大金仓 驱动代理响应失败：unexpected EOF"), true},
		{"旧英文连接错误保持可刷新", errors.New("invalid connection"), true},
		{"代理缺失需重装不重连", errors.New("人大金仓 驱动代理缺失，请在驱动管理中重新安装启用"), false},
		{"代理路径为空不重连", errors.New("人大金仓 驱动代理路径为空"), false},
		{"架构不兼容不重连", errors.New("启动 人大金仓 驱动代理失败：bad cpu type（检测到驱动代理与当前系统架构不兼容，请在驱动管理中重新安装启用）"), false},
		{"纯 SQL 业务错误不重连", errors.New(`kb: relation "lab_customers" does not exist`), false},
		{"nil 不刷新", nil, false},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if actual := shouldRefreshCachedConnection(testCase.err); actual != testCase.expected {
				t.Fatalf("shouldRefreshCachedConnection(%v) = %v, want %v", testCase.err, actual, testCase.expected)
			}
		})
	}
}
