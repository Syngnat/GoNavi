// Package dbuser 实现跨数据源的账号、角色与权限管理领域逻辑。
//
// 设计约束：
//   - 纯领域包：不依赖 internal/app，也不引入任何驱动 SDK（包括 mongo bson），
//     以免破坏 lite 构建；所有 IO 都经由消费方注入的 Env 小接口完成。
//   - Provider.Plan 是纯函数：同一 ServerProfile + ChangeRequest 必然产生同一 Plan，
//     这是 Preview 与 Apply 指纹比对成立的前提。
//   - 口令只出现在 Statement.Exec / Statement.Args 中，Display、日志、审计、错误
//     文本一律使用掩码；错误经 SanitizeError 处理后再向上返回。
package dbuser
