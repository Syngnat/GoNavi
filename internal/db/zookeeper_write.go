//go:build gonavi_full_drivers || gonavi_zookeeper_driver

package db

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"GoNavi-Wails/internal/connection"

	"github.com/go-zookeeper/zk"
	"golang.org/x/sync/errgroup"
)

// ZooKeeper 写入：控制台的 create / set / delete / deleteall / setAcl，网格增删改合成 multi 原子提交，
// 以及查看 DDL 时生成可重放的 create 脚本。

const (
	// zookeeperMaxMultiOps 是一次 multi 的操作数上限（请求体受服务端 jute.maxbuffer 限制，默认 1MB）。
	zookeeperMaxMultiOps  = 200
	zookeeperDDLNodeLimit = 500
)

func (z *ZooKeeperDB) runWriteCommand(ctx context.Context, command zookeeperCommand) ([]map[string]interface{}, []string, error) {
	switch command.name {
	case "create":
		return z.commandCreate(command)
	case "set":
		return z.commandSet(command)
	case "delete":
		path, err := zookeeperPathArg(command, "delete [-v version] <path>")
		if err != nil {
			return nil, nil, err
		}
		version, err := zookeeperVersionOption(command)
		if err != nil {
			return nil, nil, err
		}
		if err := z.conn.Delete(path, version); err != nil {
			return nil, nil, zookeeperWriteError(err, path)
		}
		return []map[string]interface{}{{"deleted": int64(1)}}, []string{"deleted"}, nil
	case "deleteall", "rmr":
		path, err := zookeeperPathArg(command, "deleteall <path>")
		if err != nil {
			return nil, nil, err
		}
		deleted, err := z.deleteAll(ctx, path)
		if err != nil {
			return nil, nil, err
		}
		return []map[string]interface{}{{"deleted": deleted}}, []string{"deleted"}, nil
	}
	return z.commandSetACL(ctx, command)
}

// zookeeperWriteError 标记写入结果未知（连接在请求途中断开），其余错误按本地化提示返回。
func zookeeperWriteError(err error, path string) error {
	if errors.Is(err, zk.ErrConnectionClosed) || errors.Is(err, zk.ErrClosing) {
		return MarkWriteOutcomeUnknown(zookeeperError(err, path))
	}
	return zookeeperError(err, path)
}

func zookeeperVersionOption(command zookeeperCommand) (int32, error) {
	raw, ok := command.option("v")
	if !ok {
		return -1, nil
	}
	version, err := strconv.ParseInt(raw, 10, 32)
	if err != nil {
		return 0, localizedDatabaseRuntimeError("db.backend.error.zookeeper_option_invalid", map[string]any{"option": "-v", "value": raw})
	}
	return int32(version), nil
}

// commandCreate 实现 create [-s] [-e] [-c] [-t ttl] <path> [data] [acl]。
func (z *ZooKeeperDB) commandCreate(command zookeeperCommand) ([]map[string]interface{}, []string, error) {
	path, err := zookeeperPathArg(command, "create [-s] [-e] [-c] [-t ttl] <path> [data] [acl]")
	if err != nil {
		return nil, nil, err
	}
	if command.hasOption("s") && strings.HasSuffix(command.args[0], "/") {
		// 顺序节点允许以 / 结尾（序号直接拼在父路径下）。
		path = command.args[0]
	}
	var data []byte
	if len(command.args) > 1 {
		data = []byte(command.args[1])
	}
	acl := z.acl
	if len(command.args) > 2 {
		if acl, err = parseZooKeeperACL(command.args[2]); err != nil {
			return nil, nil, err
		}
	}
	sequential, ephemeral := command.hasOption("s"), command.hasOption("e")
	var created string
	switch {
	case command.hasOption("c"):
		if sequential || ephemeral || command.hasOption("t") {
			return nil, nil, zookeeperUsageError("create -c <path> [data] [acl]")
		}
		if err := z.requireVersion("container", "3.5.3"); err != nil {
			return nil, nil, err
		}
		created, err = z.conn.CreateContainer(path, data, zk.FlagContainer, acl)
	case command.hasOption("t"):
		raw, _ := command.option("t")
		ttl, parseErr := strconv.ParseInt(raw, 10, 64)
		if parseErr != nil || ttl <= 0 {
			return nil, nil, localizedDatabaseRuntimeError("db.backend.error.zookeeper_option_invalid", map[string]any{"option": "-t", "value": raw})
		}
		if ephemeral {
			return nil, nil, zookeeperUsageError("create [-s] -t ttl <path> [data] [acl]")
		}
		if err := z.requireVersion("TTL", "3.5.3"); err != nil {
			return nil, nil, err
		}
		flag := int32(zk.FlagTTL)
		if sequential {
			flag = zk.FlagPersistentSequentialWithTTL
		}
		created, err = z.conn.CreateTTL(path, data, flag, acl, time.Duration(ttl)*time.Millisecond)
	default:
		flag := int32(zk.FlagPersistent)
		if ephemeral {
			flag |= zk.FlagEphemeral
		}
		if sequential {
			flag |= zk.FlagSequence
		}
		created, err = z.conn.Create(path, data, flag, acl)
	}
	if err != nil {
		return nil, nil, zookeeperWriteError(err, path)
	}
	return []map[string]interface{}{{zookeeperColumnPath: created}}, []string{zookeeperColumnPath}, nil
}

func (z *ZooKeeperDB) requireVersion(feature, version string) error {
	if z.atLeast(version) {
		return nil
	}
	return localizedDatabaseRuntimeError("db.backend.error.zookeeper_requires_version", map[string]any{"feature": feature, "version": version})
}

// commandSet 实现 set [-s] [-v version] <path> <data>。
func (z *ZooKeeperDB) commandSet(command zookeeperCommand) ([]map[string]interface{}, []string, error) {
	path, err := zookeeperPathArg(command, "set [-s] [-v version] <path> <data>")
	if err != nil {
		return nil, nil, err
	}
	if len(command.args) < 2 {
		return nil, nil, zookeeperUsageError("set [-s] [-v version] <path> <data>")
	}
	version, err := zookeeperVersionOption(command)
	if err != nil {
		return nil, nil, err
	}
	stat, err := z.conn.Set(path, []byte(command.args[1]), version)
	if err != nil {
		return nil, nil, zookeeperWriteError(err, path)
	}
	columns := []string{zookeeperColumnPath, zookeeperColumnVersion}
	if command.hasOption("s") {
		columns = statColumns(false)
	}
	return []map[string]interface{}{zookeeperRowMap(zookeeperNode{path: path, stat: *stat}, columns)}, columns, nil
}

// commandSetACL 实现 setAcl [-s] [-v version] [-R] <path> <acl>；-R 递归设置子树。
func (z *ZooKeeperDB) commandSetACL(ctx context.Context, command zookeeperCommand) ([]map[string]interface{}, []string, error) {
	const usage = "setAcl [-s] [-v version] [-R] <path> <acl>"
	path, err := zookeeperPathArg(command, usage)
	if err != nil {
		return nil, nil, err
	}
	if len(command.args) < 2 {
		return nil, nil, zookeeperUsageError(usage)
	}
	acl, err := parseZooKeeperACL(command.args[1])
	if err != nil {
		return nil, nil, err
	}
	version, err := zookeeperVersionOption(command)
	if err != nil {
		return nil, nil, err
	}
	paths := []string{path}
	if command.hasOption("R") {
		nodes, _, err := z.walk(ctx, path, zookeeperScanCap)
		if err != nil {
			return nil, nil, err
		}
		paths = paths[:0]
		for _, node := range nodes {
			paths = append(paths, node.path)
		}
	}
	var last *zk.Stat
	for _, target := range paths {
		stat, err := z.conn.SetACL(target, acl, version)
		if err != nil {
			return nil, nil, zookeeperWriteError(err, target)
		}
		if target == path {
			last = stat
		}
	}
	if command.hasOption("s") && last != nil {
		columns := statColumns(false)
		return []map[string]interface{}{zookeeperRowMap(zookeeperNode{path: path, stat: *last}, columns)}, columns, nil
	}
	return []map[string]interface{}{{"updated": int64(len(paths))}}, []string{"updated"}, nil
}

// deleteAll 递归删除子树：按深度从深到浅逐层并发删除；遍历被截断或删除期间有新子节点时重新遍历。
func (z *ZooKeeperDB) deleteAll(ctx context.Context, path string) (int64, error) {
	if path == "/" || zookeeperWithin(path, "/zookeeper") {
		return 0, localizedDatabaseRuntimeError("db.backend.error.zookeeper_delete_protected", map[string]any{"path": path})
	}
	var deleted atomic.Int64
	for attempt := 0; ; attempt++ {
		nodes, _, err := z.walk(ctx, path, zookeeperScanCap)
		if err != nil {
			return deleted.Load(), err
		}
		if len(nodes) == 0 {
			if attempt == 0 {
				return 0, zookeeperError(zk.ErrNoNode, path)
			}
			return deleted.Load(), nil
		}
		for _, level := range zookeeperLevelsDeepestFirst(nodes) {
			group, groupCtx := errgroup.WithContext(ctx)
			group.SetLimit(zookeeperParallelism)
			for _, target := range level {
				group.Go(func() error {
					if err := groupCtx.Err(); err != nil {
						return err
					}
					switch err := z.conn.Delete(target, -1); {
					case err == nil:
						deleted.Add(1)
					case errors.Is(err, zk.ErrNoNode), errors.Is(err, zk.ErrNotEmpty):
						// 已被删除，或期间新增了子节点（下一轮重新遍历）。
					default:
						return zookeeperWriteError(err, target)
					}
					return nil
				})
			}
			if err := group.Wait(); err != nil {
				return deleted.Load(), err
			}
		}
		exists, _, err := z.conn.Exists(path)
		if err != nil {
			return deleted.Load(), zookeeperError(err, path)
		}
		if !exists {
			return deleted.Load(), nil
		}
		if attempt >= 100 {
			return deleted.Load(), zookeeperError(zk.ErrNotEmpty, path)
		}
		if err := zookeeperSleep(ctx, 50*time.Millisecond); err != nil {
			return deleted.Load(), err
		}
	}
}

// zookeeperLevelsDeepestFirst 按路径深度分组，最深的一组在前。
func zookeeperLevelsDeepestFirst(nodes []zookeeperNode) [][]string {
	byDepth := map[int][]string{}
	for _, node := range nodes {
		depth := strings.Count(node.path, "/")
		byDepth[depth] = append(byDepth[depth], node.path)
	}
	depths := make([]int, 0, len(byDepth))
	for depth := range byDepth {
		depths = append(depths, depth)
	}
	sort.Sort(sort.Reverse(sort.IntSlice(depths)))
	levels := make([][]string, 0, len(depths))
	for _, depth := range depths {
		levels = append(levels, byDepth[depth])
	}
	return levels
}

func (z *ZooKeeperDB) ApplyChanges(tableName string, changes connection.ChangeSet) error {
	return z.ApplyChangesContext(context.Background(), tableName, changes)
}

// ApplyChangesContext 把网格的增删改合成 multi 原子提交：删除按深度从深到浅；修改以读取到的 version 为前提；
// 改名是在同一 multi 里新建 + 删除旧节点（只支持没有子节点的持久节点）；新增时自动创建缺失的父节点。
// 不以 / 开头的路径按相对路径处理：新增相对于当前表，改名相对于原节点的父节点。
func (z *ZooKeeperDB) ApplyChangesContext(ctx context.Context, tableName string, changes connection.ChangeSet) error {
	if z.conn == nil {
		return localizedDatabaseRuntimeError("db.backend.error.connection_not_open", nil)
	}
	defer z.cache.clear()
	plan, err := z.changePlan(tableName, changes)
	if err != nil {
		return err
	}
	ops := plan.ops()
	for start := 0; start < len(ops); start += zookeeperMaxMultiOps {
		end := min(start+zookeeperMaxMultiOps, len(ops))
		responses, err := z.conn.Multi(ops[start:end]...)
		if multiErr := zookeeperMultiError(responses, err, ops[start:end]); multiErr != nil {
			return multiErr
		}
	}
	return ctx.Err()
}

func (z *ZooKeeperDB) updateOps(update connection.UpdateRow, pending map[string]bool) ([]interface{}, error) {
	oldPath := normalizeZooKeeperPath(kvText(update.Keys[zookeeperColumnPath]))
	if oldPath == "" {
		return nil, localizedDatabaseRuntimeError("db.backend.error.zookeeper_path_required", nil)
	}
	data, stat, err := z.conn.Get(oldPath)
	if err != nil {
		return nil, zookeeperError(err, oldPath)
	}
	if raw, ok := update.Values[zookeeperColumnData]; ok {
		data = zookeeperDataValue(raw)
	}
	newPath := oldPath
	if raw, ok := update.Values[zookeeperColumnPath]; ok {
		newPath = zookeeperResolvePath(kvText(raw), zookeeperParent(oldPath))
	}
	if newPath == "" {
		return nil, localizedDatabaseRuntimeError("db.backend.error.zookeeper_path_required", nil)
	}
	if newPath == oldPath {
		return []interface{}{&zk.SetDataRequest{Path: oldPath, Data: data, Version: stat.Version}}, nil
	}
	if stat.NumChildren > 0 || stat.EphemeralOwner != 0 {
		return nil, localizedDatabaseRuntimeError("db.backend.error.zookeeper_rename_unsupported", map[string]any{"path": oldPath})
	}
	acl, _, err := z.conn.GetACL(oldPath)
	if err != nil {
		return nil, zookeeperError(err, oldPath)
	}
	ops, err := z.parentOps(newPath, pending)
	if err != nil {
		return nil, err
	}
	pending[newPath] = true
	return append(ops, &zk.CreateRequest{Path: newPath, Data: data, Acl: acl}, &zk.DeleteRequest{Path: oldPath, Version: stat.Version}), nil
}

// parentOps 为缺失的祖先节点生成创建操作（持久节点、空数据），同一批里已安排创建的跳过。
func (z *ZooKeeperDB) parentOps(path string, pending map[string]bool) ([]interface{}, error) {
	var missing []string
	for parent := zookeeperParent(path); parent != "" && parent != "/"; parent = zookeeperParent(parent) {
		if pending[parent] {
			break
		}
		exists, _, err := z.conn.Exists(parent)
		if err != nil {
			return nil, zookeeperError(err, parent)
		}
		if exists {
			break
		}
		missing = append(missing, parent)
	}
	ops := make([]interface{}, 0, len(missing))
	for i := len(missing) - 1; i >= 0; i-- {
		pending[missing[i]] = true
		ops = append(ops, &zk.CreateRequest{Path: missing[i], Acl: z.acl})
	}
	return ops, nil
}

// zookeeperResolvePath 把网格里填写的路径解析为绝对路径：不以 / 开头时拼在 base 下。
func zookeeperResolvePath(text, base string) string {
	text = strings.TrimSpace(text)
	if text == "" {
		return ""
	}
	if !strings.HasPrefix(text, "/") {
		return normalizeZooKeeperPath(joinZooKeeperPath(base, text))
	}
	return normalizeZooKeeperPath(text)
}

// zookeeperDataValue 把网格的值转成节点数据；NULL 写成空数据。
func zookeeperDataValue(raw interface{}) []byte {
	if raw == nil {
		return nil
	}
	return []byte(kvText(raw))
}

// zookeeperMultiError 从 multi 的逐项结果里找出真正失败的操作（其余操作是回滚标记）。
func zookeeperMultiError(responses []zk.MultiResponse, err error, ops []interface{}) error {
	for i, response := range responses {
		if response.Error == nil || strings.Contains(response.Error.Error(), "unknown error: -2") {
			continue
		}
		return zookeeperWriteError(response.Error, zookeeperOpPath(ops[i]))
	}
	if err != nil {
		return zookeeperWriteError(err, "")
	}
	return nil
}

func zookeeperOpPath(op interface{}) string {
	switch typed := op.(type) {
	case *zk.CreateRequest:
		return typed.Path
	case *zk.DeleteRequest:
		return typed.Path
	case *zk.SetDataRequest:
		return typed.Path
	}
	return ""
}

// GetCreateStatement 返回重建该子树的 zkCli 脚本（树序，每个节点一条以分号结尾的 create，最多 500 个节点）。
func (z *ZooKeeperDB) GetCreateStatement(dbName, tableName string) (string, error) {
	if z.conn == nil {
		return "", localizedDatabaseRuntimeError("db.backend.error.connection_not_open", nil)
	}
	ctx, cancel := z.requestContext()
	defer cancel()
	nodes, _, err := z.walk(ctx, normalizeZooKeeperPath(tableName), zookeeperDDLNodeLimit)
	if err != nil {
		return "", err
	}
	sortZooKeeperNodes(nodes, false)
	if nodes, err = z.loadData(ctx, nodes); err != nil {
		return "", err
	}
	acls := make([][]zk.ACL, len(nodes))
	group, groupCtx := errgroup.WithContext(ctx)
	group.SetLimit(zookeeperParallelism)
	for i := range nodes {
		group.Go(func() error {
			if err := groupCtx.Err(); err != nil {
				return err
			}
			acl, _, err := z.conn.GetACL(nodes[i].path)
			if err == nil {
				acls[i] = acl
			}
			return nil
		})
	}
	if err := group.Wait(); err != nil {
		return "", err
	}
	var builder strings.Builder
	for i, node := range nodes {
		if node.restricted {
			continue
		}
		builder.WriteString(zookeeperCreateCommand(node, acls[i]))
		builder.WriteString(";\n")
	}
	return builder.String(), nil
}

// zookeeperCreateCommand 生成重建单个节点的 create 命令：临时节点带 -e，非默认 ACL 写在最后。
// 容器与 TTL 节点在 3.5.3 起的服务端上不可分辨（stat 与持久节点相同），按持久节点重建；没有读权限的节点跳过。
func zookeeperCreateCommand(node zookeeperNode, acl []zk.ACL) string {
	parts := []string{"create"}
	switch zookeeperNodeType(node.stat.EphemeralOwner) {
	case "ephemeral":
		parts = append(parts, "-e")
	case "container":
		parts = append(parts, "-c")
	}
	parts = append(parts, quoteShellArgument(node.path))
	aclText := formatZooKeeperACL(acl)
	if node.data != nil || (aclText != "" && aclText != "world:anyone:cdrwa") {
		parts = append(parts, quoteShellArgument(string(node.data)))
	}
	if aclText != "" && aclText != "world:anyone:cdrwa" {
		parts = append(parts, aclText)
	}
	return strings.Join(parts, " ")
}

// parseZooKeeperACL 解析 zkCli 的 ACL 写法：scheme:id:perms，多个用逗号分隔（id 可含冒号，如 digest:user:hash）。
func parseZooKeeperACL(text string) ([]zk.ACL, error) {
	text = strings.TrimSpace(text)
	if text == "" {
		return nil, nil
	}
	var acls []zk.ACL
	for _, entry := range strings.Split(text, ",") {
		entry = strings.TrimSpace(entry)
		first, last := strings.Index(entry, ":"), strings.LastIndex(entry, ":")
		if first <= 0 || first == last {
			return nil, localizedDatabaseRuntimeError("db.backend.error.zookeeper_acl_invalid", map[string]any{"acl": entry})
		}
		perms, ok := parseZooKeeperPerms(entry[last+1:])
		if !ok {
			return nil, localizedDatabaseRuntimeError("db.backend.error.zookeeper_acl_invalid", map[string]any{"acl": entry})
		}
		acls = append(acls, zk.ACL{Scheme: entry[:first], ID: entry[first+1 : last], Perms: perms})
	}
	return acls, nil
}

var zookeeperPermLetters = []struct {
	letter byte
	perm   int32
}{{'c', zk.PermCreate}, {'d', zk.PermDelete}, {'r', zk.PermRead}, {'w', zk.PermWrite}, {'a', zk.PermAdmin}}

func parseZooKeeperPerms(text string) (int32, bool) {
	var perms int32
	for i := 0; i < len(text); i++ {
		found := false
		for _, item := range zookeeperPermLetters {
			if text[i]|0x20 == item.letter {
				perms, found = perms|item.perm, true
			}
		}
		if !found {
			return 0, false
		}
	}
	return perms, text != ""
}

// formatZooKeeperPerms 按 zkCli 的顺序（cdrwa）输出权限字母。
func formatZooKeeperPerms(perms int32) string {
	var builder strings.Builder
	for _, item := range zookeeperPermLetters {
		if perms&item.perm != 0 {
			builder.WriteByte(item.letter)
		}
	}
	return builder.String()
}

func formatZooKeeperACL(acls []zk.ACL) string {
	parts := make([]string, 0, len(acls))
	for _, acl := range acls {
		parts = append(parts, fmt.Sprintf("%s:%s:%s", acl.Scheme, acl.ID, formatZooKeeperPerms(acl.Perms)))
	}
	return strings.Join(parts, ",")
}
