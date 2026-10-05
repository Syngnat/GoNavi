//go:build gonavi_full_drivers || gonavi_meilisearch_driver

package db

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Meilisearch 的写入都先进队列：0.25 起返回任务号（0.28 起字段名为 taskUid，之前是 uid），通过 /tasks/{uid} 查询；
// 0.25 之前返回 updateId，通过 /indexes/{uid}/updates/{id} 查询，成功状态是 processed。

// meilisearchTaskRef 是入队响应里的任务引用。
type meilisearchTaskRef struct {
	id     int64
	legacy bool
	index  string
}

// parseMeilisearchTaskRef 从入队响应取任务引用；同步返回的响应（如 0.25 之前的建索引）没有任务时 ok 为 false。
// index 是请求路径里的索引名，旧版更新号要按索引查询。
func parseMeilisearchTaskRef(body []byte, index string) (meilisearchTaskRef, bool) {
	var payload map[string]interface{}
	if decodeJSONWithUseNumber(body, &payload) != nil {
		return meilisearchTaskRef{}, false
	}
	number := func(key string) (int64, bool) {
		value, ok := documentNumber(payload[key])
		return int64(value), ok
	}
	if id, ok := number("taskUid"); ok {
		return meilisearchTaskRef{id: id}, true
	}
	if id, ok := number("updateId"); ok && index != "" {
		return meilisearchTaskRef{id: id, legacy: true, index: index}, true
	}
	if _, hasStatus := payload["status"].(string); hasStatus {
		if id, ok := number("uid"); ok {
			return meilisearchTaskRef{id: id}, true
		}
	}
	return meilisearchTaskRef{}, false
}

// waitTask 轮询任务直到结束，返回任务详情；任务失败时返回服务端给出的原因。
// 超过 meilisearchTaskTimeout 仍未结束时报告结果未知（任务会继续在服务端执行）。
func (m *MeilisearchDB) waitTask(ctx context.Context, ref meilisearchTaskRef) (map[string]interface{}, error) {
	ctx, cancel := context.WithTimeout(ctx, meilisearchTaskTimeout)
	defer cancel()
	path := fmt.Sprintf("/tasks/%d", ref.id)
	if ref.legacy {
		path = meilisearchIndexPath(ref.index, fmt.Sprintf("/updates/%d", ref.id))
	}
	delay := 20 * time.Millisecond
	status := "enqueued"
	for {
		var task map[string]interface{}
		err := m.doJSON(ctx, http.MethodGet, path, nil, &task)
		if err == nil {
			status, _ = task["status"].(string)
			switch status {
			case "succeeded", "processed":
				return task, nil
			case "failed", "canceled":
				return task, localizedDatabaseRuntimeError("db.backend.error.meilisearch_task_failed", map[string]any{
					"task": ref.id, "detail": meilisearchTaskErrorText(task, status),
				})
			}
		} else if ctx.Err() == nil {
			return nil, MarkWriteOutcomeUnknown(err)
		}
		select {
		case <-ctx.Done():
			return nil, MarkWriteOutcomeUnknown(localizedDatabaseRuntimeError("db.backend.error.meilisearch_task_timeout", map[string]any{
				"task": ref.id, "status": status,
			}))
		case <-time.After(delay):
		}
		delay = min(delay*2, 500*time.Millisecond)
	}
}

// meilisearchTaskErrorText 取失败原因：0.25 起是 error.message，之前 error 直接是消息文本。
func meilisearchTaskErrorText(task map[string]interface{}, status string) string {
	switch typed := task["error"].(type) {
	case map[string]interface{}:
		if message, ok := typed["message"].(string); ok && message != "" {
			return message
		}
	case string:
		if typed != "" {
			return typed
		}
	}
	if message, ok := task["message"].(string); ok && message != "" {
		return message
	}
	return status
}

// meilisearchTaskAffected 取任务影响的文档数：删除看 deletedDocuments，写入看 indexedDocuments；旧版更新看 type.number。
func meilisearchTaskAffected(task map[string]interface{}) int64 {
	details, _ := task["details"].(map[string]interface{})
	for _, key := range []string{"deletedDocuments", "indexedDocuments", "editedDocuments", "receivedDocuments"} {
		if value, ok := documentNumber(details[key]); ok {
			return int64(value)
		}
	}
	if kind, ok := task["type"].(map[string]interface{}); ok {
		if value, ok := documentNumber(kind["number"]); ok {
			return int64(value)
		}
	}
	return 0
}

// meilisearchTaskDetail 取任务详情里的数值字段，字段不存在时 ok 为 false（旧版任务没有详情）。
func meilisearchTaskDetail(task map[string]interface{}, key string) (int64, bool) {
	details, _ := task["details"].(map[string]interface{})
	value, ok := documentNumber(details[key])
	return int64(value), ok
}

// enqueue 发出写请求并等待任务结束；响应不是任务时直接返回。
func (m *MeilisearchDB) enqueue(ctx context.Context, method, path string, body []byte) (map[string]interface{}, error) {
	index := meilisearchPathIndex(path)
	defer m.invalidate(index)
	resBody, err := m.doRaw(ctx, method, path, body)
	if err != nil {
		return nil, meilisearchWriteError(err)
	}
	ref, ok := parseMeilisearchTaskRef(resBody, index)
	if !ok {
		var payload map[string]interface{}
		_ = decodeJSONWithUseNumber(resBody, &payload)
		return payload, nil
	}
	return m.waitTask(ctx, ref)
}

func (m *MeilisearchDB) enqueueJSON(ctx context.Context, method, path string, body interface{}) (map[string]interface{}, error) {
	payload, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	return m.enqueue(ctx, method, path, payload)
}

// meilisearchPathIndex 取路径里的索引名（/indexes/{uid}/...）；不针对单个索引时返回空串。
func meilisearchPathIndex(path string) string {
	path, _, _ = strings.Cut(path, "?")
	rest, ok := strings.CutPrefix(path, "/indexes/")
	if !ok {
		return ""
	}
	segment, _, _ := strings.Cut(rest, "/")
	uid, err := url.PathUnescape(segment)
	if err != nil {
		return segment
	}
	return uid
}

// meilisearchWriteError 区分服务端拒绝与传输失败：后者请求可能已经生效，标记为结果未知。
func meilisearchWriteError(err error) error {
	var httpErr *meilisearchHTTPError
	if errors.As(err, &httpErr) || errors.Is(err, context.Canceled) {
		return err
	}
	return MarkWriteOutcomeUnknown(err)
}
