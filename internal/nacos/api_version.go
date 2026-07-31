package nacos

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
)

const (
	nacosV3ReadinessPath = "/v3/admin/core/state/readiness"
	nacosV2ReadinessPath = "/v2/console/health/readiness"
	nacosV1ReadinessPath = "/v1/console/health/readiness"
)

type nacosAPIFamily uint8

type nacosHTTPError struct {
	status int
	body   string
}

type nacosConfigNotFoundError struct {
	group  string
	dataID string
}

func (e *nacosHTTPError) Error() string {
	return localizedNacosBackendText("nacos.backend.error.http_status", map[string]any{
		"status": e.status,
		"body":   e.body,
	})
}

func (e *nacosConfigNotFoundError) Error() string {
	return localizedNacosBackendText("nacos.backend.error.config_not_found", map[string]any{
		"group":  e.group,
		"dataId": e.dataID,
	})
}

// HTTPStatusCode extracts a Nacos HTTP status from an error.
func HTTPStatusCode(err error) (int, bool) {
	var statusErr *nacosHTTPError
	if !errors.As(err, &statusErr) {
		return 0, false
	}
	return statusErr.status, true
}

// IsConfigNotFound reports whether an error explicitly represents a missing
// Nacos config. It intentionally does not classify arbitrary error text.
func IsConfigNotFound(err error) bool {
	var notFoundErr *nacosConfigNotFoundError
	return errors.As(err, &notFoundErr)
}

const (
	nacosAPIUnknown nacosAPIFamily = iota
	nacosAPIV1
	nacosAPIV2
	nacosAPIV3
)

type nacosAPIRoutes struct {
	namespaceList      string
	namespace          string
	config             string
	configList         string
	configHistory      string
	historyList        string
	beta               string
	service            string
	serviceList        string
	serviceListByGroup string
	instance           string
	instanceList       string
	health             string
}

func routesForNacosAPI(family nacosAPIFamily) nacosAPIRoutes {
	switch family {
	case nacosAPIV3:
		return nacosAPIRoutes{
			namespaceList:      "/v3/admin/core/namespace/list",
			namespace:          "/v3/admin/core/namespace",
			config:             "/v3/admin/cs/config",
			configList:         "/v3/admin/cs/config/list",
			configHistory:      "/v3/admin/cs/history",
			historyList:        "/v3/admin/cs/history/list",
			beta:               "/v3/admin/cs/config/beta",
			service:            "/v3/admin/ns/service",
			serviceList:        "/v3/admin/ns/service/list",
			serviceListByGroup: "/v3/admin/ns/service/list",
			instance:           "/v3/admin/ns/instance",
			instanceList:       "/v3/admin/ns/instance/list",
			health:             "/v3/admin/ns/health/instance",
		}
	case nacosAPIV2:
		return nacosAPIRoutes{
			namespaceList: "/v2/console/namespace/list",
			namespace:     "/v2/console/namespace",
			config:        "/v2/cs/config",
			configList:    "/v2/cs/config/searchDetail",
			configHistory: "/v2/cs/history",
			historyList:   "/v2/cs/history/list",
			// Nacos 2.x has no v2 beta query/stop endpoint.
			beta:               "/v1/cs/configs",
			service:            "/v2/ns/service",
			serviceList:        "/v2/ns/service/list",
			serviceListByGroup: "/v2/ns/service/list",
			instance:           "/v2/ns/instance",
			instanceList:       "/v2/ns/instance/list",
			health:             "/v2/ns/health/instance",
		}
	default:
		return nacosAPIRoutes{
			namespaceList:      "/v1/console/namespaces",
			namespace:          "/v1/console/namespaces",
			config:             "/v1/cs/configs",
			configList:         "/v1/cs/configs",
			configHistory:      "/v1/cs/history",
			historyList:        "/v1/cs/history",
			beta:               "/v1/cs/configs",
			service:            "/v1/ns/service",
			serviceList:        "/v1/ns/catalog/services",
			serviceListByGroup: "/v1/ns/service/list",
			instance:           "/v1/ns/instance",
			instanceList:       "/v1/ns/instance/list",
			health:             "/v1/ns/health/instance",
		}
	}
}

func (c *ClientImpl) currentAPIFamily() nacosAPIFamily {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.apiFamily == nacosAPIUnknown {
		return nacosAPIV1
	}
	return c.apiFamily
}

func (c *ClientImpl) currentAPIRoutes() nacosAPIRoutes {
	return routesForNacosAPI(c.currentAPIFamily())
}

func (c *ClientImpl) detectAPIFamily(ctx context.Context) error {
	probes := []struct {
		family    nacosAPIFamily
		path      string
		readiness bool
		validate  func([]byte) error
	}{
		{
			family:    nacosAPIV3,
			path:      nacosV3ReadinessPath,
			readiness: true,
			validate:  validateNacosAPIReadinessProbe,
		},
		{
			family:    nacosAPIV2,
			path:      nacosV2ReadinessPath,
			readiness: true,
			validate:  validateNacosAPIReadinessProbe,
		},
		// Nacos 2.2 introduced the v2 APIs before the v2 readiness endpoint.
		// Its namespace list is unprotected and remains the compatibility probe.
		{
			family:   nacosAPIV2,
			path:     routesForNacosAPI(nacosAPIV2).namespaceList,
			validate: validateNacosAPIProbe,
		},
		{
			family:    nacosAPIV1,
			path:      nacosV1ReadinessPath,
			readiness: true,
			validate:  validateNacosV1ReadinessProbe,
		},
		// Official Nacos 1.x has exposed readiness since 1.0.0. Keep the
		// namespace route as a final compatibility fallback for deployments
		// whose reverse proxy intentionally hides the health controller.
		{
			family:   nacosAPIV1,
			path:     routesForNacosAPI(nacosAPIV1).namespaceList,
			validate: validateNacosAPIProbe,
		},
	}

	for _, probe := range probes {
		var (
			body   []byte
			status int
			err    error
		)
		if probe.readiness {
			body, status, err = c.doReadinessRequest(ctx, probe.path)
		} else {
			body, status, err = c.doRequest(ctx, http.MethodGet, probe.path, nil, nil)
		}
		if err != nil {
			return err
		}
		if status >= 200 && status < 300 {
			if err := probe.validate(body); err != nil {
				return err
			}
			c.mu.Lock()
			c.apiFamily = probe.family
			c.mu.Unlock()
			return nil
		}
		if isMissingNacosAPI(status, body) {
			continue
		}
		return nacosHTTPStatusError(status, body)
	}

	return nacosHTTPStatusError(http.StatusNotFound, []byte("no supported Nacos API family found"))
}

func (c *ClientImpl) probeReadiness(ctx context.Context, family nacosAPIFamily) error {
	path := nacosV1ReadinessPath
	validate := validateNacosV1ReadinessProbe
	switch family {
	case nacosAPIV3:
		path = nacosV3ReadinessPath
		validate = validateNacosAPIReadinessProbe
	case nacosAPIV2:
		path = nacosV2ReadinessPath
		validate = validateNacosAPIReadinessProbe
	}

	body, status, err := c.doReadinessRequest(ctx, path)
	if err != nil {
		return err
	}
	if status < 200 || status >= 300 {
		if family != nacosAPIV3 && isMissingNacosAPI(status, body) {
			// Nacos 2.2 predates the v2 readiness controller. The same
			// fallback also preserves compatibility with Nacos 1.x
			// deployments whose reverse proxy hides the health endpoint.
			_, err = c.ListNamespaces(ctx)
			return err
		}
		return nacosHTTPStatusError(status, body)
	}
	return validate(body)
}

func (c *ClientImpl) doReadinessRequest(ctx context.Context, path string) ([]byte, int, error) {
	body, status, err := c.doRequestRaw(ctx, http.MethodGet, path, nil, nil, false)
	if err != nil || (status != http.StatusUnauthorized && status != http.StatusForbidden) {
		return body, status, err
	}

	c.mu.Lock()
	hasCredentials := strings.TrimSpace(c.config.User) != ""
	c.mu.Unlock()
	if !hasCredentials {
		return body, status, nil
	}
	return c.doRequest(ctx, http.MethodGet, path, nil, nil)
}

type nacosAPIProbeEnvelope struct {
	Code    *int            `json:"code"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data"`
}

func parseNacosAPIProbe(body []byte) (nacosAPIProbeEnvelope, error) {
	var envelope nacosAPIProbeEnvelope
	if err := json.Unmarshal(body, &envelope); err != nil || envelope.Code == nil {
		detail := "response is not a Nacos API result"
		if err != nil {
			detail = err.Error()
		}
		return nacosAPIProbeEnvelope{}, localizedNacosBackendError("nacos.backend.error.parse_namespaces", map[string]any{
			"detail": detail,
		})
	}
	if *envelope.Code != 0 && *envelope.Code != 200 {
		return nacosAPIProbeEnvelope{}, localizedNacosBackendError("nacos.backend.error.api_code", map[string]any{
			"code":    *envelope.Code,
			"message": truncateForError(envelope.Message),
		})
	}
	return envelope, nil
}

func validateNacosAPIProbe(body []byte) error {
	_, err := parseNacosAPIProbe(body)
	return err
}

func validateNacosAPIReadinessProbe(body []byte) error {
	envelope, err := parseNacosAPIProbe(body)
	if err != nil {
		return err
	}
	var readiness string
	if err := json.Unmarshal(envelope.Data, &readiness); err != nil ||
		!strings.EqualFold(strings.TrimSpace(readiness), "ok") {
		return localizedNacosBackendError("nacos.backend.error.parse_namespaces", map[string]any{
			"detail": "response is not a Nacos API readiness result",
		})
	}
	return nil
}

func validateNacosV1ReadinessProbe(body []byte) error {
	if strings.EqualFold(strings.TrimSpace(string(body)), "OK") {
		return nil
	}
	return localizedNacosBackendError("nacos.backend.error.parse_namespaces", map[string]any{
		"detail": "response is not a Nacos v1 readiness result",
	})
}

func isMissingNacosAPI(status int, body []byte) bool {
	if status == http.StatusNotFound || status == http.StatusMethodNotAllowed {
		return true
	}
	if status == http.StatusUnauthorized || status == http.StatusForbidden {
		return false
	}
	text := strings.ToLower(strings.TrimSpace(string(body)))
	return strings.Contains(text, "no such api") ||
		strings.Contains(text, "no handler found") ||
		strings.Contains(text, "api not found")
}

func nacosHTTPStatusError(status int, body []byte) error {
	return &nacosHTTPError{
		status: status,
		body:   truncateForError(string(body)),
	}
}

// unwrapNacosResult extracts data from the Result<T> envelope used by Nacos
// v2/v3 and several v1 console endpoints. Raw v1 payloads pass through.
func unwrapNacosResult(body []byte) ([]byte, error) {
	var envelope struct {
		Code    *int            `json:"code"`
		Message string          `json:"message"`
		Data    json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(body, &envelope); err != nil || envelope.Code == nil {
		return body, nil
	}
	if *envelope.Code != 0 && *envelope.Code != 200 {
		return nil, localizedNacosBackendError("nacos.backend.error.api_code", map[string]any{
			"code":    *envelope.Code,
			"message": truncateForError(envelope.Message),
		})
	}
	if len(envelope.Data) == 0 || string(envelope.Data) == "null" {
		return nil, nil
	}
	return envelope.Data, nil
}
