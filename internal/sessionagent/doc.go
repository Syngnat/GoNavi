// Package sessionagent 管理本机智能体 CLI 的会话浏览：扫描本地会话
// 记录、解析为统一消息块、支持查看/导出/删除/复制恢复命令。
//
// 方案参考 cc-switch（github.com/farion1231/cc-switch，MIT）的会话
// 管理器实现：纯只读浏览本地文件（~/.codex、~/.claude 等），不复制、
// 不备份、不落缓存库——列表层与详情层都是进程内内存缓存，指纹
// （mtime+len）判活。大内容（工具输出全文、思考正文）不进消息体，
// 以 ContentRef 字节引用下发，前端按需取全文分页读取。
//
// 本包不理解工具私有格式的全部细节，只抽取可解释的部分；未知记录
// 保留原文引用（ContentRef）或忽略，不猜测、不伪解码。
package sessionagent
