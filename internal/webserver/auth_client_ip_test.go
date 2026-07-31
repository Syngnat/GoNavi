package webserver

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

// resetTrustedProxyCache 让每个用例都能重新读取 GONAVI_WEB_TRUSTED_PROXIES。
func resetTrustedProxyCache(t *testing.T) {
	t.Helper()
	trustedProxyOnce = sync.Once{}
	trustedProxyNets = nil
	t.Cleanup(func() {
		trustedProxyOnce = sync.Once{}
		trustedProxyNets = nil
	})
}

func requestWithXFF(remoteAddr string, xff string) *http.Request {
	req := httptest.NewRequest(http.MethodPost, "/__gonavi/auth/login", nil)
	req.RemoteAddr = remoteAddr
	if xff != "" {
		req.Header.Set("X-Forwarded-For", xff)
	}
	return req
}

// TestClientIPIgnoresForwardedHeaderFromUntrustedPeer 覆盖限流标识的抗伪造。
//
// 回归背景：clientIP 原先无条件采信 X-Forwarded-For 的首值。该头完全由客户端控制，
// 直连攻击者每次请求换一个值即可拿到全新的限流桶，彻底绕过 5 次失败锁定
// （口令下限仅 6 位，可在线爆破），并使 attempts map 无界增长；
// 同时每次尝试都会触发一次 64 MiB 的 Argon2id 推导，形成认证面 CPU/内存 DoS。
func TestClientIPIgnoresForwardedHeaderFromUntrustedPeer(t *testing.T) {
	resetTrustedProxyCache(t)
	t.Setenv(webTrustedProxiesEnvName, "")

	// 攻击者直连并伪造 XFF：必须回落到不可伪造的对端地址。
	for _, spoof := range []string{"1.2.3.1", "1.2.3.2", "9.9.9.9, 8.8.8.8", "not-an-ip"} {
		req := requestWithXFF("203.0.113.7:51000", spoof)
		if got := clientIP(req); got != "203.0.113.7" {
			t.Errorf("XFF=%q 时 clientIP = %q，期望回落到对端 203.0.113.7", spoof, got)
		}
	}

	// 无 XFF 时同样取对端地址。
	if got := clientIP(requestWithXFF("203.0.113.7:51000", "")); got != "203.0.113.7" {
		t.Errorf("无 XFF 时 clientIP = %q，期望 203.0.113.7", got)
	}
}

// TestClientIPHonorsForwardedHeaderOnlyBehindTrustedProxy 可信代理下才采信 XFF，
// 且取最右侧的非可信跳（左侧可被客户端预先伪造）。
func TestClientIPHonorsForwardedHeaderOnlyBehindTrustedProxy(t *testing.T) {
	resetTrustedProxyCache(t)
	t.Setenv(webTrustedProxiesEnvName, "10.0.0.0/8, 192.168.1.5")

	// 对端是可信代理：XFF 最右侧非可信跳即真实客户端。
	if got := clientIP(requestWithXFF("10.0.0.3:40000", "1.1.1.1, 203.0.113.9")); got != "203.0.113.9" {
		t.Errorf("可信代理后 clientIP = %q，期望最右非可信跳 203.0.113.9", got)
	}
	// 链中夹着可信代理时应跳过它们。
	if got := clientIP(requestWithXFF("10.0.0.3:40000", "203.0.113.9, 10.0.0.9")); got != "203.0.113.9" {
		t.Errorf("clientIP = %q，期望跳过可信跳得到 203.0.113.9", got)
	}
	// 单 IP 形式的可信代理配置同样生效。
	if got := clientIP(requestWithXFF("192.168.1.5:40000", "203.0.113.9")); got != "203.0.113.9" {
		t.Errorf("单 IP 可信代理下 clientIP = %q，期望 203.0.113.9", got)
	}
	// XFF 里全是非法值时回落到对端，不得用任意字符串制造新桶。
	if got := clientIP(requestWithXFF("10.0.0.3:40000", "garbage, also-garbage")); got != "10.0.0.3" {
		t.Errorf("XFF 全非法时 clientIP = %q，期望回落 10.0.0.3", got)
	}
	// 未配置为可信的对端即使发 XFF 也不采信。
	if got := clientIP(requestWithXFF("203.0.113.7:51000", "203.0.113.9")); got != "203.0.113.7" {
		t.Errorf("非可信对端 clientIP = %q，期望 203.0.113.7", got)
	}
}

// TestLoginLockoutCannotBeBypassedByRotatingForwardedHeader 端到端断言锁定不可绕过：
// 同一对端无论怎么换 XFF，达到失败上限后都必须被锁。
func TestLoginLockoutCannotBeBypassedByRotatingForwardedHeader(t *testing.T) {
	resetTrustedProxyCache(t)
	t.Setenv(webTrustedProxiesEnvName, "")

	tracker := newLoginAttemptTracker()
	now := time.Now()

	// 攻击者每次换一个伪造 XFF，但对端固定。
	for i := 0; i < webLoginFailureLimit; i++ {
		req := requestWithXFF("203.0.113.7:51000", fmt.Sprintf("1.2.3.%d", i+1))
		key := clientIP(req)
		if wait, ok := tracker.allow(key, now); !ok {
			t.Fatalf("第 %d 次尝试就被拒绝（wait=%v），预期前 %d 次放行", i+1, wait, webLoginFailureLimit)
		}
		tracker.recordFailure(key, now)
	}

	// 第 6 次：换成又一个新 XFF，仍必须被锁定。
	req := requestWithXFF("203.0.113.7:51000", "1.2.3.99")
	wait, ok := tracker.allow(clientIP(req), now)
	if ok {
		t.Fatal("轮换 X-Forwarded-For 后仍被放行，锁定被绕过")
	}
	if wait <= 0 {
		t.Errorf("锁定剩余时间 = %v，期望大于 0", wait)
	}
}

// TestLoginAttemptTrackerSweepsExpiredEntries 条目数超上限时清理已失效记录，
// 避免分布式来源下 map 单向增长。
func TestLoginAttemptTrackerSweepsExpiredEntries(t *testing.T) {
	tracker := newLoginAttemptTracker()
	stale := time.Now().Add(-2 * webLoginFailureWindow)

	for i := 0; i <= webLoginAttemptTrackerMaxEntries; i++ {
		tracker.recordFailure(fmt.Sprintf("198.51.100.%d", i), stale)
	}

	// 用当前时间再记一次，触发清扫：此前的记录都已超出失败窗口。
	tracker.recordFailure("203.0.113.1", time.Now())

	tracker.mu.Lock()
	size := len(tracker.attempts)
	tracker.mu.Unlock()
	if size > webLoginAttemptTrackerMaxEntries {
		t.Fatalf("清扫后条目数 = %d，仍超过上限 %d", size, webLoginAttemptTrackerMaxEntries)
	}
}
