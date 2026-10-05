//go:build gonavi_full_drivers || gonavi_zookeeper_driver

package db

import (
	"context"
	"errors"
	"io"
	"strings"
	"time"

	"github.com/go-zookeeper/zk"
)

// ZooKeeper 控制台：数据浏览的 SELECT 走 runSelect，其余按 zkCli 风格命令执行（语法见 zookeeper_command.go）。

const (
	zookeeperConfigNode = "/zookeeper/config"
	zookeeperQuotaRoot  = "/zookeeper/quota"
	zookeeperClientName = "go-zookeeper/zk 1.0.4"
)

func (z *ZooKeeperDB) QueryContext(ctx context.Context, query string) ([]map[string]interface{}, []string, error) {
	if z.conn == nil {
		return nil, nil, localizedDatabaseRuntimeError("db.backend.error.connection_not_open", nil)
	}
	selection, isSelect, err := parseKVSelect(query, zookeeperDefaultSelectLimit)
	if err != nil {
		return nil, nil, err
	}
	if isSelect {
		return z.runSelect(ctx, selection)
	}
	command, err := parseZooKeeperCommand(query)
	if err != nil {
		return nil, nil, err
	}
	return z.runCommand(ctx, command)
}

func (z *ZooKeeperDB) Query(query string) ([]map[string]interface{}, []string, error) {
	return z.QueryContext(metadataContextFor(z), query)
}

// ExecContext 执行写命令；影响行数取删除的节点数，或命令返回的行数。
func (z *ZooKeeperDB) ExecContext(ctx context.Context, query string) (int64, error) {
	rows, _, err := z.QueryContext(ctx, query)
	if err != nil {
		return 0, err
	}
	if len(rows) == 1 {
		if deleted, ok := rows[0]["deleted"].(int64); ok {
			return deleted, nil
		}
	}
	return int64(len(rows)), nil
}

func (z *ZooKeeperDB) Exec(query string) (int64, error) {
	return z.ExecContext(context.Background(), query)
}

func (z *ZooKeeperDB) runCommand(ctx context.Context, command zookeeperCommand) ([]map[string]interface{}, []string, error) {
	switch command.name {
	case "ls", "ls2":
		return z.commandList(ctx, command)
	case "get":
		return z.commandGet(command)
	case "stat":
		if len(command.args) == 0 {
			return z.commandFourLetter(ctx, "stat")
		}
		return z.commandStat(command)
	case "getacl":
		return z.commandGetACL(command)
	case "sync":
		path, err := zookeeperPathArg(command, "sync <path>")
		if err != nil {
			return nil, nil, err
		}
		synced, err := z.conn.Sync(path)
		if err != nil {
			return nil, nil, zookeeperError(err, path)
		}
		return []map[string]interface{}{{zookeeperColumnPath: synced}}, []string{zookeeperColumnPath}, nil
	case "addauth":
		if len(command.args) < 2 {
			return nil, nil, zookeeperUsageError("addauth <scheme> <auth>")
		}
		if err := z.conn.AddAuth(command.args[0], []byte(command.args[1])); err != nil {
			return nil, nil, zookeeperError(err, "")
		}
		z.cache.clear()
		return []map[string]interface{}{{"scheme": command.args[0]}}, []string{"scheme"}, nil
	case "getallchildrennumber":
		return z.commandChildrenNumber(ctx, command)
	case "getephemerals":
		return z.commandEphemerals(ctx, command)
	case "listquota":
		return z.commandListQuota(command)
	case "config":
		return z.commandConfig()
	case "version":
		return z.commandVersion(ctx)
	case "4lw":
		if len(command.args) == 0 {
			return nil, nil, zookeeperUsageError("4lw <srvr|stat|ruok|conf|envi|mntr|cons|wchs|wchc|wchp|dump|isro|dirs|gtmk|crst|srst>")
		}
		return z.commandFourLetter(ctx, strings.ToLower(command.args[0]))
	case "create", "set", "delete", "deleteall", "rmr", "setacl":
		z.cache.clear()
		return z.runWriteCommand(ctx, command)
	}
	if _, ok := zookeeperFourLetterWords[command.name]; ok {
		return z.commandFourLetter(ctx, command.name)
	}
	return nil, nil, localizedDatabaseRuntimeError("db.backend.error.zookeeper_command_unknown", map[string]any{"command": command.name})
}

func zookeeperUsageError(usage string) error {
	return localizedDatabaseRuntimeError("db.backend.error.zookeeper_command_usage", map[string]any{"usage": usage})
}

// zookeeperPathArg 取第一个位置参数作为路径（规范化后必须以 / 开头）。
func zookeeperPathArg(command zookeeperCommand, usage string) (string, error) {
	if len(command.args) == 0 {
		return "", zookeeperUsageError(usage)
	}
	path := command.args[0]
	if !strings.HasPrefix(path, "/") {
		return "", localizedDatabaseRuntimeError("db.backend.error.zookeeper_path_invalid", map[string]any{"path": path})
	}
	return normalizeZooKeeperPath(path), nil
}

// statColumns 是带 stat 的结果列：与网格一致，去掉 data 时用于 stat / ls -s。
func statColumns(withData bool) []string {
	if withData {
		return zookeeperColumns
	}
	columns := make([]string, 0, len(zookeeperColumns)-1)
	for _, column := range zookeeperColumns {
		if column != zookeeperColumnData {
			columns = append(columns, column)
		}
	}
	return columns
}

// commandList 实现 ls：默认列出子节点名与完整路径；-s 列出每个子节点的 stat；-R 递归列出子树全部路径。
func (z *ZooKeeperDB) commandList(ctx context.Context, command zookeeperCommand) ([]map[string]interface{}, []string, error) {
	path, err := zookeeperPathArg(command, "ls [-s] [-R] <path>")
	if err != nil {
		return nil, nil, err
	}
	if command.hasOption("R") {
		nodes, truncated, err := z.walk(ctx, path, zookeeperScanCap)
		if err != nil {
			return nil, nil, err
		}
		if truncated {
			sortZooKeeperNodes(nodes, false)
		}
		if len(nodes) == 0 {
			return nil, nil, zookeeperError(zk.ErrNoNode, path)
		}
		rows := make([]map[string]interface{}, 0, len(nodes))
		for _, node := range nodes {
			rows = append(rows, map[string]interface{}{zookeeperColumnPath: node.path})
		}
		return rows, []string{zookeeperColumnPath}, nil
	}
	names, _, err := z.children(path)
	if err != nil {
		return nil, nil, zookeeperError(err, path)
	}
	if !command.hasOption("s") && command.name != "ls2" {
		rows := make([]map[string]interface{}, 0, len(names))
		for _, name := range names {
			rows = append(rows, map[string]interface{}{"name": name, zookeeperColumnPath: joinZooKeeperPath(path, name)})
		}
		return rows, []string{"name", zookeeperColumnPath}, nil
	}
	paths := make([]string, 0, len(names))
	for _, name := range names {
		paths = append(paths, joinZooKeeperPath(path, name))
	}
	nodes, err := z.statNodes(paths)
	if err != nil {
		return nil, nil, err
	}
	columns := statColumns(false)
	rows := make([]map[string]interface{}, 0, len(nodes))
	for _, node := range nodes {
		rows = append(rows, zookeeperRowMap(node, columns))
	}
	return rows, columns, nil
}

func (z *ZooKeeperDB) commandGet(command zookeeperCommand) ([]map[string]interface{}, []string, error) {
	path, err := zookeeperPathArg(command, "get [-s] <path>")
	if err != nil {
		return nil, nil, err
	}
	data, stat, err := z.conn.Get(path)
	if err != nil {
		return nil, nil, zookeeperError(err, path)
	}
	columns := []string{zookeeperColumnPath, zookeeperColumnData}
	if command.hasOption("s") {
		columns = zookeeperColumns
	}
	node := zookeeperNode{path: path, data: data, stat: *stat, loaded: true}
	return []map[string]interface{}{zookeeperRowMap(node, columns)}, columns, nil
}

func (z *ZooKeeperDB) commandStat(command zookeeperCommand) ([]map[string]interface{}, []string, error) {
	path, err := zookeeperPathArg(command, "stat <path>")
	if err != nil {
		return nil, nil, err
	}
	exists, stat, err := z.conn.Exists(path)
	if err == nil && !exists {
		err = zk.ErrNoNode
	}
	if err != nil {
		return nil, nil, zookeeperError(err, path)
	}
	columns := statColumns(false)
	return []map[string]interface{}{zookeeperRowMap(zookeeperNode{path: path, stat: *stat}, columns)}, columns, nil
}

func (z *ZooKeeperDB) commandGetACL(command zookeeperCommand) ([]map[string]interface{}, []string, error) {
	path, err := zookeeperPathArg(command, "getAcl [-s] <path>")
	if err != nil {
		return nil, nil, err
	}
	acls, _, err := z.conn.GetACL(path)
	if err != nil {
		return nil, nil, zookeeperError(err, path)
	}
	rows := make([]map[string]interface{}, 0, len(acls))
	for _, acl := range acls {
		rows = append(rows, map[string]interface{}{"scheme": acl.Scheme, "id": acl.ID, "perms": formatZooKeeperPerms(acl.Perms)})
	}
	return rows, []string{"scheme", "id", "perms"}, nil
}

// commandChildrenNumber 实现 getAllChildrenNumber：子树里除自身外的节点数（客户端遍历统计，3.4 同样可用）。
func (z *ZooKeeperDB) commandChildrenNumber(ctx context.Context, command zookeeperCommand) ([]map[string]interface{}, []string, error) {
	path, err := zookeeperPathArg(command, "getAllChildrenNumber <path>")
	if err != nil {
		return nil, nil, err
	}
	nodes, _, err := z.walk(ctx, path, zookeeperScanCap)
	if err != nil {
		return nil, nil, err
	}
	if len(nodes) == 0 {
		return nil, nil, zookeeperError(zk.ErrNoNode, path)
	}
	return []map[string]interface{}{{zookeeperColumnPath: path, "count": int64(len(nodes) - 1)}}, []string{zookeeperColumnPath, "count"}, nil
}

// commandEphemerals 实现 getEphemerals：列出当前会话创建的临时节点。
func (z *ZooKeeperDB) commandEphemerals(ctx context.Context, command zookeeperCommand) ([]map[string]interface{}, []string, error) {
	path := "/"
	if len(command.args) > 0 {
		var err error
		if path, err = zookeeperPathArg(command, "getEphemerals [path]"); err != nil {
			return nil, nil, err
		}
	}
	nodes, _, err := z.walk(ctx, path, zookeeperScanCap)
	if err != nil {
		return nil, nil, err
	}
	session := z.conn.SessionID()
	rows := []map[string]interface{}{}
	for _, node := range nodes {
		if node.stat.EphemeralOwner == session {
			rows = append(rows, map[string]interface{}{zookeeperColumnPath: node.path})
		}
	}
	return rows, []string{zookeeperColumnPath}, nil
}

// commandListQuota 读取 /zookeeper/quota 下的配额限制与统计。
func (z *ZooKeeperDB) commandListQuota(command zookeeperCommand) ([]map[string]interface{}, []string, error) {
	path, err := zookeeperPathArg(command, "listquota <path>")
	if err != nil {
		return nil, nil, err
	}
	rows := []map[string]interface{}{}
	for _, kind := range []string{"limits", "stats"} {
		data, _, err := z.conn.Get(zookeeperQuotaRoot + path + "/zookeeper_" + kind)
		if errors.Is(err, zk.ErrNoNode) {
			continue
		}
		if err != nil {
			return nil, nil, zookeeperError(err, path)
		}
		rows = append(rows, map[string]interface{}{"kind": kind, "value": string(data)})
	}
	if len(rows) == 0 {
		return nil, nil, localizedDatabaseRuntimeError("db.backend.error.zookeeper_quota_missing", map[string]any{"path": path})
	}
	return rows, []string{"kind", "value"}, nil
}

// commandConfig 读取 3.5 起的动态配置节点 /zookeeper/config。
func (z *ZooKeeperDB) commandConfig() ([]map[string]interface{}, []string, error) {
	if !z.atLeast("3.5") {
		return nil, nil, localizedDatabaseRuntimeError("db.backend.error.zookeeper_requires_version", map[string]any{
			"feature": "config", "version": "3.5",
		})
	}
	data, _, err := z.conn.Get(zookeeperConfigNode)
	if err != nil {
		return nil, nil, zookeeperError(err, zookeeperConfigNode)
	}
	rows, columns := zookeeperKeyValueRows(string(data), "=")
	return rows, columns, nil
}

func (z *ZooKeeperDB) commandVersion(ctx context.Context) ([]map[string]interface{}, []string, error) {
	version := z.serverVersion
	if version == "" {
		// 连接时四字命令不可用：再试一次（白名单可能已调整），仍只能按特性推断时不报告版本。
		if detected, probed := z.detectVersion(ctx); !probed {
			version = detected
		}
	}
	return []map[string]interface{}{{"version": version, "variant": z.variant.ID, "client": zookeeperClientName}},
		[]string{"version", "variant", "client"}, nil
}

// commandFourLetter 发送四字命令并把输出转成表格：键值格式的命令拆成 key / value 两列，其余逐行输出。
func (z *ZooKeeperDB) commandFourLetter(ctx context.Context, word string) ([]map[string]interface{}, []string, error) {
	if _, ok := zookeeperFourLetterWords[word]; !ok {
		return nil, nil, localizedDatabaseRuntimeError("db.backend.error.zookeeper_command_unknown", map[string]any{"command": word})
	}
	text, err := z.fourLetterWord(ctx, word)
	if err != nil {
		return nil, nil, err
	}
	switch word {
	case "mntr":
		rows, columns := zookeeperKeyValueRows(text, "\t")
		return rows, columns, nil
	case "conf", "envi":
		rows, columns := zookeeperKeyValueRows(text, "=")
		return rows, columns, nil
	case "srvr":
		rows, columns := zookeeperKeyValueRows(text, ":")
		return rows, columns, nil
	}
	rows := []map[string]interface{}{}
	for _, line := range strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n") {
		if line = strings.TrimRight(line, " \t"); line != "" {
			rows = append(rows, map[string]interface{}{"line": line})
		}
	}
	return rows, []string{"line"}, nil
}

// zookeeperKeyValueRows 按分隔符把每行拆成 key / value（没有分隔符的行整行作为 key）。
func zookeeperKeyValueRows(text, separator string) ([]map[string]interface{}, []string) {
	rows := []map[string]interface{}{}
	for _, line := range strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		key, value, _ := strings.Cut(line, separator)
		rows = append(rows, map[string]interface{}{"key": strings.TrimSpace(key), "value": strings.TrimSpace(value)})
	}
	return rows, []string{"key", "value"}
}

// fourLetterWord 向当前会话所在的节点发送四字命令（与会话共用代理、TLS 与 SSH 转发）。
func (z *ZooKeeperDB) fourLetterWord(ctx context.Context, word string) (string, error) {
	server := z.servers[0]
	if z.conn != nil {
		if current := z.conn.Server(); current != "" {
			server = current
		}
	}
	ctx, cancel := context.WithTimeout(ctx, z.timeout)
	defer cancel()
	conn, err := z.dialContext(ctx, server)
	if err != nil {
		return "", err
	}
	defer conn.Close()
	deadline, _ := ctx.Deadline()
	_ = conn.SetDeadline(deadline)
	if _, err := conn.Write([]byte(word)); err != nil {
		return "", err
	}
	body, err := io.ReadAll(io.LimitReader(conn, 8<<20))
	if err != nil && len(body) == 0 {
		return "", err
	}
	text := string(body)
	if strings.Contains(text, "not in the whitelist") || strings.Contains(text, "not executed because") {
		return "", localizedDatabaseRuntimeError("db.backend.error.zookeeper_4lw_disabled", map[string]any{"command": word})
	}
	return text, nil
}

// zookeeperError 把 go-zookeeper 的错误换成可操作的本地化提示。
func zookeeperError(err error, path string) error {
	params := map[string]any{"path": path}
	switch {
	case err == nil:
		return nil
	case errors.Is(err, zk.ErrNoNode):
		return localizedDatabaseRuntimeError("db.backend.error.zookeeper_node_missing", params)
	case errors.Is(err, zk.ErrNodeExists):
		return localizedDatabaseRuntimeError("db.backend.error.zookeeper_node_exists", params)
	case errors.Is(err, zk.ErrNotEmpty):
		return localizedDatabaseRuntimeError("db.backend.error.zookeeper_node_not_empty", params)
	case errors.Is(err, zk.ErrBadVersion):
		return localizedDatabaseRuntimeError("db.backend.error.zookeeper_version_conflict", params)
	case errors.Is(err, zk.ErrNoAuth):
		return localizedDatabaseRuntimeError("db.backend.error.zookeeper_no_auth", params)
	case errors.Is(err, zk.ErrNoChildrenForEphemerals):
		return localizedDatabaseRuntimeError("db.backend.error.zookeeper_ephemeral_children", params)
	case errors.Is(err, zk.ErrInvalidACL):
		return localizedDatabaseRuntimeError("db.backend.error.zookeeper_acl_invalid", map[string]any{"acl": path})
	case errors.Is(err, zk.ErrInvalidPath):
		return localizedDatabaseRuntimeError("db.backend.error.zookeeper_path_invalid", params)
	case errors.Is(err, zk.ErrAuthFailed):
		return localizedDatabaseRuntimeError("db.backend.error.zookeeper_auth_failed", nil)
	case strings.Contains(err.Error(), "unknown error: -6"):
		// UNIMPLEMENTED：服务端不认识容器 / TTL 节点（3.5.3 以下，或未开启 extendedTypesEnabled）。
		return localizedDatabaseRuntimeError("db.backend.error.zookeeper_unimplemented", nil)
	case errors.Is(err, zk.ErrNoServer), errors.Is(err, zk.ErrConnectionClosed), errors.Is(err, zk.ErrClosing):
		return localizedDatabaseRuntimeError("db.backend.error.zookeeper_connection_lost", map[string]any{"detail": err.Error()})
	}
	return err
}

// zookeeperSleep 在 deleteall 重试之间短暂等待，期间响应取消。
func zookeeperSleep(ctx context.Context, delay time.Duration) error {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
