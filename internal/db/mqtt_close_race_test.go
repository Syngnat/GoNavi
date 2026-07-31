package db

import (
	"sync"
	"testing"
	"time"

	pahomqtt "github.com/eclipse/paho.mqtt.golang"
)

// stubMQTTToken 是一个立即完成、无错误的 paho Token。
type stubMQTTToken struct{}

func (stubMQTTToken) Wait() bool                     { return true }
func (stubMQTTToken) WaitTimeout(time.Duration) bool { return true }
func (stubMQTTToken) Done() <-chan struct{} {
	ch := make(chan struct{})
	close(ch)
	return ch
}
func (stubMQTTToken) Error() error { return nil }

// stubMQTTClient 是一个最小的 pahomqtt.Client 实现，用于在不连真实 broker 的情况下
// 验证 pahoMQTTRuntime 的关闭语义。所有方法都可在 Disconnect 之后安全调用（返回 Token 而非 panic），
// 这与 paho 真实客户端在已断开状态下的行为一致。
type stubMQTTClient struct {
	mu         sync.Mutex
	connected  bool
	disconnect int
}

func (c *stubMQTTClient) disconnectCalls() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.disconnect
}

func (c *stubMQTTClient) IsConnected() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.connected
}

func (c *stubMQTTClient) IsConnectionOpen() bool { return c.IsConnected() }

func (c *stubMQTTClient) Connect() pahomqtt.Token { return stubMQTTToken{} }

func (c *stubMQTTClient) Disconnect(uint) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.disconnect++
	c.connected = false
}

func (c *stubMQTTClient) Publish(string, byte, bool, interface{}) pahomqtt.Token {
	return stubMQTTToken{}
}

func (c *stubMQTTClient) Subscribe(string, byte, pahomqtt.MessageHandler) pahomqtt.Token {
	return stubMQTTToken{}
}

func (c *stubMQTTClient) SubscribeMultiple(map[string]byte, pahomqtt.MessageHandler) pahomqtt.Token {
	return stubMQTTToken{}
}

func (c *stubMQTTClient) Unsubscribe(...string) pahomqtt.Token { return stubMQTTToken{} }

func (c *stubMQTTClient) AddRoute(string, pahomqtt.MessageHandler) {}

func (c *stubMQTTClient) OptionsReader() pahomqtt.ClientOptionsReader {
	return pahomqtt.ClientOptionsReader{}
}

// TestPahoMQTTRuntimeCloseDoesNotNilClientForInflightReaders 覆盖 MQTT 关闭与在途读者的竞争。
//
// 回归背景：Close() 原先在无锁保护下把 r.client 置为 nil，而 FetchMessages 会在 4~30 秒的
// 等待窗口结束后才在 defer 里解引用客户端调 Unsubscribe。保活探测失败或用户断开连接触发
// Close 后，那次 nil 接口方法调用会 panic 并崩掉整个 Wails 桌面进程（用户未保存的编辑内容一并丢失）。
// 修复后 Close 只置 closed 标志并断开连接，字段保留给在途读者。
func TestPahoMQTTRuntimeCloseDoesNotNilClientForInflightReaders(t *testing.T) {
	runtime := &pahoMQTTRuntime{client: &stubMQTTClient{connected: true}, timeout: time.Second}

	// 在途读者先取到快照。
	client, err := runtime.activeClient()
	if err != nil {
		t.Fatalf("activeClient 返回错误：%v", err)
	}
	if client == nil {
		t.Fatal("activeClient 返回了 nil 客户端")
	}

	if err := runtime.Close(); err != nil {
		t.Fatalf("Close 返回错误：%v", err)
	}

	// 关键断言：Close 之后字段不得被置 nil，否则在途读者的 defer 会 nil 解引用而 panic。
	if runtime.client == nil {
		t.Fatal("Close 把 client 置为 nil，在途读者解引用会 panic")
	}
	// 快照必须仍然可用（模拟 FetchMessages 的 defer 调 Unsubscribe）。
	if tok := client.Unsubscribe("t"); tok == nil {
		t.Fatal("快照客户端在 Close 后不可用")
	}

	// 关闭后新的调用应当被拒绝，口径与原先置 nil 一致。
	if _, err := runtime.activeClient(); err == nil {
		t.Fatal("Close 之后 activeClient 仍返回可用客户端，期望报错")
	}
}

// TestPahoMQTTRuntimeConcurrentCloseAndFetchIsSafe 并发交错 Close 与取快照，
// 断言不会 panic 且状态收敛。
func TestPahoMQTTRuntimeConcurrentCloseAndFetchIsSafe(t *testing.T) {
	for round := 0; round < 50; round++ {
		runtime := &pahoMQTTRuntime{client: &stubMQTTClient{connected: true}, timeout: time.Second}

		var wg sync.WaitGroup
		wg.Add(2)
		go func() {
			defer wg.Done()
			// 模拟在途读者：取快照后仍会解引用它。
			if client, err := runtime.activeClient(); err == nil && client != nil {
				_ = client.Unsubscribe("t")
			}
		}()
		go func() {
			defer wg.Done()
			_ = runtime.Close()
		}()
		wg.Wait()

		if runtime.client == nil {
			t.Fatalf("第 %d 轮：client 被置为 nil", round)
		}
	}
}

// TestPahoMQTTRuntimeCloseIsIdempotent 重复 Close 不得重复 Disconnect 或报错。
func TestPahoMQTTRuntimeCloseIsIdempotent(t *testing.T) {
	stub := &stubMQTTClient{connected: true}
	runtime := &pahoMQTTRuntime{client: stub, timeout: time.Second}

	if err := runtime.Close(); err != nil {
		t.Fatalf("第一次 Close 返回错误：%v", err)
	}
	if err := runtime.Close(); err != nil {
		t.Fatalf("第二次 Close 返回错误：%v", err)
	}
	if got := stub.disconnectCalls(); got != 1 {
		t.Errorf("Disconnect 调用次数 = %d，期望 1（Close 应幂等）", got)
	}
}
