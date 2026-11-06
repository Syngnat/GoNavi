package webserver

import (
	"os"
	"strconv"
	"strings"
	"sync"
)

const (
	defaultWebMaxInflight        = 64
	defaultWebMaxInflightPerUser = 8
	maxWebInflightLimit          = 4096
)

// invokeLimiter 给 Web RPC 加准入上限。
//
// 之前只有审计导出/校验有并发闸门，普通查询可以无限并发：单个客户端就能
// 占满连接池和堆内存。这里同时限制全局与单账号在途请求，超限直接 429，
// 让调用方尽快得到反馈而不是把服务拖进 GC 抖动。
type invokeLimiter struct {
	mu           sync.Mutex
	limit        int
	perUserLimit int
	inflight     int
	perUser      map[string]int
}

func newInvokeLimiterFromEnv() *invokeLimiter {
	limit := envPositiveInt("GONAVI_WEB_MAX_INFLIGHT", defaultWebMaxInflight, maxWebInflightLimit)
	perUser := envPositiveInt("GONAVI_WEB_MAX_INFLIGHT_PER_USER", defaultWebMaxInflightPerUser, maxWebInflightLimit)
	return &invokeLimiter{
		limit:        limit,
		perUserLimit: perUser,
		perUser:      make(map[string]int),
	}
}

// acquire 尝试占用一个在途名额，失败时返回 false 且不改变计数。
func (l *invokeLimiter) acquire(username string) (func(), bool) {
	if l == nil {
		return func() {}, true
	}
	user := strings.TrimSpace(username)
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.inflight >= l.limit {
		return nil, false
	}
	if user != "" && l.perUser[user] >= l.perUserLimit {
		return nil, false
	}
	l.inflight++
	if user != "" {
		l.perUser[user]++
	}
	released := false
	return func() {
		l.mu.Lock()
		defer l.mu.Unlock()
		if released {
			return
		}
		released = true
		l.inflight--
		if user == "" {
			return
		}
		l.perUser[user]--
		if l.perUser[user] <= 0 {
			delete(l.perUser, user)
		}
	}, true
}

func envBool(name string) bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(name))) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}

func envPositiveInt(name string, fallback int, maximum int) int {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return fallback
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value < 1 {
		return fallback
	}
	if value > maximum {
		return maximum
	}
	return value
}
