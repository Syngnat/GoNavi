package db

import (
	"errors"
	"strconv"
	"strings"
)

// ZooKeeper 控制台命令沿用 zkCli 的写法：
//   读：ls [-s] [-R] <path>、ls2 <path>、get [-s] <path>、stat <path>、getAcl [-s] <path>、sync <path>、
//       getAllChildrenNumber <path>、getEphemerals [path]、listquota <path>、config、version、addauth <scheme> <auth>
//   写：create [-s] [-e] [-c] [-t ttl] <path> [data] [acl]、set [-s] [-v version] <path> <data>、
//       delete [-v version] <path>、deleteall <path>（rmr）、setAcl [-s] [-v version] [-R] <path> <acl>
//   四字命令：srvr、stat（不带路径）、ruok、conf、envi、mntr、cons、wchs、wchc、wchp、dump、isro、dirs，或 4lw <命令>
// 引号规则与 etcd 控制台相同（见 kv_command.go），引号里的 -x 不是选项，-- 之后全是参数。
// 这个文件不带构建标签：app 层的只读判定也要用。

// zookeeperValueOptions 是带值的选项：-t ttl、-v version、-b batch。
var zookeeperValueOptions = map[byte]struct{}{'t': {}, 'v': {}, 'b': {}}

// zookeeperCommand 是解析后的命令：name 为小写的命令名，options 为单字母选项（区分大小写，布尔选项的值为 "true"）。
type zookeeperCommand struct {
	name    string
	args    []string
	options map[string]string
}

func (c zookeeperCommand) option(name string) (string, bool) {
	value, ok := c.options[name]
	return value, ok
}

func (c zookeeperCommand) hasOption(name string) bool {
	_, ok := c.options[name]
	return ok
}

// parseZooKeeperCommand 解析一条控制台命令；引号外的结尾分号（脚本里的语句分隔符）会被忽略。
func parseZooKeeperCommand(text string) (zookeeperCommand, error) {
	tokens, err := tokenizeShellCommand(trimShellTerminator(text))
	if errors.Is(err, errShellUnclosedQuote) {
		return zookeeperCommand{}, localizedDatabaseRuntimeError("db.backend.error.zookeeper_command_unclosed_quote", nil)
	}
	if err != nil {
		return zookeeperCommand{}, err
	}
	if len(tokens) == 0 {
		return zookeeperCommand{}, localizedDatabaseRuntimeError("db.backend.error.zookeeper_command_empty", nil)
	}
	command := zookeeperCommand{name: strings.ToLower(tokens[0].text), options: map[string]string{}}
	optionsDone := false
	for i := 1; i < len(tokens); i++ {
		token := tokens[i]
		if optionsDone || token.quoted || len(token.text) < 2 || token.text[0] != '-' || isZooKeeperNumber(token.text) {
			command.args = append(command.args, token.text)
			continue
		}
		if token.text == "--" {
			optionsDone = true
			continue
		}
		// 同 zkCli：-es 是两个布尔选项，-t 60000 与 -t60000 等价。
		letters := token.text[1:]
		for j := 0; j < len(letters); j++ {
			if _, takesValue := zookeeperValueOptions[letters[j]]; takesValue {
				value := letters[j+1:]
				if value == "" && i+1 < len(tokens) {
					i++
					value = tokens[i].text
				}
				command.options[letters[j:j+1]] = value
				break
			}
			command.options[letters[j:j+1]] = "true"
		}
	}
	return command, nil
}

func isZooKeeperNumber(text string) bool {
	_, err := strconv.ParseFloat(text, 64)
	return err == nil
}

// zookeeperReadCommands 是只读命令；addauth 只给当前会话添加身份、sync 只同步视图，都不改数据。
var zookeeperReadCommands = map[string]struct{}{
	"ls": {}, "ls2": {}, "get": {}, "stat": {}, "getacl": {}, "sync": {}, "addauth": {}, "version": {}, "config": {},
	"getallchildrennumber": {}, "getephemerals": {}, "listquota": {}, "select": {},
}

// zookeeperFourLetterWords 是控制台支持的四字命令；值为 true 表示只读（crst、srst 会重置服务端统计）。
var zookeeperFourLetterWords = map[string]bool{
	"srvr": true, "stat": true, "ruok": true, "conf": true, "envi": true, "mntr": true, "cons": true, "wchs": true,
	"wchc": true, "wchp": true, "dump": true, "isro": true, "dirs": true, "gtmk": true, "crst": false, "srst": false,
}

// IsZooKeeperReadCommand 报告 ZooKeeper 控制台命令是否只读：查询类命令、只读四字命令与数据浏览的 SELECT；
// 无法解析的文本按写入处理。
func IsZooKeeperReadCommand(text string) bool {
	command, err := parseZooKeeperCommand(text)
	if err != nil {
		return false
	}
	if command.name == "4lw" {
		return len(command.args) > 0 && zookeeperFourLetterWords[strings.ToLower(command.args[0])]
	}
	if _, ok := zookeeperReadCommands[command.name]; ok {
		return true
	}
	return zookeeperFourLetterWords[command.name]
}
