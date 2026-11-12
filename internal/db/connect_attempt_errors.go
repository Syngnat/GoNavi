package db

import (
	"fmt"
	"strings"
)

// connectAttemptError 承载「多次连接尝试全部失败」的汇总消息，同时把最后一次
// 底层错误保留在错误链上。
//
// 各驱动原本用 fmt.Errorf("...：%s", strings.Join(failures, "；")) 拼接：消息
// 里已经包含了底层错误文本，但 Unwrap 拿不到任何 cause，于是 logger.ErrorChain
// 只能把外层消息再打印一遍——日志里就会出现「同一段错误重复两次」。保留 cause
// 之后，错误链能正常展开，重复消失，底层错误（EOF、认证失败、超时…）也能被
// errors.As/Is 识别。
type connectAttemptError struct {
	message string
	cause   error
}

func (e connectAttemptError) Error() string { return e.message }

func (e connectAttemptError) Unwrap() error { return e.cause }

// newConnectAttemptError 用已收集的失败描述拼出汇总消息，并把 lastErr 挂到错误链上。
// lastErr 可以为 nil（例如所有尝试都在打开连接前被跳过）。
func newConnectAttemptError(prefix string, failures []string, lastErr error) error {
	return newConnectAttemptErrorWithSuffix(prefix, "", failures, lastErr)
}

// newConnectAttemptErrorWithSuffix 在汇总消息末尾追加一段补充说明（如自助提示）。
//
// 说明追加在失败明细之后，而不是并进 prefix：并进 prefix 会把「前缀：明细」的
// 冒号顶掉，读起来变成「验证失败。提示：…。：SSL 数据库=…」。说明仍留在同一条
// 消息里、不额外包一层，logger.ErrorChain 也就不会把明细重复打印一遍。
func newConnectAttemptErrorWithSuffix(prefix string, suffix string, failures []string, lastErr error) error {
	message := prefix
	if joined := strings.Join(failures, "；"); joined != "" {
		message = prefix + "：" + joined
	}
	message += suffix
	if lastErr == nil {
		return fmt.Errorf("%s", message)
	}
	return connectAttemptError{message: message, cause: lastErr}
}

// wrapDatabaseConnectCause 给已经带有本地化文案的错误挂上底层 cause。
// 用于「消息由 i18n 文案决定、但底层错误仍需可展开」的场景（如 gbase8c）。
func wrapDatabaseConnectCause(message error, cause error) error {
	if message == nil {
		return nil
	}
	if cause == nil {
		return message
	}
	return connectAttemptError{message: message.Error(), cause: cause}
}
