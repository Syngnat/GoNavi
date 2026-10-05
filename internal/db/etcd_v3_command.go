//go:build gonavi_full_drivers || gonavi_etcd_driver

package db

import (
	"context"
	"strconv"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"

	clientv3 "go.etcd.io/etcd/client/v3"
)

// etcdMaxTxnOps 是单个事务里的操作上限（etcd 的 --max-txn-ops 默认 128）；网格一次提交超出时拆成多个事务。
const etcdMaxTxnOps = 128

var etcdSortTargets = map[string]clientv3.SortTarget{
	"KEY": clientv3.SortByKey, "VERSION": clientv3.SortByVersion, "CREATE": clientv3.SortByCreateRevision,
	"MODIFY": clientv3.SortByModRevision, "VALUE": clientv3.SortByValue,
}

// v3Command 执行 etcdctl 风格的控制台命令，结果整理成表格。
func (e *EtcdDB) v3Command(ctx context.Context, command etcdCommand) ([]map[string]interface{}, []string, error) {
	switch command.name {
	case "get":
		return e.v3Get(ctx, command)
	case "put":
		if len(command.args) != 2 {
			return nil, nil, etcdUsageError("put <key> <value> [--lease=<id>] [--prev-kv]")
		}
		options := []clientv3.OpOption{}
		if lease, ok := command.flag("lease"); ok {
			id, err := parseEtcdLease(lease)
			if err != nil {
				return nil, nil, err
			}
			options = append(options, clientv3.WithLease(clientv3.LeaseID(id)))
		}
		if command.boolFlag("prev-kv") {
			options = append(options, clientv3.WithPrevKV())
		}
		resp, err := e.v3.Put(ctx, command.args[0], command.args[1], options...)
		if err != nil {
			return nil, nil, err
		}
		row := map[string]interface{}{"key": command.args[0], "revision": resp.Header.Revision, "prev_value": nil}
		if resp.PrevKv != nil {
			row["prev_value"] = normalizeQueryValueWithDBType(resp.PrevKv.Value, "")
		}
		return []map[string]interface{}{row}, []string{"key", "revision", "prev_value"}, nil
	case "del", "delete", "rm":
		return e.v3Delete(ctx, command)
	case "watch":
		return e.v3Watch(ctx, command)
	case "lease":
		return e.v3Lease(ctx, command)
	case "member":
		return e.v3Members(ctx, command)
	case "endpoint":
		return e.v3Endpoints(ctx, command)
	case "alarm":
		if command.subcommand() != "list" {
			return nil, nil, etcdUsageError("alarm list")
		}
		resp, err := e.v3.AlarmList(ctx)
		if err != nil {
			return nil, nil, err
		}
		rows := make([]map[string]interface{}, 0, len(resp.Alarms))
		for _, alarm := range resp.Alarms {
			rows = append(rows, map[string]interface{}{"member_id": strconv.FormatUint(alarm.MemberID, 16), "alarm": alarm.Alarm.String()})
		}
		return rows, []string{"member_id", "alarm"}, nil
	case "user", "role":
		return e.v3Auth(ctx, command)
	case "compaction", "compact":
		if len(command.args) != 1 {
			return nil, nil, etcdUsageError("compaction <revision> [--physical]")
		}
		revision, err := strconv.ParseInt(command.args[0], 10, 64)
		if err != nil {
			return nil, nil, etcdFlagError("revision", command.args[0])
		}
		options := []clientv3.CompactOption{}
		if command.boolFlag("physical") {
			options = append(options, clientv3.WithCompactPhysical())
		}
		resp, err := e.v3.Compact(ctx, revision, options...)
		if err != nil {
			return nil, nil, err
		}
		return []map[string]interface{}{{"compacted_revision": revision, "revision": resp.Header.Revision}}, []string{"compacted_revision", "revision"}, nil
	case "version":
		resp, err := e.v3.Status(ctx, e.endpoints[0])
		if err != nil {
			return nil, nil, err
		}
		return []map[string]interface{}{{"version": resp.Version}}, []string{"version"}, nil
	}
	return nil, nil, localizedDatabaseRuntimeError("db.backend.error.etcd_command_unknown", map[string]any{"command": command.name})
}

// v3RangeOptions 把 get / del 的范围选项（第二个位置参数、--prefix、--from-key）转成 clientv3 选项。
func v3RangeOptions(command etcdCommand) []clientv3.OpOption {
	var options []clientv3.OpOption
	switch {
	case command.boolFlag("prefix"):
		options = append(options, clientv3.WithPrefix())
	case command.boolFlag("from-key"):
		options = append(options, clientv3.WithFromKey())
	case len(command.args) > 1:
		options = append(options, clientv3.WithRange(command.args[1]))
	}
	return options
}

func (e *EtcdDB) v3Get(ctx context.Context, command etcdCommand) ([]map[string]interface{}, []string, error) {
	if len(command.args) == 0 {
		return nil, nil, etcdUsageError("get <key> [<range_end>] [--prefix] [--from-key] [--limit=N] [--rev=N] [--keys-only] [--count-only] [--sort-by=KEY|VERSION|CREATE|MODIFY|VALUE] [--order=ASCEND|DESCEND]")
	}
	options := v3RangeOptions(command)
	if limit, ok := command.flag("limit"); ok {
		value, err := strconv.ParseInt(limit, 10, 64)
		if err != nil || value < 0 {
			return nil, nil, etcdFlagError("limit", limit)
		}
		options = append(options, clientv3.WithLimit(value))
	}
	if rev, ok := command.flag("rev"); ok {
		value, err := strconv.ParseInt(rev, 10, 64)
		if err != nil || value < 0 {
			return nil, nil, etcdFlagError("rev", rev)
		}
		options = append(options, clientv3.WithRev(value))
	}
	sortBy, hasSort := command.flag("sort-by")
	order, hasOrder := command.flag("order")
	if hasSort || hasOrder {
		target, ok := etcdSortTargets[strings.ToUpper(sortBy)]
		if !hasSort {
			target, ok = clientv3.SortByKey, true
		}
		if !ok {
			return nil, nil, etcdFlagError("sort-by", sortBy)
		}
		direction := clientv3.SortAscend
		if strings.EqualFold(order, "DESCEND") {
			direction = clientv3.SortDescend
		} else if hasOrder && !strings.EqualFold(order, "ASCEND") {
			return nil, nil, etcdFlagError("order", order)
		}
		options = append(options, clientv3.WithSort(target, direction))
	}
	if command.boolFlag("count-only") {
		resp, err := e.v3.Get(ctx, command.args[0], append(options, clientv3.WithCountOnly())...)
		if err != nil {
			return nil, nil, err
		}
		return []map[string]interface{}{{"count": resp.Count, "revision": resp.Header.Revision}}, []string{"count", "revision"}, nil
	}
	keysOnly := command.boolFlag("keys-only")
	if keysOnly {
		options = append(options, clientv3.WithKeysOnly())
	}
	resp, err := e.v3.Get(ctx, command.args[0], options...)
	if err != nil {
		return nil, nil, err
	}
	rows := make([]etcdKeyValue, 0, len(resp.Kvs))
	for _, kv := range resp.Kvs {
		rows = append(rows, etcdKeyValue{key: string(kv.Key), value: kv.Value, createRevision: kv.CreateRevision, modRevision: kv.ModRevision, version: kv.Version, lease: kv.Lease})
	}
	e.v3TTLs(ctx, rows)
	columns := etcdColumns
	if keysOnly {
		columns = []string{etcdColumnKey, etcdColumnCreateRevision, etcdColumnModRevision, etcdColumnVersion, etcdColumnLease}
	}
	result := make([]map[string]interface{}, 0, len(rows))
	for _, row := range rows {
		result = append(result, etcdRowMap(row, columns))
	}
	return result, columns, nil
}

func (e *EtcdDB) v3Delete(ctx context.Context, command etcdCommand) ([]map[string]interface{}, []string, error) {
	if len(command.args) == 0 {
		return nil, nil, etcdUsageError("del <key> [<range_end>] [--prefix] [--from-key] [--prev-kv]")
	}
	options := v3RangeOptions(command)
	if command.boolFlag("prev-kv") {
		options = append(options, clientv3.WithPrevKV())
	}
	resp, err := e.v3.Delete(ctx, command.args[0], options...)
	if err != nil {
		return nil, nil, err
	}
	if !command.boolFlag("prev-kv") {
		return []map[string]interface{}{{"deleted": resp.Deleted, "revision": resp.Header.Revision}}, []string{"deleted", "revision"}, nil
	}
	rows := make([]map[string]interface{}, 0, len(resp.PrevKvs))
	for _, kv := range resp.PrevKvs {
		rows = append(rows, etcdRowMap(etcdKeyValue{key: string(kv.Key), value: kv.Value, createRevision: kv.CreateRevision, modRevision: kv.ModRevision, version: kv.Version, lease: kv.Lease}, etcdColumns))
	}
	return rows, etcdColumns, nil
}

func (e *EtcdDB) v3Lease(ctx context.Context, command etcdCommand) ([]map[string]interface{}, []string, error) {
	leaseArg := func() (clientv3.LeaseID, error) {
		if len(command.args) < 2 {
			return 0, etcdUsageError("lease " + command.subcommand() + " <id>")
		}
		id, err := parseEtcdLease(command.args[1])
		return clientv3.LeaseID(id), err
	}
	switch command.subcommand() {
	case "grant":
		if len(command.args) != 2 {
			return nil, nil, etcdUsageError("lease grant <ttl-seconds>")
		}
		ttl, err := strconv.ParseInt(command.args[1], 10, 64)
		if err != nil || ttl <= 0 {
			return nil, nil, etcdFlagError("ttl", command.args[1])
		}
		resp, err := e.v3.Grant(ctx, ttl)
		if err != nil {
			return nil, nil, err
		}
		return []map[string]interface{}{{"lease": formatEtcdLease(int64(resp.ID)), "ttl": resp.TTL}}, []string{"lease", "ttl"}, nil
	case "revoke":
		id, err := leaseArg()
		if err != nil {
			return nil, nil, err
		}
		if _, err := e.v3.Revoke(ctx, id); err != nil {
			return nil, nil, err
		}
		return []map[string]interface{}{{"lease": formatEtcdLease(int64(id)), "revoked": true}}, []string{"lease", "revoked"}, nil
	case "timetolive":
		id, err := leaseArg()
		if err != nil {
			return nil, nil, err
		}
		options := []clientv3.LeaseOption{}
		if command.boolFlag("keys") {
			options = append(options, clientv3.WithAttachedKeys())
		}
		resp, err := e.v3.TimeToLive(ctx, id, options...)
		if err != nil {
			return nil, nil, err
		}
		keys := make([]string, 0, len(resp.Keys))
		for _, key := range resp.Keys {
			keys = append(keys, string(key))
		}
		row := map[string]interface{}{"lease": formatEtcdLease(int64(id)), "ttl": resp.TTL, "granted_ttl": resp.GrantedTTL, "keys": strings.Join(keys, "\n")}
		return []map[string]interface{}{row}, []string{"lease", "ttl", "granted_ttl", "keys"}, nil
	case "keep-alive", "keepalive":
		id, err := leaseArg()
		if err != nil {
			return nil, nil, err
		}
		resp, err := e.v3.KeepAliveOnce(ctx, id)
		if err != nil {
			return nil, nil, err
		}
		return []map[string]interface{}{{"lease": formatEtcdLease(int64(id)), "ttl": resp.TTL}}, []string{"lease", "ttl"}, nil
	case "list":
		// LeaseLeases 从 etcd 3.3 起才有。
		if !e.atLeast("3.3") {
			return nil, nil, localizedDatabaseRuntimeError("db.backend.error.etcd_lease_list_unsupported", map[string]any{"version": e.serverVersion})
		}
		resp, err := e.v3.Leases(ctx)
		if err != nil {
			return nil, nil, err
		}
		rows := make([]map[string]interface{}, 0, len(resp.Leases))
		for _, lease := range resp.Leases {
			row := map[string]interface{}{"lease": formatEtcdLease(int64(lease.ID)), "ttl": nil}
			if ttl, err := e.v3.TimeToLive(ctx, lease.ID); err == nil {
				row["ttl"] = ttl.TTL
			}
			rows = append(rows, row)
		}
		return rows, []string{"lease", "ttl"}, nil
	}
	return nil, nil, etcdUsageError("lease grant|revoke|timetolive|keep-alive|list")
}

func (e *EtcdDB) v3Members(ctx context.Context, command etcdCommand) ([]map[string]interface{}, []string, error) {
	if command.subcommand() != "list" {
		return nil, nil, etcdUsageError("member list")
	}
	resp, err := e.v3.MemberList(ctx)
	if err != nil {
		return nil, nil, err
	}
	rows := make([]map[string]interface{}, 0, len(resp.Members))
	for _, member := range resp.Members {
		rows = append(rows, map[string]interface{}{
			"id": strconv.FormatUint(member.ID, 16), "name": member.Name, "peer_urls": strings.Join(member.PeerURLs, ","),
			"client_urls": strings.Join(member.ClientURLs, ","), "is_learner": member.IsLearner,
		})
	}
	return rows, []string{"id", "name", "peer_urls", "client_urls", "is_learner"}, nil
}

func (e *EtcdDB) v3Endpoints(ctx context.Context, command etcdCommand) ([]map[string]interface{}, []string, error) {
	switch command.subcommand() {
	case "status":
		rows := make([]map[string]interface{}, 0, len(e.endpoints))
		for _, endpoint := range e.endpoints {
			resp, err := e.v3.Status(ctx, endpoint)
			if err != nil {
				rows = append(rows, map[string]interface{}{"endpoint": endpoint, "error": err.Error()})
				continue
			}
			rows = append(rows, map[string]interface{}{
				"endpoint": endpoint, "id": strconv.FormatUint(resp.Header.MemberId, 16), "version": resp.Version,
				"db_size": resp.DbSize, "is_leader": resp.Header.MemberId == resp.Leader, "raft_term": resp.RaftTerm,
				"raft_index": resp.RaftIndex, "errors": strings.Join(resp.Errors, "; "), "error": nil,
			})
		}
		return rows, []string{"endpoint", "id", "version", "db_size", "is_leader", "raft_term", "raft_index", "errors", "error"}, nil
	case "health":
		rows := make([]map[string]interface{}, 0, len(e.endpoints))
		for _, endpoint := range e.endpoints {
			started := time.Now()
			_, err := e.v3.Get(ctx, "health", clientv3.WithSerializable())
			row := map[string]interface{}{"endpoint": endpoint, "healthy": err == nil, "took_ms": time.Since(started).Milliseconds(), "error": nil}
			if err != nil {
				row["error"] = err.Error()
			}
			rows = append(rows, row)
		}
		return rows, []string{"endpoint", "healthy", "took_ms", "error"}, nil
	}
	return nil, nil, etcdUsageError("endpoint status|health")
}

func (e *EtcdDB) v3Auth(ctx context.Context, command etcdCommand) ([]map[string]interface{}, []string, error) {
	switch command.name + " " + command.subcommand() {
	case "user list":
		resp, err := e.v3.UserList(ctx)
		if err != nil {
			return nil, nil, err
		}
		rows := make([]map[string]interface{}, 0, len(resp.Users))
		for _, user := range resp.Users {
			rows = append(rows, map[string]interface{}{"user": user})
		}
		return rows, []string{"user"}, nil
	case "role list":
		resp, err := e.v3.RoleList(ctx)
		if err != nil {
			return nil, nil, err
		}
		rows := make([]map[string]interface{}, 0, len(resp.Roles))
		for _, role := range resp.Roles {
			rows = append(rows, map[string]interface{}{"role": role})
		}
		return rows, []string{"role"}, nil
	case "user get":
		if len(command.args) < 2 {
			return nil, nil, etcdUsageError("user get <name>")
		}
		resp, err := e.v3.UserGet(ctx, command.args[1])
		if err != nil {
			return nil, nil, err
		}
		return []map[string]interface{}{{"user": command.args[1], "roles": strings.Join(resp.Roles, ",")}}, []string{"user", "roles"}, nil
	case "role get":
		if len(command.args) < 2 {
			return nil, nil, etcdUsageError("role get <name>")
		}
		resp, err := e.v3.RoleGet(ctx, command.args[1])
		if err != nil {
			return nil, nil, err
		}
		rows := make([]map[string]interface{}, 0, len(resp.Perm))
		for _, perm := range resp.Perm {
			rows = append(rows, map[string]interface{}{"role": command.args[1], "permission": perm.PermType.String(), "key": string(perm.Key), "range_end": string(perm.RangeEnd)})
		}
		return rows, []string{"role", "permission", "key", "range_end"}, nil
	}
	return nil, nil, etcdUsageError("user list | user get <name> | role list | role get <name>")
}

// v3ApplyChanges 把网格的增删改合成事务：新增要求键不存在，修改 / 改名以读到的 mod_revision 为前提，
// 都满足才整体提交；超过 etcdMaxTxnOps 时分批提交。
func (e *EtcdDB) v3ApplyChanges(ctx context.Context, changes connection.ChangeSet) error {
	var conditions []clientv3.Cmp
	var operations []clientv3.Op
	flush := func() error {
		if len(operations) == 0 {
			return nil
		}
		resp, err := e.v3.Txn(ctx).If(conditions...).Then(operations...).Commit()
		if err != nil {
			return MarkWriteOutcomeUnknown(err)
		}
		if !resp.Succeeded {
			return localizedDatabaseRuntimeError("db.backend.error.etcd_change_conflict", nil)
		}
		conditions, operations = nil, nil
		return nil
	}
	add := func(cmp []clientv3.Cmp, ops ...clientv3.Op) error {
		if len(operations)+len(ops) > etcdMaxTxnOps {
			if err := flush(); err != nil {
				return err
			}
		}
		conditions = append(conditions, cmp...)
		operations = append(operations, ops...)
		return nil
	}
	for _, row := range changes.Deletes {
		key := kvText(row[etcdColumnKey])
		if key == "" {
			return localizedDatabaseRuntimeError("db.backend.error.etcd_key_required", nil)
		}
		if err := add(nil, clientv3.OpDelete(key)); err != nil {
			return err
		}
	}
	for _, update := range changes.Updates {
		oldKey := kvText(update.Keys[etcdColumnKey])
		current, err := e.v3.Get(ctx, oldKey)
		if err != nil {
			return err
		}
		if len(current.Kvs) == 0 {
			return localizedDatabaseRuntimeError("db.backend.error.etcd_change_conflict", nil)
		}
		kv := current.Kvs[0]
		put, newKey, err := e.v3PutOp(ctx, update.Values, oldKey, string(kv.Value), kv.Lease)
		if err != nil {
			return err
		}
		ops := []clientv3.Op{put}
		if newKey != oldKey {
			ops = append(ops, clientv3.OpDelete(oldKey))
		}
		if err := add([]clientv3.Cmp{clientv3.Compare(clientv3.ModRevision(oldKey), "=", kv.ModRevision)}, ops...); err != nil {
			return err
		}
	}
	for _, row := range changes.Inserts {
		put, key, err := e.v3PutOp(ctx, row, "", "", 0)
		if err != nil {
			return err
		}
		if err := add([]clientv3.Cmp{clientv3.Compare(clientv3.CreateRevision(key), "=", 0)}, put); err != nil {
			return err
		}
	}
	return flush()
}

// v3PutOp 根据网格的列值生成 put：value / lease / ttl 缺省时沿用原值；填写 ttl（秒）会授予新租约。
func (e *EtcdDB) v3PutOp(ctx context.Context, values map[string]interface{}, key, value string, lease int64) (clientv3.Op, string, error) {
	if raw, ok := values[etcdColumnKey]; ok {
		key = kvText(raw)
	}
	if strings.TrimSpace(key) == "" {
		return clientv3.Op{}, "", localizedDatabaseRuntimeError("db.backend.error.etcd_key_required", nil)
	}
	if raw, ok := values[etcdColumnValue]; ok {
		value = kvText(raw)
	}
	if raw, ok := values[etcdColumnLease]; ok {
		parsed, err := parseEtcdLease(raw)
		if err != nil {
			return clientv3.Op{}, "", err
		}
		lease = parsed
	}
	if raw, ok := values[etcdColumnTTL]; ok && strings.TrimSpace(kvText(raw)) != "" {
		ttl, err := strconv.ParseInt(strings.TrimSpace(kvText(raw)), 10, 64)
		if err != nil || ttl < 0 {
			return clientv3.Op{}, "", etcdFlagError(etcdColumnTTL, kvText(raw))
		}
		lease = 0
		if ttl > 0 {
			granted, err := e.v3.Grant(ctx, ttl)
			if err != nil {
				return clientv3.Op{}, "", err
			}
			lease = int64(granted.ID)
		}
	}
	if lease != 0 {
		return clientv3.OpPut(key, value, clientv3.WithLease(clientv3.LeaseID(lease))), key, nil
	}
	return clientv3.OpPut(key, value), key, nil
}
