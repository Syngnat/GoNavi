package nacos

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

// ListConfigHistory lists history records for a config.
func (c *ClientImpl) ListConfigHistory(ctx context.Context, query HistoryQuery) (*HistoryPage, error) {
	family := c.currentAPIFamily()
	dataID := strings.TrimSpace(query.DataID)
	group := strings.TrimSpace(query.Group)
	if dataID == "" {
		return nil, localizedNacosBackendError("nacos.backend.error.data_id_required", nil)
	}
	if group == "" {
		group = "DEFAULT_GROUP"
	}
	pageNo := query.PageNo
	if pageNo <= 0 {
		pageNo = 1
	}
	pageSize := query.PageSize
	if pageSize <= 0 {
		pageSize = defaultConfigPageSize
	}
	if pageSize > maxConfigPageSize {
		pageSize = maxConfigPageSize
	}

	params := url.Values{}
	params.Set("dataId", dataID)
	params.Set("pageNo", strconv.Itoa(pageNo))
	params.Set("pageSize", strconv.Itoa(pageSize))
	if family == nacosAPIV3 {
		params.Set("groupName", group)
		params.Set("namespaceId", normalizeNamespaceID(query.NamespaceID))
	} else if family == nacosAPIV2 {
		params.Set("group", group)
		params.Set("namespaceId", normalizeNamespaceID(query.NamespaceID))
	} else {
		params.Set("search", "accurate")
		params.Set("group", group)
		params.Set("tenant", normalizeNamespaceID(query.NamespaceID))
	}

	body, status, err := c.doRequest(ctx, http.MethodGet, c.currentAPIRoutes().historyList, params, nil)
	if err != nil {
		return nil, err
	}
	if status < 200 || status >= 300 {
		return nil, localizedNacosBackendError("nacos.backend.error.http_status", map[string]any{
			"status": status,
			"body":   truncateForError(string(body)),
		})
	}

	data, err := unwrapNacosResult(body)
	if err != nil {
		return nil, err
	}
	var payload struct {
		TotalCount     int64 `json:"totalCount"`
		PageNumber     int   `json:"pageNumber"`
		PagesAvailable int   `json:"pagesAvailable"`
		PageItems      []struct {
			ID               any    `json:"id"`
			LastID           any    `json:"lastId"`
			DataID           string `json:"dataId"`
			Group            string `json:"group"`
			GroupName        string `json:"groupName"`
			Tenant           string `json:"tenant"`
			NamespaceID      string `json:"namespaceId"`
			AppName          string `json:"appName"`
			MD5              string `json:"md5"`
			Content          string `json:"content"`
			SrcIP            string `json:"srcIp"`
			SrcUser          string `json:"srcUser"`
			OpType           string `json:"opType"`
			CreatedTime      any    `json:"createdTime"`
			CreateTime       any    `json:"createTime"`
			LastModifiedTime any    `json:"lastModifiedTime"`
			ModifyTime       any    `json:"modifyTime"`
		} `json:"pageItems"`
	}
	if err := json.Unmarshal(data, &payload); err != nil {
		return nil, localizedNacosBackendError("nacos.backend.error.parse_history", map[string]any{
			"detail": err.Error(),
		})
	}

	items := make([]HistoryItem, 0, len(payload.PageItems))
	for _, item := range payload.PageItems {
		items = append(items, HistoryItem{
			ID:           stringifyAnyID(item.ID),
			LastID:       stringifyAnyID(item.LastID),
			DataID:       strings.TrimSpace(item.DataID),
			Group:        firstNonEmpty(strings.TrimSpace(item.Group), strings.TrimSpace(item.GroupName)),
			NamespaceID:  normalizeNamespaceID(firstNonEmpty(item.Tenant, item.NamespaceID)),
			AppName:      strings.TrimSpace(item.AppName),
			MD5:          strings.TrimSpace(item.MD5),
			Content:      item.Content,
			SrcIP:        strings.TrimSpace(item.SrcIP),
			SrcUser:      strings.TrimSpace(item.SrcUser),
			OpType:       strings.TrimSpace(item.OpType),
			CreatedTime:  stringifyAnyTime(item.CreatedTime, item.CreateTime),
			ModifiedTime: stringifyAnyTime(item.LastModifiedTime, item.ModifyTime),
		})
	}
	return &HistoryPage{
		TotalCount:     payload.TotalCount,
		PageNumber:     payload.PageNumber,
		PagesAvailable: payload.PagesAvailable,
		PageItems:      items,
	}, nil
}

// GetConfigHistory loads one history detail by nid.
func (c *ClientImpl) GetConfigHistory(ctx context.Context, namespaceID, group, dataID, nid string) (*HistoryItem, error) {
	family := c.currentAPIFamily()
	dataID = strings.TrimSpace(dataID)
	group = strings.TrimSpace(group)
	nid = strings.TrimSpace(nid)
	if dataID == "" {
		return nil, localizedNacosBackendError("nacos.backend.error.data_id_required", nil)
	}
	if nid == "" {
		return nil, localizedNacosBackendError("nacos.backend.error.history_id_required", nil)
	}
	if group == "" {
		group = "DEFAULT_GROUP"
	}

	params := url.Values{}
	params.Set("nid", nid)
	params.Set("dataId", dataID)
	if family == nacosAPIV3 {
		params.Set("groupName", group)
		params.Set("namespaceId", normalizeNamespaceID(namespaceID))
	} else if family == nacosAPIV2 {
		params.Set("group", group)
		params.Set("namespaceId", normalizeNamespaceID(namespaceID))
	} else {
		params.Set("group", group)
		params.Set("tenant", normalizeNamespaceID(namespaceID))
	}

	body, status, err := c.doRequest(ctx, http.MethodGet, c.currentAPIRoutes().configHistory, params, nil)
	if err != nil {
		return nil, err
	}
	if status < 200 || status >= 300 {
		return nil, localizedNacosBackendError("nacos.backend.error.http_status", map[string]any{
			"status": status,
			"body":   truncateForError(string(body)),
		})
	}

	data, err := unwrapNacosResult(body)
	if err != nil {
		return nil, err
	}
	var payload struct {
		ID               any    `json:"id"`
		LastID           any    `json:"lastId"`
		DataID           string `json:"dataId"`
		Group            string `json:"group"`
		GroupName        string `json:"groupName"`
		Tenant           string `json:"tenant"`
		NamespaceID      string `json:"namespaceId"`
		AppName          string `json:"appName"`
		MD5              string `json:"md5"`
		Content          string `json:"content"`
		SrcIP            string `json:"srcIp"`
		SrcUser          string `json:"srcUser"`
		OpType           string `json:"opType"`
		CreatedTime      any    `json:"createdTime"`
		CreateTime       any    `json:"createTime"`
		LastModifiedTime any    `json:"lastModifiedTime"`
		ModifyTime       any    `json:"modifyTime"`
	}
	if err := json.Unmarshal(data, &payload); err != nil {
		return nil, localizedNacosBackendError("nacos.backend.error.parse_history", map[string]any{
			"detail": err.Error(),
		})
	}
	return &HistoryItem{
		ID:           firstNonEmpty(stringifyAnyID(payload.ID), nid),
		LastID:       stringifyAnyID(payload.LastID),
		DataID:       firstNonEmpty(strings.TrimSpace(payload.DataID), dataID),
		Group:        firstNonEmpty(strings.TrimSpace(payload.Group), strings.TrimSpace(payload.GroupName), group),
		NamespaceID:  normalizeNamespaceID(firstNonEmpty(payload.Tenant, payload.NamespaceID, namespaceID)),
		AppName:      strings.TrimSpace(payload.AppName),
		MD5:          strings.TrimSpace(payload.MD5),
		Content:      payload.Content,
		SrcIP:        strings.TrimSpace(payload.SrcIP),
		SrcUser:      strings.TrimSpace(payload.SrcUser),
		OpType:       strings.TrimSpace(payload.OpType),
		CreatedTime:  stringifyAnyTime(payload.CreatedTime, payload.CreateTime),
		ModifiedTime: stringifyAnyTime(payload.LastModifiedTime, payload.ModifyTime),
	}, nil
}

func parseNacosBoolResult(body []byte, status int, failKey string) error {
	if status < 200 || status >= 300 {
		return localizedNacosBackendError("nacos.backend.error.http_status", map[string]any{
			"status": status,
			"body":   truncateForError(string(body)),
		})
	}
	text := strings.TrimSpace(string(body))
	if text == "true" || text == "" || strings.EqualFold(text, "ok") {
		return nil
	}
	var boolResult bool
	if err := json.Unmarshal(body, &boolResult); err == nil && boolResult {
		return nil
	}
	// Some console APIs return {"code":200,...}
	var wrapped struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
		Data    any    `json:"data"`
	}
	if err := json.Unmarshal(body, &wrapped); err == nil && (wrapped.Code == 0 || wrapped.Code == 200) {
		switch v := wrapped.Data.(type) {
		case bool:
			if v {
				return nil
			}
		case string:
			if v == "true" || v == "" {
				return nil
			}
		case nil:
			return nil
		}
	}
	return localizedNacosBackendError(failKey, map[string]any{
		"body": truncateForError(text),
	})
}

func stringifyAnyID(value any) string {
	switch v := value.(type) {
	case nil:
		return ""
	case string:
		return strings.TrimSpace(v)
	case float64:
		// avoid scientific notation for large ids
		return strconv.FormatInt(int64(v), 10)
	case json.Number:
		return v.String()
	default:
		return strings.TrimSpace(fmt.Sprint(v))
	}
}
