package ssh

import (
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
)

// TestSSHNetworkNameIsDeterministicPerTarget 覆盖 go-sql-driver 自定义 network 名的确定性。
//
// 回归背景：netName 原先是 fmt.Sprintf("ssh_%s_%d", host, time.Now().UnixNano())。
// mysql.RegisterDialContext 写入驱动内一张永不回收的全局 map（DeregisterDialContext 在本
// 仓库无任何调用点），因此每次（重）连接都会新增一条永久条目并钉住其闭包捕获的 ssh.Client，
// 形成随重连线性增长的 SSH 连接与 goroutine 泄漏。改为按目标确定性派生后，map 大小收敛为
// SSH 目标个数。
func TestSSHNetworkNameIsDeterministicPerTarget(t *testing.T) {
	config := connection.SSHConfig{Host: "jump.example.com", Port: 22, User: "ops", Password: "s3cret"}
	key := newSSHClientCacheKey(config)

	first := sshNetworkName(key)
	second := sshNetworkName(newSSHClientCacheKey(config))
	if first != second {
		t.Fatalf("同一目标两次派生出不同 network 名：%s vs %s（会导致驱动全局 map 无界增长）", first, second)
	}
	if !strings.HasPrefix(first, "ssh_") {
		t.Errorf("network 名 %q 缺少 ssh_ 前缀", first)
	}
}

// TestSSHNetworkNameDistinguishesTargets 不同目标必须得到不同 network 名，
// 否则两条连接会共用同一个 dialer，把流量打到错误的跳板机。
func TestSSHNetworkNameDistinguishesTargets(t *testing.T) {
	base := connection.SSHConfig{Host: "jump.example.com", Port: 22, User: "ops", Password: "s3cret"}
	variants := map[string]connection.SSHConfig{
		"不同 host":     {Host: "other.example.com", Port: 22, User: "ops", Password: "s3cret"},
		"不同 port":     {Host: "jump.example.com", Port: 2222, User: "ops", Password: "s3cret"},
		"不同 user":     {Host: "jump.example.com", Port: 22, User: "admin", Password: "s3cret"},
		"不同 password": {Host: "jump.example.com", Port: 22, User: "ops", Password: "other"},
	}

	baseName := sshNetworkName(newSSHClientCacheKey(base))
	for label, cfg := range variants {
		if got := sshNetworkName(newSSHClientCacheKey(cfg)); got == baseName {
			t.Errorf("%s 却派生出与基准相同的 network 名 %s", label, got)
		}
	}
}

// TestSSHNetworkNameDoesNotLeakSecrets network 名会进入 DSN 与日志，
// 不能包含主机名、用户名或口令明文。
func TestSSHNetworkNameDoesNotLeakSecrets(t *testing.T) {
	config := connection.SSHConfig{Host: "jump.example.com", Port: 22, User: "ops", Password: "s3cretP@ss"}
	name := sshNetworkName(newSSHClientCacheKey(config))

	for _, secret := range []string{"jump.example.com", "ops", "s3cretP@ss"} {
		if strings.Contains(name, secret) {
			t.Errorf("network 名 %q 泄露了明文 %q", name, secret)
		}
	}
}
