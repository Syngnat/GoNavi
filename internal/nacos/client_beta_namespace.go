package nacos

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
)

// GetBetaConfig loads beta/gray config if present.
func (c *ClientImpl) GetBetaConfig(ctx context.Context, namespaceID, group, dataID string) (*BetaConfigDetail, error) {
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
	} else {
		params.Set("group", group)
		params.Set("tenant", normalizeNamespaceID(namespaceID))
		params.Set("beta", "true")
	}

	body, status, err := c.doRequest(ctx, http.MethodGet, c.currentAPIRoutes().beta, params, nil)
	if err != nil {
		return nil, err
	}
	if status == http.StatusNotFound {
		return &BetaConfigDetail{
			DataID:      dataID,
			Group:       group,
			NamespaceID: normalizeNamespaceID(namespaceID),
			Exists:      false,
		}, nil
	}
	if status < 200 || status >= 300 {
		// Some versions return 400/500 when beta does not exist; treat common empty cases as missing.
		text := strings.TrimSpace(string(body))
		if text == "" || strings.Contains(strings.ToLower(text), "not found") || strings.Contains(text, "config data not exist") {
			return &BetaConfigDetail{
				DataID:      dataID,
				Group:       group,
				NamespaceID: normalizeNamespaceID(namespaceID),
				Exists:      false,
			}, nil
		}
		return nil, localizedNacosBackendError("nacos.backend.error.http_status", map[string]any{
			"status": status,
			"body":   truncateForError(text),
		})
	}

	data, err := unwrapNacosResult(body)
	if err != nil {
		return nil, err
	}
	trimmed := strings.TrimSpace(string(data))
	if trimmed == "" {
		return &BetaConfigDetail{
			DataID:      dataID,
			Group:       group,
			NamespaceID: normalizeNamespaceID(namespaceID),
			Exists:      false,
		}, nil
	}
	if strings.HasPrefix(trimmed, "{") {
		var payload struct {
			DataID      string `json:"dataId"`
			Group       string `json:"group"`
			GroupName   string `json:"groupName"`
			Content     string `json:"content"`
			Type        string `json:"type"`
			MD5         string `json:"md5"`
			BetaIPs     string `json:"betaIps"`
			GrayRule    string `json:"grayRule"`
			Tenant      string `json:"tenant"`
			NamespaceID string `json:"namespaceId"`
		}
		if err := json.Unmarshal(data, &payload); err == nil {
			content := payload.Content
			if strings.TrimSpace(content) == "" && strings.TrimSpace(payload.DataID) == "" {
				return &BetaConfigDetail{
					DataID:      dataID,
					Group:       group,
					NamespaceID: normalizeNamespaceID(namespaceID),
					Exists:      false,
				}, nil
			}
			md5Value := strings.TrimSpace(payload.MD5)
			if md5Value == "" {
				md5Value = ContentMD5(content)
			}
			return &BetaConfigDetail{
				DataID:      firstNonEmpty(payload.DataID, dataID),
				Group:       firstNonEmpty(payload.Group, payload.GroupName, group),
				NamespaceID: normalizeNamespaceID(firstNonEmpty(payload.Tenant, payload.NamespaceID, namespaceID)),
				Content:     content,
				Type:        strings.TrimSpace(payload.Type),
				MD5:         md5Value,
				BetaIPs:     firstNonEmpty(strings.TrimSpace(payload.BetaIPs), betaIPsFromGrayRule(payload.GrayRule)),
				Exists:      true,
			}, nil
		}
	}

	return &BetaConfigDetail{
		DataID:      dataID,
		Group:       group,
		NamespaceID: normalizeNamespaceID(namespaceID),
		Content:     string(data),
		MD5:         ContentMD5(string(data)),
		Exists:      true,
	}, nil
}

func betaIPsFromGrayRule(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	var rule struct {
		Expr           string `json:"expr"`
		RawGrayRuleExp string `json:"rawGrayRuleExp"`
	}
	if err := json.Unmarshal([]byte(raw), &rule); err == nil {
		return firstNonEmpty(strings.TrimSpace(rule.Expr), strings.TrimSpace(rule.RawGrayRuleExp), raw)
	}
	return raw
}

// StopBetaConfig stops beta/gray publish for a config.
func (c *ClientImpl) StopBetaConfig(ctx context.Context, namespaceID, group, dataID string) error {
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
	} else {
		params.Set("group", group)
		params.Set("tenant", normalizeNamespaceID(namespaceID))
		params.Set("beta", "true")
	}
	body, status, err := c.doRequest(ctx, http.MethodDelete, c.currentAPIRoutes().beta, params, nil)
	if err != nil {
		return err
	}
	return parseNacosBoolResult(body, status, "nacos.backend.error.beta_stop_failed")
}

// CreateNamespace creates a namespace.
func (c *ClientImpl) CreateNamespace(ctx context.Context, req CreateNamespaceRequest) error {
	family := c.currentAPIFamily()
	showName := strings.TrimSpace(req.ShowName)
	if showName == "" {
		return localizedNacosBackendError("nacos.backend.error.namespace_name_required", nil)
	}
	nsID := strings.TrimSpace(req.ID)
	if strings.EqualFold(nsID, "public") || nsID == "" && strings.EqualFold(showName, "public") {
		// Creating another "public" is not allowed; empty id with non-public name is ok.
		if strings.EqualFold(showName, "public") {
			return localizedNacosBackendError("nacos.backend.error.namespace_public_reserved", nil)
		}
	}

	form := url.Values{}
	if family == nacosAPIV1 {
		form.Set("customNamespaceId", nsID)
	} else {
		form.Set("namespaceId", nsID)
	}
	form.Set("namespaceName", showName)
	form.Set("namespaceDesc", strings.TrimSpace(req.Description))

	body, status, err := c.doRequest(ctx, http.MethodPost, c.currentAPIRoutes().namespace, nil, form)
	if err != nil {
		return err
	}
	return parseNacosBoolResult(body, status, "nacos.backend.error.namespace_create_failed")
}

// UpdateNamespace updates namespace show name / description.
func (c *ClientImpl) UpdateNamespace(ctx context.Context, req UpdateNamespaceRequest) error {
	family := c.currentAPIFamily()
	nsID := strings.TrimSpace(req.ID)
	// public is represented as empty id; do not allow renaming public id, but updating show name is usually blocked by server.
	if nsID == "" || strings.EqualFold(nsID, "public") {
		return localizedNacosBackendError("nacos.backend.error.namespace_public_immutable", nil)
	}
	showName := strings.TrimSpace(req.ShowName)
	if showName == "" {
		return localizedNacosBackendError("nacos.backend.error.namespace_name_required", nil)
	}

	form := url.Values{}
	if family == nacosAPIV1 {
		form.Set("namespace", nsID)
		form.Set("namespaceShowName", showName)
	} else {
		form.Set("namespaceId", nsID)
		form.Set("namespaceName", showName)
	}
	form.Set("namespaceDesc", strings.TrimSpace(req.Description))

	body, status, err := c.doRequest(ctx, http.MethodPut, c.currentAPIRoutes().namespace, nil, form)
	if err != nil {
		return err
	}
	return parseNacosBoolResult(body, status, "nacos.backend.error.namespace_update_failed")
}

// DeleteNamespace deletes a namespace by id.
func (c *ClientImpl) DeleteNamespace(ctx context.Context, namespaceID string) error {
	nsID := strings.TrimSpace(namespaceID)
	if nsID == "" || strings.EqualFold(nsID, "public") {
		return localizedNacosBackendError("nacos.backend.error.namespace_public_immutable", nil)
	}

	// Prefer query parameters: Go's ParseForm ignores DELETE bodies, and many
	// Nacos deployments accept namespaceId on the query string.
	params := url.Values{}
	params.Set("namespaceId", nsID)

	body, status, err := c.doRequest(ctx, http.MethodDelete, c.currentAPIRoutes().namespace, params, nil)
	if err != nil {
		return err
	}
	return parseNacosBoolResult(body, status, "nacos.backend.error.namespace_delete_failed")
}
