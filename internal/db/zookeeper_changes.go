//go:build gonavi_full_drivers || gonavi_zookeeper_driver

package db

import (
	"fmt"
	"sort"
	"strings"

	"GoNavi-Wails/internal/connection"
	"github.com/go-zookeeper/zk"
)

// zookeeperChangePlan 是网格改动对应的 multi 操作，按删除、修改、新增分组，每行一组（修改与新增可能带出改名删除、
// 父节点创建等多个操作）。提交与预览共用同一份计划。
type zookeeperChangePlan struct {
	deletes [][]interface{}
	updates [][]interface{}
	inserts [][]interface{}
}

// ops 按提交顺序展开全部操作：删除（从深到浅）、修改、新增。
func (p zookeeperChangePlan) ops() []interface{} {
	var ops []interface{}
	for _, group := range [][][]interface{}{p.deletes, p.updates, p.inserts} {
		for _, rowOps := range group {
			ops = append(ops, rowOps...)
		}
	}
	return ops
}

// changePlan 生成改动计划：删除按深度从深到浅；修改以读取到的 version 为前提；改名是新建 + 删除旧节点
// （只支持没有子节点的持久节点）；新增时自动创建缺失的父节点。不以 / 开头的路径按相对路径处理：
// 新增相对于当前表，改名相对于原节点的父节点。
func (z *ZooKeeperDB) changePlan(tableName string, changes connection.ChangeSet) (zookeeperChangePlan, error) {
	var plan zookeeperChangePlan
	table := normalizeZooKeeperPath(tableName)
	if table == "" {
		table = z.scope
	}
	deletes := make([]string, 0, len(changes.Deletes))
	for _, row := range changes.Deletes {
		path := normalizeZooKeeperPath(kvText(row[zookeeperColumnPath]))
		if path == "" {
			return plan, localizedDatabaseRuntimeError("db.backend.error.zookeeper_path_required", nil)
		}
		deletes = append(deletes, path)
	}
	sort.SliceStable(deletes, func(i, j int) bool { return strings.Count(deletes[i], "/") > strings.Count(deletes[j], "/") })
	for _, path := range deletes {
		plan.deletes = append(plan.deletes, []interface{}{&zk.DeleteRequest{Path: path, Version: -1}})
	}
	pending := map[string]bool{}
	for _, update := range changes.Updates {
		updateOps, err := z.updateOps(update, pending)
		if err != nil {
			return plan, err
		}
		plan.updates = append(plan.updates, updateOps)
	}
	for _, row := range changes.Inserts {
		path := zookeeperResolvePath(kvText(row[zookeeperColumnPath]), table)
		if path == "" {
			return plan, localizedDatabaseRuntimeError("db.backend.error.zookeeper_path_required", nil)
		}
		parents, err := z.parentOps(path, pending)
		if err != nil {
			return plan, err
		}
		plan.inserts = append(plan.inserts, append(parents, &zk.CreateRequest{Path: path, Data: zookeeperDataValue(row[zookeeperColumnData]), Acl: z.acl}))
		pending[path] = true
	}
	return plan, nil
}

var _ ChangePreviewer = (*ZooKeeperDB)(nil)

// PreviewChanges 列出提交时 multi 里的操作，写成控制台可执行的 zkCli 命令（每行一组）。计划生成失败时给出原因。
func (z *ZooKeeperDB) PreviewChanges(tableName string, changes connection.ChangeSet) (deletes, updates, inserts []string) {
	if z.conn == nil {
		return []string{"# " + localizedDriverRuntimeText("db.backend.error.connection_not_open", nil)}, nil, nil
	}
	plan, err := z.changePlan(tableName, changes)
	if err != nil {
		return []string{"# " + err.Error()}, nil, nil
	}
	format := func(groups [][]interface{}) []string {
		lines := make([]string, 0, len(groups))
		for _, group := range groups {
			commands := make([]string, 0, len(group))
			for _, op := range group {
				commands = append(commands, zookeeperOpCommand(op))
			}
			lines = append(lines, strings.Join(commands, "\n"))
		}
		return lines
	}
	return format(plan.deletes), format(plan.updates), format(plan.inserts)
}

// zookeeperOpCommand 把 multi 操作写成 zkCli 命令：带 version 前提时写 -v。
func zookeeperOpCommand(op interface{}) string {
	switch typed := op.(type) {
	case *zk.DeleteRequest:
		if typed.Version >= 0 {
			return fmt.Sprintf("delete -v %d %s", typed.Version, quoteShellArgument(typed.Path))
		}
		return "delete " + quoteShellArgument(typed.Path)
	case *zk.SetDataRequest:
		return fmt.Sprintf("set -v %d %s %s", typed.Version, quoteShellArgument(typed.Path), quoteShellArgument(string(typed.Data)))
	case *zk.CreateRequest:
		parts := []string{"create", quoteShellArgument(typed.Path)}
		aclText := formatZooKeeperACL(typed.Acl)
		custom := aclText != "" && aclText != "world:anyone:cdrwa"
		if typed.Data != nil || custom {
			parts = append(parts, quoteShellArgument(string(typed.Data)))
		}
		if custom {
			parts = append(parts, aclText)
		}
		return strings.Join(parts, " ")
	}
	return fmt.Sprint(op)
}
