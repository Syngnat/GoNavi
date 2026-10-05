package nacos

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
)

// ListNamespaces returns all namespaces including public.
func (c *ClientImpl) ListNamespaces(ctx context.Context) ([]Namespace, error) {
	body, status, err := c.doRequest(ctx, http.MethodGet, c.currentAPIRoutes().namespaceList, nil, nil)
	if err != nil {
		return nil, err
	}
	if status < 200 || status >= 300 {
		return nil, nacosHTTPStatusError(status, body)
	}

	data, err := unwrapNacosResult(body)
	if err != nil {
		return nil, err
	}
	var payload []struct {
		Namespace         string `json:"namespace"`
		NamespaceID       string `json:"namespaceId"`
		NamespaceShowName string `json:"namespaceShowName"`
		NamespaceName     string `json:"namespaceName"`
		NamespaceDesc     string `json:"namespaceDesc"`
		Quota             int64  `json:"quota"`
		ConfigCount       int64  `json:"configCount"`
		Type              int    `json:"type"`
	}
	if err := json.Unmarshal(data, &payload); err != nil {
		return nil, localizedNacosBackendError("nacos.backend.error.parse_namespaces", map[string]any{
			"detail": err.Error(),
		})
	}

	result := make([]Namespace, 0, len(payload))
	for _, item := range payload {
		id := firstNonEmpty(strings.TrimSpace(item.Namespace), strings.TrimSpace(item.NamespaceID))
		showName := firstNonEmpty(strings.TrimSpace(item.NamespaceShowName), strings.TrimSpace(item.NamespaceName))
		if showName == "" {
			if id == "" {
				showName = "public"
			} else {
				showName = id
			}
		}
		result = append(result, Namespace{
			ID:          id,
			ShowName:    showName,
			Description: strings.TrimSpace(item.NamespaceDesc),
			ConfigCount: item.ConfigCount,
			Quota:       item.Quota,
			Type:        item.Type,
		})
	}
	return result, nil
}

// SearchConfigs lists configs under a namespace with optional filters.
func (c *ClientImpl) SearchConfigs(ctx context.Context, query ConfigQuery) (*ConfigPage, error) {
	family := c.currentAPIFamily()
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
	searchMode := strings.ToLower(strings.TrimSpace(query.Search))
	if searchMode == "" {
		searchMode = "blur"
	}

	params := url.Values{}
	params.Set("search", searchMode)
	params.Set("dataId", strings.TrimSpace(query.DataID))
	params.Set("appName", strings.TrimSpace(query.AppName))
	params.Set("pageNo", strconv.Itoa(pageNo))
	params.Set("pageSize", strconv.Itoa(pageSize))
	if family == nacosAPIV3 {
		params.Set("groupName", strings.TrimSpace(query.Group))
		params.Set("namespaceId", normalizeNamespaceID(query.NamespaceID))
		params.Set("configDetail", "")
	} else {
		params.Set("group", strings.TrimSpace(query.Group))
		params.Set("tenant", normalizeNamespaceID(query.NamespaceID))
		if family == nacosAPIV2 {
			params.Set("config_detail", "")
		}
	}

	body, status, err := c.doRequest(ctx, http.MethodGet, c.currentAPIRoutes().configList, params, nil)
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
			ID               string `json:"id"`
			DataID           string `json:"dataId"`
			Group            string `json:"group"`
			GroupName        string `json:"groupName"`
			Content          string `json:"content"`
			MD5              string `json:"md5"`
			Tenant           string `json:"tenant"`
			NamespaceID      string `json:"namespaceId"`
			AppName          string `json:"appName"`
			Type             string `json:"type"`
			Desc             string `json:"desc"`
			LastModifiedTime any    `json:"lastModifiedTime"`
			ModifiedTime     any    `json:"modifiedTime"`
			ModifyTime       any    `json:"modifyTime"`
		} `json:"pageItems"`
	}
	if err := json.Unmarshal(data, &payload); err != nil {
		return nil, localizedNacosBackendError("nacos.backend.error.parse_configs", map[string]any{
			"detail": err.Error(),
		})
	}

	items := make([]ConfigItem, 0, len(payload.PageItems))
	for _, item := range payload.PageItems {
		items = append(items, ConfigItem{
			ID:           strings.TrimSpace(item.ID),
			DataID:       strings.TrimSpace(item.DataID),
			Group:        firstNonEmpty(strings.TrimSpace(item.Group), strings.TrimSpace(item.GroupName)),
			NamespaceID:  normalizeNamespaceID(firstNonEmpty(item.Tenant, item.NamespaceID)),
			Content:      item.Content,
			Type:         strings.TrimSpace(item.Type),
			MD5:          strings.TrimSpace(item.MD5),
			AppName:      strings.TrimSpace(item.AppName),
			Desc:         strings.TrimSpace(item.Desc),
			ModifiedTime: stringifyAnyTime(item.LastModifiedTime, item.ModifiedTime, item.ModifyTime),
		})
	}
	return &ConfigPage{
		TotalCount:     payload.TotalCount,
		PageNumber:     payload.PageNumber,
		PagesAvailable: payload.PagesAvailable,
		PageItems:      items,
	}, nil
}

// ListConfigGroups returns unique config groups under a namespace.
func (c *ClientImpl) ListConfigGroups(ctx context.Context, namespaceID string) ([]string, error) {
	const pageSize = 100
	pageNo := 1
	seen := make(map[string]struct{})
	groups := make([]string, 0, 16)

	for {
		page, err := c.SearchConfigs(ctx, ConfigQuery{
			NamespaceID: namespaceID,
			PageNo:      pageNo,
			PageSize:    pageSize,
			Search:      "blur",
		})
		if err != nil {
			return nil, err
		}
		if page == nil || len(page.PageItems) == 0 {
			break
		}
		for _, item := range page.PageItems {
			group := strings.TrimSpace(item.Group)
			if group == "" {
				group = "DEFAULT_GROUP"
			}
			if _, ok := seen[group]; ok {
				continue
			}
			seen[group] = struct{}{}
			groups = append(groups, group)
		}
		if pageNo >= page.PagesAvailable || len(page.PageItems) < pageSize {
			break
		}
		pageNo++
		if pageNo > 200 {
			break
		}
	}

	sort.Strings(groups)
	return groups, nil
}

// GetConfig loads a single config content.
func (c *ClientImpl) GetConfig(ctx context.Context, namespaceID, group, dataID string) (*ConfigDetail, error) {
	family := c.currentAPIFamily()
	dataID = strings.TrimSpace(dataID)
	group = strings.TrimSpace(group)
	if dataID == "" {
		return nil, localizedNacosBackendError("nacos.backend.error.data_id_required", nil)
	}
	if group == "" {
		group = "DEFAULT_GROUP"
	}

	params := url.Values{}
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
		params.Set("show", "all")
	}

	body, status, err := c.doRequest(ctx, http.MethodGet, c.currentAPIRoutes().config, params, nil)
	if err != nil {
		return nil, err
	}
	if status == http.StatusNotFound {
		return nil, localizedNacosBackendError("nacos.backend.error.config_not_found", map[string]any{
			"dataId": dataID,
			"group":  group,
		})
	}
	if status < 200 || status >= 300 {
		return nil, localizedNacosBackendError("nacos.backend.error.http_status", map[string]any{
			"status": status,
			"body":   truncateForError(string(body)),
		})
	}

	data := body
	if family == nacosAPIV2 || family == nacosAPIV3 {
		data, err = unwrapNacosResult(body)
		if err != nil {
			return nil, err
		}
	}
	if family == nacosAPIV2 {
		content := decodeNacosStringData(data)
		return &ConfigDetail{
			DataID:      dataID,
			Group:       group,
			NamespaceID: normalizeNamespaceID(namespaceID),
			Content:     content,
			MD5:         ContentMD5(content),
		}, nil
	}

	// Nacos v1 show=all and v3 return JSON details.
	trimmed := strings.TrimSpace(string(data))
	if strings.HasPrefix(trimmed, "{") {
		var payload struct {
			DataID      string `json:"dataId"`
			Group       string `json:"group"`
			GroupName   string `json:"groupName"`
			Content     string `json:"content"`
			Type        string `json:"type"`
			MD5         string `json:"md5"`
			AppName     string `json:"appName"`
			Desc        string `json:"desc"`
			Tenant      string `json:"tenant"`
			NamespaceID string `json:"namespaceId"`
		}
		if err := json.Unmarshal(data, &payload); err == nil && (payload.Content != "" || payload.DataID != "") {
			md5Value := strings.TrimSpace(payload.MD5)
			if md5Value == "" {
				md5Value = ContentMD5(payload.Content)
			}
			return &ConfigDetail{
				DataID:      firstNonEmpty(payload.DataID, dataID),
				Group:       firstNonEmpty(payload.Group, payload.GroupName, group),
				NamespaceID: normalizeNamespaceID(firstNonEmpty(payload.Tenant, payload.NamespaceID, namespaceID)),
				Content:     payload.Content,
				Type:        strings.TrimSpace(payload.Type),
				MD5:         md5Value,
				AppName:     strings.TrimSpace(payload.AppName),
				Desc:        strings.TrimSpace(payload.Desc),
			}, nil
		}
	}

	content := string(data)
	return &ConfigDetail{
		DataID:      dataID,
		Group:       group,
		NamespaceID: normalizeNamespaceID(namespaceID),
		Content:     content,
		MD5:         ContentMD5(content),
	}, nil
}

func decodeNacosStringData(data []byte) string {
	var value string
	if err := json.Unmarshal(data, &value); err == nil {
		return value
	}
	return string(data)
}

// PublishConfig creates or updates a config.
func (c *ClientImpl) PublishConfig(ctx context.Context, req PublishRequest) error {
	family := c.currentAPIFamily()
	dataID := strings.TrimSpace(req.DataID)
	group := strings.TrimSpace(req.Group)
	if dataID == "" {
		return localizedNacosBackendError("nacos.backend.error.data_id_required", nil)
	}
	if group == "" {
		group = "DEFAULT_GROUP"
	}

	form := url.Values{}
	form.Set("dataId", dataID)
	form.Set("content", req.Content)
	if family == nacosAPIV3 {
		form.Set("groupName", group)
		form.Set("namespaceId", normalizeNamespaceID(req.NamespaceID))
	} else if family == nacosAPIV2 {
		form.Set("group", group)
		form.Set("namespaceId", normalizeNamespaceID(req.NamespaceID))
	} else {
		form.Set("group", group)
		form.Set("tenant", normalizeNamespaceID(req.NamespaceID))
	}
	if typ := strings.TrimSpace(req.Type); typ != "" {
		form.Set("type", typ)
	}
	if appName := strings.TrimSpace(req.AppName); appName != "" {
		form.Set("appName", appName)
	}
	if desc := strings.TrimSpace(req.Desc); desc != "" {
		form.Set("desc", desc)
	}
	headers := http.Header{}
	if betaIPs := strings.TrimSpace(req.BetaIPs); betaIPs != "" {
		headers.Set("betaIps", betaIPs)
	}

	body, status, err := c.doRequestWithHeaders(ctx, http.MethodPost, c.currentAPIRoutes().config, nil, form, headers)
	if err != nil {
		return err
	}
	if status < 200 || status >= 300 {
		return localizedNacosBackendError("nacos.backend.error.http_status", map[string]any{
			"status": status,
			"body":   truncateForError(string(body)),
		})
	}
	return parseNacosBoolResult(body, status, "nacos.backend.error.publish_failed")
}

// DeleteConfig removes a config.
func (c *ClientImpl) DeleteConfig(ctx context.Context, namespaceID, group, dataID string) error {
	family := c.currentAPIFamily()
	dataID = strings.TrimSpace(dataID)
	group = strings.TrimSpace(group)
	if dataID == "" {
		return localizedNacosBackendError("nacos.backend.error.data_id_required", nil)
	}
	if group == "" {
		group = "DEFAULT_GROUP"
	}

	params := url.Values{}
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

	body, status, err := c.doRequest(ctx, http.MethodDelete, c.currentAPIRoutes().config, params, nil)
	if err != nil {
		return err
	}
	return parseNacosBoolResult(body, status, "nacos.backend.error.delete_failed")
}
