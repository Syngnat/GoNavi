//go:build gonavi_full_drivers || gonavi_etcd_driver

package db

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
)

var _ ChangePreviewer = (*EtcdDB)(nil)

// PreviewChanges 按 ApplyChanges 的做法列出控制台命令（每行一组）：v3 是 put / del（改键名时写新键再删旧键，
// 填写 ttl 会先授予新租约），v2 是 set / rm。只读取当前值，不授予租约、不写入。
func (e *EtcdDB) PreviewChanges(_ string, changes connection.ChangeSet) (deletes, updates, inserts []string) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	deleteCommand := "del "
	if e.v3 == nil {
		deleteCommand = "rm "
	}
	for _, row := range changes.Deletes {
		key := kvText(row[etcdColumnKey])
		if key == "" {
			deletes = append(deletes, "# "+localizedDriverRuntimeText("db.backend.error.etcd_key_required", nil))
			continue
		}
		deletes = append(deletes, deleteCommand+quoteShellArgument(key))
	}
	for _, update := range changes.Updates {
		oldKey := kvText(update.Keys[etcdColumnKey])
		value, lease, ttl, err := e.previewCurrent(ctx, oldKey)
		if err != nil {
			updates = append(updates, "# "+err.Error())
			continue
		}
		command, newKey, err := e.previewPut(update.Values, oldKey, value, lease, ttl)
		if err != nil {
			updates = append(updates, "# "+err.Error())
			continue
		}
		if newKey != oldKey {
			command += "\n" + deleteCommand + quoteShellArgument(oldKey)
		}
		updates = append(updates, command)
	}
	for _, row := range changes.Inserts {
		command, _, err := e.previewPut(row, "", "", 0, 0)
		if err != nil {
			inserts = append(inserts, "# "+err.Error())
			continue
		}
		inserts = append(inserts, command)
	}
	return deletes, updates, inserts
}

// previewCurrent 读取键的当前值、租约（v3）与剩余 TTL（v2）。
func (e *EtcdDB) previewCurrent(ctx context.Context, key string) (string, int64, int64, error) {
	switch {
	case e.v3 != nil:
		current, err := e.v3.Get(ctx, key)
		if err != nil {
			return "", 0, 0, err
		}
		if len(current.Kvs) == 0 {
			return "", 0, 0, localizedDatabaseRuntimeError("db.backend.error.etcd_change_conflict", nil)
		}
		return string(current.Kvs[0].Value), current.Kvs[0].Lease, 0, nil
	case e.v2 != nil:
		node, err := e.v2.get(ctx, key, false)
		if err != nil {
			return "", 0, 0, err
		}
		return node.Value, 0, node.TTL, nil
	}
	return "", 0, 0, localizedDatabaseRuntimeError("db.backend.error.connection_not_open", nil)
}

// previewPut 生成与提交时等价的写入命令：v3 的 ttl 会先授予新租约，预览里写成 lease grant 加占位的租约 ID。
func (e *EtcdDB) previewPut(values map[string]interface{}, key, value string, lease, ttl int64) (string, string, error) {
	if e.v3 == nil {
		form, newKey, err := etcdV2Form(values, key, value, ttl)
		if err != nil {
			return "", "", err
		}
		command := "set " + quoteShellArgument(newKey) + " " + quoteShellArgument(form.Get("value"))
		if ttlText := form.Get("ttl"); ttlText != "" {
			command += " --ttl=" + ttlText
		}
		return command, newKey, nil
	}
	if raw, ok := values[etcdColumnKey]; ok {
		key = kvText(raw)
	}
	if strings.TrimSpace(key) == "" {
		return "", "", localizedDatabaseRuntimeError("db.backend.error.etcd_key_required", nil)
	}
	if raw, ok := values[etcdColumnValue]; ok {
		value = kvText(raw)
	}
	if raw, ok := values[etcdColumnLease]; ok {
		parsed, err := parseEtcdLease(raw)
		if err != nil {
			return "", "", err
		}
		lease = parsed
	}
	command := "put " + quoteShellArgument(key) + " " + quoteShellArgument(value)
	if raw, ok := values[etcdColumnTTL]; ok && strings.TrimSpace(kvText(raw)) != "" {
		ttl, err := strconv.ParseInt(strings.TrimSpace(kvText(raw)), 10, 64)
		if err != nil || ttl < 0 {
			return "", "", etcdFlagError(etcdColumnTTL, kvText(raw))
		}
		if ttl > 0 {
			return fmt.Sprintf("lease grant %d\n%s --lease=<lease-id>", ttl, command), key, nil
		}
		return command, key, nil
	}
	if lease != 0 {
		command += fmt.Sprintf(" --lease=%x", lease)
	}
	return command, key, nil
}
