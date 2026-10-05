//go:build gonavi_full_drivers || gonavi_etcd_driver

package db

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"

	"GoNavi-Wails/internal/connection"
)

// etcd v2 API：HTTP /v2/keys，有真正的目录。etcd 2.x 只有它；3.0–3.5 开启 --enable-v2 后也提供，
// 但 v2 与 v3 是两套独立的键空间（v3 读不到 v2 写入的键），所以 3.x 上浏览旧数据要手动选 v2 档位。

type etcdV2Client struct {
	http      *http.Client
	scheme    string
	endpoints []string
	user      string
	password  string
}

type etcdV2Node struct {
	Key           string        `json:"key"`
	Value         string        `json:"value"`
	Dir           bool          `json:"dir"`
	TTL           int64         `json:"ttl"`
	Expiration    string        `json:"expiration"`
	CreatedIndex  int64         `json:"createdIndex"`
	ModifiedIndex int64         `json:"modifiedIndex"`
	Nodes         []*etcdV2Node `json:"nodes"`
}

type etcdV2Response struct {
	Action    string      `json:"action"`
	Node      *etcdV2Node `json:"node"`
	PrevNode  *etcdV2Node `json:"prevNode"`
	ErrorCode int         `json:"errorCode"`
	Message   string      `json:"message"`
	Cause     string      `json:"cause"`
}

// etcdV2Error 是服务端返回的 v2 错误（键不存在、比较失败、不是目录等）。
type etcdV2Error struct {
	code    int
	message string
}

func (e *etcdV2Error) Error() string { return e.message }

// do 依次尝试各个端点，返回第一个可达端点的响应。
func (c *etcdV2Client) do(ctx context.Context, method, key string, query url.Values, form url.Values) (*etcdV2Response, error) {
	var lastErr error
	for _, endpoint := range c.endpoints {
		target := c.scheme + "://" + endpoint + "/v2/keys" + etcdV2Path(key)
		if len(query) > 0 {
			target += "?" + query.Encode()
		}
		var body io.Reader
		if form != nil {
			body = strings.NewReader(form.Encode())
		}
		req, err := http.NewRequestWithContext(ctx, method, target, body)
		if err != nil {
			return nil, err
		}
		if form != nil {
			req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		}
		if c.user != "" {
			req.SetBasicAuth(c.user, c.password)
		}
		res, err := c.http.Do(req)
		if err != nil {
			lastErr = err
			continue
		}
		payload, err := readLimitedJSONResponseBody(res.Body)
		_ = res.Body.Close()
		if err != nil {
			return nil, err
		}
		var result etcdV2Response
		if decodeErr := json.Unmarshal(payload, &result); decodeErr != nil {
			return nil, localizedDatabaseRuntimeError("db.backend.error.etcd_v2_request_failed", map[string]any{"status": res.StatusCode, "detail": strings.TrimSpace(string(payload))})
		}
		if result.ErrorCode != 0 || res.StatusCode >= 400 {
			message := strings.TrimSpace(result.Message + " " + result.Cause)
			return nil, &etcdV2Error{code: result.ErrorCode, message: localizedDriverRuntimeText("db.backend.error.etcd_v2_request_failed", map[string]any{"status": res.StatusCode, "detail": message})}
		}
		return &result, nil
	}
	return nil, lastErr
}

func (c *etcdV2Client) get(ctx context.Context, key string, recursive bool) (*etcdV2Node, error) {
	query := url.Values{"sorted": {"true"}}
	if recursive {
		query.Set("recursive", "true")
	}
	resp, err := c.do(ctx, http.MethodGet, key, query, nil)
	if err != nil {
		return nil, err
	}
	return resp.Node, nil
}

// children 列出目录（prefix 去掉末尾的 /）下一层的完整路径。
func (c *etcdV2Client) children(ctx context.Context, prefix string) ([]string, error) {
	dir := strings.TrimSuffix(prefix, "/")
	if dir == "" {
		dir = "/"
	}
	node, err := c.get(ctx, dir, false)
	if err != nil {
		var v2Err *etcdV2Error
		if asEtcdV2Error(err, &v2Err) && v2Err.code == 100 {
			return []string{}, nil
		}
		return nil, err
	}
	names := make([]string, 0, len(node.Nodes))
	for _, child := range node.Nodes {
		names = append(names, child.Key)
	}
	sort.Strings(names)
	return names, nil
}

func asEtcdV2Error(err error, target **etcdV2Error) bool {
	typed, ok := err.(*etcdV2Error)
	if ok {
		*target = typed
	}
	return ok
}

// leaves 把节点树展开成叶子键（目录本身不算行）。
func flattenEtcdV2(node *etcdV2Node, rows []etcdKeyValue) []etcdKeyValue {
	if node == nil {
		return rows
	}
	if !node.Dir {
		return append(rows, etcdKeyValue{key: node.Key, value: []byte(node.Value), createRevision: node.CreatedIndex, modRevision: node.ModifiedIndex, ttl: node.TTL})
	}
	for _, child := range node.Nodes {
		rows = flattenEtcdV2(child, rows)
	}
	return rows
}

// selectRows 在客户端完成过滤、排序与分页：v2 没有范围分页，一次递归读出表路径下的全部键。
func (c *etcdV2Client) selectRows(ctx context.Context, query etcdSelect, delimiter string) ([]etcdKeyValue, int64, error) {
	node, err := c.get(ctx, query.table, true)
	if err != nil {
		var v2Err *etcdV2Error
		if asEtcdV2Error(err, &v2Err) && v2Err.code == 100 {
			return []etcdKeyValue{}, 0, nil
		}
		return nil, 0, err
	}
	all := flattenEtcdV2(node, nil)
	matched := make([]etcdKeyValue, 0, len(all))
	for _, row := range all {
		if etcdKeyInRanges(row.key, query.keyRanges) && matchEtcdWhere(query.where, row) {
			matched = append(matched, row)
		}
	}
	if query.count {
		return nil, int64(len(matched)), nil
	}
	column := query.orderBy
	if column == "" {
		column = etcdColumnKey
	}
	sortEtcdRows(matched, column, query.desc)
	return sliceEtcdPage(matched, query.offset, query.limit), int64(len(matched)), nil
}

func etcdKeyInRanges(key string, ranges []etcdKeyRange) bool {
	for _, r := range ranges {
		if r.end == "" && key == r.start {
			return true
		}
		if r.end != "" && key >= r.start && (r.end == "\x00" || key < r.end) {
			return true
		}
	}
	return false
}

// v2Command 执行 etcdctl v2 风格命令；put / del 作为 set / rm 的别名，与 v3 写法一致。
func (e *EtcdDB) v2Command(ctx context.Context, command etcdCommand) ([]map[string]interface{}, []string, error) {
	c := e.v2
	key := ""
	if len(command.args) > 0 {
		key = command.args[0]
	}
	ttlForm := func(form url.Values) (url.Values, error) {
		if ttl, ok := command.flag("ttl"); ok {
			if _, err := strconv.ParseInt(ttl, 10, 64); err != nil {
				return nil, etcdFlagError("ttl", ttl)
			}
			form.Set("ttl", ttl)
		}
		return form, nil
	}
	nodeRows := func(nodes ...*etcdV2Node) ([]map[string]interface{}, []string, error) {
		rows := make([]map[string]interface{}, 0, len(nodes))
		for _, node := range nodes {
			if node == nil {
				continue
			}
			rows = append(rows, map[string]interface{}{
				"key": node.Key, "dir": node.Dir, "value": node.Value, "ttl": node.TTL,
				"created_index": node.CreatedIndex, "modified_index": node.ModifiedIndex,
			})
		}
		return rows, []string{"key", "dir", "value", "ttl", "created_index", "modified_index"}, nil
	}
	write := func(method string, query, form url.Values) ([]map[string]interface{}, []string, error) {
		resp, err := c.do(ctx, method, key, query, form)
		if err != nil {
			return nil, nil, err
		}
		return nodeRows(resp.Node)
	}
	switch command.name {
	case "ls":
		if key == "" {
			key = "/"
		}
		node, err := c.get(ctx, key, command.boolFlag("recursive"))
		if err != nil {
			return nil, nil, err
		}
		var walk func(node *etcdV2Node, out []*etcdV2Node) []*etcdV2Node
		walk = func(node *etcdV2Node, out []*etcdV2Node) []*etcdV2Node {
			for _, child := range node.Nodes {
				out = append(out, child)
				if command.boolFlag("recursive") && child.Dir {
					out = walk(child, out)
				}
			}
			return out
		}
		return nodeRows(walk(node, nil)...)
	case "get":
		if key == "" {
			return nil, nil, etcdUsageError("get <key>")
		}
		node, err := c.get(ctx, key, false)
		if err != nil {
			return nil, nil, err
		}
		return nodeRows(node)
	case "set", "put", "mk", "update":
		if len(command.args) != 2 {
			return nil, nil, etcdUsageError(command.name + " <key> <value> [--ttl=N]")
		}
		form, err := ttlForm(url.Values{"value": {command.args[1]}})
		if err != nil {
			return nil, nil, err
		}
		query := url.Values{}
		switch command.name {
		case "mk":
			query.Set("prevExist", "false")
		case "update":
			query.Set("prevExist", "true")
		}
		return write(http.MethodPut, query, form)
	case "mkdir", "updatedir":
		if key == "" {
			return nil, nil, etcdUsageError(command.name + " <dir> [--ttl=N]")
		}
		form, err := ttlForm(url.Values{"dir": {"true"}})
		if err != nil {
			return nil, nil, err
		}
		query := url.Values{"prevExist": {"false"}}
		if command.name == "updatedir" {
			query.Set("prevExist", "true")
		}
		return write(http.MethodPut, query, form)
	case "rm", "del", "delete", "rmdir":
		if key == "" {
			return nil, nil, etcdUsageError(command.name + " <key> [--recursive] [--dir]")
		}
		query := url.Values{}
		if command.boolFlag("recursive") {
			query.Set("recursive", "true")
		}
		if command.boolFlag("dir") || command.name == "rmdir" {
			query.Set("dir", "true")
		}
		return write(http.MethodDelete, query, nil)
	case "watch":
		return e.v2Watch(ctx, command)
	case "version":
		return []map[string]interface{}{{"version": e.serverVersion}}, []string{"version"}, nil
	}
	return nil, nil, localizedDatabaseRuntimeError("db.backend.error.etcd_command_unknown", map[string]any{"command": command.name})
}

// applyChanges 逐条写入：新增要求键不存在（prevExist=false），修改与删除以 modifiedIndex 为前提（prevIndex）。
func (c *etcdV2Client) applyChanges(ctx context.Context, changes connection.ChangeSet) error {
	for _, row := range changes.Deletes {
		key := kvText(row[etcdColumnKey])
		if key == "" {
			return localizedDatabaseRuntimeError("db.backend.error.etcd_key_required", nil)
		}
		if _, err := c.do(ctx, http.MethodDelete, key, nil, nil); err != nil {
			return err
		}
	}
	for _, update := range changes.Updates {
		oldKey := kvText(update.Keys[etcdColumnKey])
		current, err := c.get(ctx, oldKey, false)
		if err != nil {
			return err
		}
		form, newKey, err := etcdV2Form(update.Values, oldKey, current.Value, current.TTL)
		if err != nil {
			return err
		}
		query := url.Values{"prevIndex": {strconv.FormatInt(current.ModifiedIndex, 10)}}
		if newKey != oldKey {
			query = url.Values{"prevExist": {"false"}}
		}
		if _, err := c.do(ctx, http.MethodPut, newKey, query, form); err != nil {
			return err
		}
		if newKey != oldKey {
			deleteQuery := url.Values{"prevIndex": {strconv.FormatInt(current.ModifiedIndex, 10)}}
			if _, err := c.do(ctx, http.MethodDelete, oldKey, deleteQuery, nil); err != nil {
				return err
			}
		}
	}
	for _, row := range changes.Inserts {
		form, key, err := etcdV2Form(row, "", "", 0)
		if err != nil {
			return err
		}
		if _, err := c.do(ctx, http.MethodPut, key, url.Values{"prevExist": {"false"}}, form); err != nil {
			return err
		}
	}
	return nil
}

func etcdV2Form(values map[string]interface{}, key, value string, ttl int64) (url.Values, string, error) {
	if raw, ok := values[etcdColumnKey]; ok {
		key = kvText(raw)
	}
	if strings.TrimSpace(key) == "" {
		return nil, "", localizedDatabaseRuntimeError("db.backend.error.etcd_key_required", nil)
	}
	if raw, ok := values[etcdColumnValue]; ok {
		value = kvText(raw)
	}
	form := url.Values{"value": {value}}
	if raw, ok := values[etcdColumnTTL]; ok {
		text := strings.TrimSpace(kvText(raw))
		if text != "" {
			parsed, err := strconv.ParseInt(text, 10, 64)
			if err != nil || parsed < 0 {
				return nil, "", etcdFlagError(etcdColumnTTL, text)
			}
			ttl = parsed
		} else {
			ttl = 0
		}
	}
	if ttl > 0 {
		form.Set("ttl", strconv.FormatInt(ttl, 10))
	}
	return form, key, nil
}
