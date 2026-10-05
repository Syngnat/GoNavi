package db

import (
	"errors"
	"strings"
)

// etcd 控制台命令沿用 etcdctl 的写法，v3 与 v2 API 共用一套解析：
//   v3：get <key> [<range_end>] [--prefix] [--from-key] [--limit=N] [--rev=N] [--keys-only] [--count-only]
//       [--sort-by=KEY|VERSION|CREATE|MODIFY|VALUE] [--order=ASCEND|DESCEND]、put <key> <value> [--lease=ID] [--prev-kv]、
//       del <key> [<range_end>] [--prefix] [--from-key] [--prev-kv]、lease grant|revoke|timetolive|list|keep-alive、
//       member list、endpoint status|health、alarm list、user list|get、role list|get、compaction <rev>、
//       watch <key> [--prefix] [--rev=N] [--timeout=秒] [--limit=N]（有界收集事件）
//   v2：ls [<dir>] [--recursive]、get <key>、set|mk <key> <value> [--ttl=N]、update <key> <value>、mkdir <dir>、
//       rm <key> [--recursive] [--dir]、rmdir <dir>
// 引号（单引号原样、双引号支持反斜杠转义）包住带空格或 JSON 的值。这个文件不带构建标签：app 层的只读判定也要用。

// etcdValueFlags 是取值的选项：除 --name=value 外还接受 --name value 两段写法。
var etcdValueFlags = map[string]struct{}{
	"limit": {}, "rev": {}, "sort-by": {}, "order": {}, "lease": {}, "ttl": {}, "timeout": {}, "after-index": {},
}

// etcdCommand 是解析后的命令：name 为小写的命令名，args 为位置参数，flags 为选项（布尔选项的值为 "true"）。
type etcdCommand struct {
	name  string
	args  []string
	flags map[string]string
}

func (c etcdCommand) flag(name string) (string, bool) {
	value, ok := c.flags[name]
	return value, ok
}

func (c etcdCommand) boolFlag(name string) bool {
	value, ok := c.flags[name]
	return ok && !strings.EqualFold(value, "false")
}

// subcommand 返回第一个位置参数的小写形式（lease list、member list 等）。
func (c etcdCommand) subcommand() string {
	if len(c.args) == 0 {
		return ""
	}
	return strings.ToLower(c.args[0])
}

// parseEtcdCommand 解析一条控制台命令；引号外的结尾分号（脚本里的语句分隔符）会被忽略。
func parseEtcdCommand(text string) (etcdCommand, error) {
	tokens, err := tokenizeShellCommand(trimShellTerminator(text))
	if errors.Is(err, errShellUnclosedQuote) {
		return etcdCommand{}, localizedDatabaseRuntimeError("db.backend.error.etcd_command_unclosed_quote", nil)
	}
	if err != nil {
		return etcdCommand{}, err
	}
	if len(tokens) == 0 {
		return etcdCommand{}, localizedDatabaseRuntimeError("db.backend.error.etcd_command_empty", nil)
	}
	command := etcdCommand{name: strings.ToLower(tokens[0].text), flags: map[string]string{}}
	for i := 1; i < len(tokens); i++ {
		token := tokens[i]
		if token.quoted || !strings.HasPrefix(token.text, "--") || len(token.text) == 2 {
			command.args = append(command.args, token.text)
			continue
		}
		name, value, hasValue := strings.Cut(token.text[2:], "=")
		name = strings.ToLower(name)
		if !hasValue {
			if _, takesValue := etcdValueFlags[name]; takesValue && i+1 < len(tokens) {
				i++
				value = tokens[i].text
			} else {
				value = "true"
			}
		}
		command.flags[name] = value
	}
	return command, nil
}

// etcdReadSubcommands 是只读的二级命令（lease list、member list 等）。
var etcdReadSubcommands = map[string]map[string]struct{}{
	"lease":    {"list": {}, "timetolive": {}},
	"member":   {"list": {}},
	"endpoint": {"status": {}, "health": {}, "hashkv": {}},
	"alarm":    {"list": {}},
	"user":     {"list": {}, "get": {}},
	"role":     {"list": {}, "get": {}},
}

// IsEtcdReadCommand 报告 etcd 控制台命令是否只读：get、ls、watch、version、数据浏览的 SELECT 与上面的二级查询命令；
// 无法解析的文本按写入处理。
func IsEtcdReadCommand(text string) bool {
	command, err := parseEtcdCommand(text)
	if err != nil {
		return false
	}
	switch command.name {
	case "get", "ls", "version", "watch", "select":
		return true
	}
	if subcommands, ok := etcdReadSubcommands[command.name]; ok {
		_, read := subcommands[command.subcommand()]
		return read
	}
	return false
}

// etcdPrefixEnd 返回前缀范围的结束键（与 clientv3.GetPrefixRangeEnd 一致）：最后一个不是 0xff 的字节加一。
func etcdPrefixEnd(prefix string) string {
	end := []byte(prefix)
	for i := len(end) - 1; i >= 0; i-- {
		if end[i] < 0xff {
			end[i]++
			return string(end[:i+1])
		}
	}
	// 全是 0xff：没有上界，用 "\x00" 表示到键空间末尾。
	return "\x00"
}

func etcdFlagError(name, value string) error {
	return localizedDatabaseRuntimeError("db.backend.error.etcd_command_flag_invalid", map[string]any{"flag": name, "value": value})
}

func etcdUsageError(usage string) error {
	return localizedDatabaseRuntimeError("db.backend.error.etcd_command_usage", map[string]any{"usage": usage})
}
