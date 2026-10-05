//go:build gonavi_full_drivers || gonavi_mongodb_driver

package db

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"

	"go.mongodb.org/mongo-driver/v2/bson"
)

func asMongoStringList(raw interface{}) []string {
	values, ok := raw.(bson.A)
	if !ok {
		return nil
	}
	result := make([]string, 0, len(values))
	for _, entry := range values {
		text := strings.TrimSpace(fmt.Sprintf("%v", entry))
		if text != "" {
			result = append(result, text)
		}
	}
	return result
}

func asMongoString(raw interface{}) string {
	if raw == nil {
		return ""
	}
	if value, ok := raw.(string); ok {
		return strings.TrimSpace(value)
	}
	return strings.TrimSpace(fmt.Sprintf("%v", raw))
}

func asMongoInt(raw interface{}) int {
	switch value := raw.(type) {
	case int:
		return value
	case int32:
		return int(value)
	case int64:
		return int(value)
	case float32:
		return int(value)
	case float64:
		return int(value)
	default:
		return 0
	}
}

func asMongoBool(raw interface{}) bool {
	switch value := raw.(type) {
	case bool:
		return value
	case int:
		return value != 0
	case int32:
		return value != 0
	case int64:
		return value != 0
	case float32:
		return value != 0
	case float64:
		return value != 0
	default:
		return false
	}
}

func asMongoInt64(raw interface{}) int64 {
	switch value := raw.(type) {
	case int:
		return int64(value)
	case int32:
		return int64(value)
	case int64:
		return value
	case float32:
		return int64(value)
	case float64:
		return int64(value)
	default:
		return 0
	}
}

func mongoStateByCode(code int) string {
	switch code {
	case 1:
		return "PRIMARY"
	case 2:
		return "SECONDARY"
	case 3:
		return "RECOVERING"
	case 5:
		return "STARTUP2"
	case 6:
		return "UNKNOWN"
	case 7:
		return "ARBITER"
	case 8:
		return "DOWN"
	case 9:
		return "ROLLBACK"
	case 10:
		return "REMOVED"
	default:
		return "UNKNOWN"
	}
}

func normalizeMongoStateLabel(state string, stateCode int) string {
	normalized := strings.ToUpper(strings.TrimSpace(state))
	if normalized != "" {
		return normalized
	}
	return mongoStateByCode(stateCode)
}

func buildMembersFromReplStatus(raw bson.M) []connection.MongoMemberInfo {
	items, ok := raw["members"].(bson.A)
	if !ok {
		return nil
	}

	members := make([]connection.MongoMemberInfo, 0, len(items))
	for _, entry := range items {
		member, ok := entry.(bson.M)
		if !ok {
			continue
		}
		host := asMongoString(member["name"])
		if host == "" {
			continue
		}
		stateCode := asMongoInt(member["state"])
		state := normalizeMongoStateLabel(asMongoString(member["stateStr"]), stateCode)
		members = append(members, connection.MongoMemberInfo{
			Host:      host,
			Role:      state,
			State:     state,
			StateCode: stateCode,
			Healthy:   asMongoInt(member["health"]) > 0 || asMongoBool(member["health"]),
			IsSelf:    asMongoBool(member["self"]),
		})
	}

	sort.Slice(members, func(i, j int) bool {
		return members[i].Host < members[j].Host
	})
	return members
}

func buildMembersFromHello(raw bson.M) []connection.MongoMemberInfo {
	hosts := asMongoStringList(raw["hosts"])
	if len(hosts) == 0 {
		return nil
	}
	primary := asMongoString(raw["primary"])
	selfHost := asMongoString(raw["me"])
	passiveSet := make(map[string]struct{})
	for _, host := range asMongoStringList(raw["passives"]) {
		passiveSet[host] = struct{}{}
	}
	arbiterSet := make(map[string]struct{})
	for _, host := range asMongoStringList(raw["arbiters"]) {
		arbiterSet[host] = struct{}{}
	}

	members := make([]connection.MongoMemberInfo, 0, len(hosts))
	for _, host := range hosts {
		state := "SECONDARY"
		stateCode := 2
		if host == primary {
			state = "PRIMARY"
			stateCode = 1
		} else if _, ok := arbiterSet[host]; ok {
			state = "ARBITER"
			stateCode = 7
		} else if _, ok := passiveSet[host]; ok {
			state = "PASSIVE"
			stateCode = 6
		}
		members = append(members, connection.MongoMemberInfo{
			Host:      host,
			Role:      state,
			State:     state,
			StateCode: stateCode,
			Healthy:   true,
			IsSelf:    host == selfHost,
		})
	}

	sort.Slice(members, func(i, j int) bool {
		return members[i].Host < members[j].Host
	})
	return members
}

func (m *MongoDB) DiscoverMembers() (string, []connection.MongoMemberInfo, error) {
	return m.DiscoverMembersContext(context.Background())
}

func (m *MongoDB) DiscoverMembersContext(parent context.Context) (string, []connection.MongoMemberInfo, error) {
	if m.client == nil {
		return "", nil, fmt.Errorf("连接未打开")
	}

	timeout := m.pingTimeout
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	if parent == nil {
		parent = context.Background()
	}
	ctx, cancel := context.WithTimeout(parent, timeout)
	defer cancel()

	adminDB := m.client.Database("admin")

	var replStatus bson.M
	replErr := adminDB.RunCommand(ctx, bson.D{{Key: "replSetGetStatus", Value: 1}}).Decode(&replStatus)
	if replErr == nil {
		replicaSet := asMongoString(replStatus["set"])
		members := buildMembersFromReplStatus(replStatus)
		if len(members) > 0 {
			return replicaSet, members, nil
		}
	}

	var helloResult bson.M
	helloErr := adminDB.RunCommand(ctx, bson.D{{Key: "hello", Value: 1}}).Decode(&helloResult)
	if helloErr != nil {
		if err := adminDB.RunCommand(ctx, bson.D{{Key: "isMaster", Value: 1}}).Decode(&helloResult); err != nil {
			if replErr != nil {
				return "", nil, fmt.Errorf("成员发现失败：replSetGetStatus=%v；hello=%v", replErr, err)
			}
			return "", nil, fmt.Errorf("成员发现失败：hello=%w", err)
		}
	}

	replicaSet := asMongoString(helloResult["setName"])
	members := buildMembersFromHello(helloResult)
	if len(members) == 0 {
		if replErr != nil {
			return replicaSet, nil, fmt.Errorf("未获取到成员信息：replSetGetStatus=%v", replErr)
		}
		return replicaSet, nil, fmt.Errorf("未获取到成员信息")
	}
	return replicaSet, members, nil
}
