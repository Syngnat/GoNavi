//go:build gonavi_full_drivers || gonavi_clickhouse_driver

package db

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"

	clickhouse "github.com/ClickHouse/clickhouse-go/v2"
)

const (
	clickHouseLegacyHTTPFormat       = "JSONCompactEachRowWithNamesAndTypes"
	clickHouseLegacyHTTPErrorLimit   = 64 << 10
	clickHouseLegacyHTTPUserAgent    = "GoNavi ClickHouse legacy HTTP client"
	clickHouseLegacyHTTPDatabaseName = "database"
)

// clickHouseLegacyHTTPClient is used only after the current clickhouse-go HTTP
// handshake proves that the server predates client_protocol_version support.
// JSON avoids decoding Native blocks with a wire revision the driver cannot
// negotiate with those servers.
type clickHouseLegacyHTTPClient struct {
	endpoint  *url.URL
	http      *http.Client
	transport *http.Transport
	username  string
	password  string
	headers   http.Header
	params    url.Values
}

func newClickHouseLegacyHTTPClient(opts *clickhouse.Options) (*clickHouseLegacyHTTPClient, error) {
	if opts == nil {
		return nil, fmt.Errorf("ClickHouse legacy HTTP options are required")
	}
	if len(opts.Addr) == 0 || strings.TrimSpace(opts.Addr[0]) == "" {
		return nil, fmt.Errorf("ClickHouse legacy HTTP address is required")
	}

	scheme := "http"
	if opts.TLS != nil {
		scheme = "https"
	}
	path := strings.TrimSpace(opts.HttpUrlPath)
	if path != "" && !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	endpoint := &url.URL{
		Scheme: scheme,
		Host:   strings.TrimSpace(opts.Addr[0]),
		Path:   path,
	}

	proxy := http.ProxyFromEnvironment
	if opts.HTTPProxyURL != nil {
		proxy = http.ProxyURL(opts.HTTPProxyURL)
	}
	transport := &http.Transport{
		Proxy:                 proxy,
		DialContext:           (&net.Dialer{Timeout: opts.DialTimeout}).DialContext,
		MaxIdleConns:          1,
		MaxConnsPerHost:       opts.HttpMaxConnsPerHost,
		IdleConnTimeout:       opts.ConnMaxLifetime,
		ResponseHeaderTimeout: opts.ReadTimeout,
		TLSClientConfig:       opts.TLS,
		DisableCompression:    true,
	}
	if opts.DialContext != nil {
		transport.DialContext = func(ctx context.Context, _, address string) (net.Conn, error) {
			return opts.DialContext(ctx, address)
		}
	}

	params := make(url.Values, len(opts.Settings)+1)
	if database := strings.TrimSpace(opts.Auth.Database); database != "" {
		params.Set(clickHouseLegacyHTTPDatabaseName, database)
	}
	for key, value := range opts.Settings {
		key = strings.TrimSpace(key)
		if key == "" || strings.EqualFold(key, "default_format") || strings.EqualFold(key, "client_protocol_version") {
			continue
		}
		if custom, ok := value.(clickhouse.CustomSetting); ok {
			value = custom.Value
		}
		params.Set(key, fmt.Sprint(value))
	}

	headers := make(http.Header, len(opts.HttpHeaders)+2)
	for key, value := range opts.HttpHeaders {
		headers.Set(key, value)
	}
	headers.Set("User-Agent", clickHouseLegacyHTTPUserAgent)
	headers.Set("Content-Type", "text/plain; charset=utf-8")

	return &clickHouseLegacyHTTPClient{
		endpoint: endpoint,
		http: &http.Client{
			Transport: transport,
		},
		transport: transport,
		username:  opts.Auth.Username,
		password:  opts.Auth.Password,
		headers:   headers,
		params:    params,
	}, nil
}

func (c *clickHouseLegacyHTTPClient) Close() error {
	if c != nil && c.transport != nil {
		c.transport.CloseIdleConnections()
	}
	return nil
}

func (c *clickHouseLegacyHTTPClient) Ping(ctx context.Context) error {
	rows, _, err := c.Query(ctx, "SELECT currentDatabase()")
	if err != nil {
		return err
	}
	if len(rows) == 0 {
		return fmt.Errorf("ClickHouse legacy HTTP validation returned no rows")
	}
	return nil
}

// errRowBudgetExhausted 在流式解码达到行预算时由受限 collector 返回，
// 用于立即停止读取响应体，Query 侧将其转换为正常截断返回。
var errRowBudgetExhausted = errors.New("row budget exhausted")

func (c *clickHouseLegacyHTTPClient) Query(ctx context.Context, query string) ([]map[string]interface{}, []string, error) {
	collector := &clickHouseLegacyHTTPCollector{}
	var consumer QueryStreamConsumer = collector
	if budget := RowBudgetFromContext(ctx); budget != nil {
		consumer = &clickHouseLegacyHTTPBudgetCollector{collector: collector, budget: budget}
	}
	if err := c.StreamQuery(ctx, query, consumer); err != nil && !errors.Is(err, errRowBudgetExhausted) {
		return collector.rows, collector.columns, err
	}
	return collector.rows, collector.columns, nil
}

func (c *clickHouseLegacyHTTPClient) StreamQuery(ctx context.Context, query string, consumer QueryStreamConsumer) error {
	if consumer == nil {
		return fmt.Errorf("query stream consumer required")
	}
	response, err := c.do(ctx, query, false)
	if err != nil {
		return err
	}
	defer response.Body.Close()

	decoder := json.NewDecoder(response.Body)
	decoder.UseNumber()

	var columns []string
	if err := decoder.Decode(&columns); err != nil {
		return c.decodeError(decoder, response.Body, "column names", err)
	}
	if len(columns) == 0 {
		return fmt.Errorf("ClickHouse legacy HTTP response has no columns")
	}
	columns = ensureUniqueQueryColumnNames(columns)

	var typeNames []string
	if err := decoder.Decode(&typeNames); err != nil {
		return c.decodeError(decoder, response.Body, "column types", err)
	}
	if len(typeNames) != len(columns) {
		return fmt.Errorf("ClickHouse legacy HTTP column metadata mismatch: names=%d types=%d", len(columns), len(typeNames))
	}
	if err := consumer.SetColumns(columns); err != nil {
		return err
	}
	valueConsumer, useValueConsumer := consumer.(QueryStreamValueConsumer)

	for {
		var values []interface{}
		err := decoder.Decode(&values)
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return c.decodeError(decoder, response.Body, "row", err)
		}
		if len(values) != len(columns) {
			return fmt.Errorf("ClickHouse legacy HTTP row width mismatch: columns=%d values=%d", len(columns), len(values))
		}
		for index := range values {
			values[index] = normalizeQueryValueWithDBType(values[index], typeNames[index])
		}
		if useValueConsumer {
			if err := valueConsumer.ConsumeRowValues(values); err != nil {
				return err
			}
			continue
		}
		row := make(map[string]interface{}, len(columns))
		for index, column := range columns {
			row[column] = values[index]
		}
		if err := consumer.ConsumeRow(row); err != nil {
			return err
		}
	}
}

func (c *clickHouseLegacyHTTPClient) Exec(ctx context.Context, query string) (int64, error) {
	response, err := c.do(ctx, query, true)
	if err != nil {
		return 0, err
	}
	defer response.Body.Close()

	body, readErr := io.ReadAll(io.LimitReader(response.Body, clickHouseLegacyHTTPErrorLimit+1))
	if readErr != nil {
		return 0, readErr
	}
	if exception := clickHouseLegacyHTTPException(body); exception != "" {
		return 0, fmt.Errorf("%s", exception)
	}
	// clickhouse-go also reports zero because ClickHouse does not provide a
	// database/sql affected-row count for ordinary HTTP executions.
	return 0, nil
}

func (c *clickHouseLegacyHTTPClient) do(ctx context.Context, query string, waitForEnd bool) (*http.Response, error) {
	if c == nil || c.endpoint == nil || c.http == nil {
		return nil, fmt.Errorf("ClickHouse legacy HTTP connection is not open")
	}
	requestURL := *c.endpoint
	params := cloneURLValues(c.params)
	params.Set("default_format", clickHouseLegacyHTTPFormat)
	params.Del("client_protocol_version")
	if waitForEnd {
		params.Set("wait_end_of_query", "1")
	}
	requestURL.RawQuery = params.Encode()

	request, err := http.NewRequestWithContext(ctx, http.MethodPost, requestURL.String(), strings.NewReader(query))
	if err != nil {
		return nil, err
	}
	request.Header = c.headers.Clone()
	if c.username != "" || c.password != "" {
		request.SetBasicAuth(c.username, c.password)
	}

	response, err := c.http.Do(request)
	if err != nil {
		return nil, err
	}
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		defer response.Body.Close()
		body, _ := io.ReadAll(io.LimitReader(response.Body, clickHouseLegacyHTTPErrorLimit))
		detail := clickHouseLegacyHTTPException(body)
		if detail == "" {
			detail = strings.TrimSpace(string(body))
		}
		if detail == "" {
			detail = response.Status
		}
		return nil, fmt.Errorf("ClickHouse legacy HTTP request failed: status=%d detail=%s", response.StatusCode, detail)
	}
	if code := strings.TrimSpace(response.Header.Get("X-ClickHouse-Exception-Code")); code != "" && code != "0" {
		defer response.Body.Close()
		body, _ := io.ReadAll(io.LimitReader(response.Body, clickHouseLegacyHTTPErrorLimit))
		detail := clickHouseLegacyHTTPException(body)
		if detail == "" {
			detail = strings.TrimSpace(string(body))
		}
		return nil, fmt.Errorf("ClickHouse legacy HTTP exception code=%s detail=%s", code, detail)
	}
	return response, nil
}

func (c *clickHouseLegacyHTTPClient) decodeError(decoder *json.Decoder, body io.Reader, section string, decodeErr error) error {
	var tail []byte
	if decoder != nil {
		tail, _ = io.ReadAll(io.LimitReader(io.MultiReader(decoder.Buffered(), body), clickHouseLegacyHTTPErrorLimit))
	}
	if exception := clickHouseLegacyHTTPException(tail); exception != "" {
		return fmt.Errorf("%s", exception)
	}
	return fmt.Errorf("decode ClickHouse legacy HTTP %s: %w", section, decodeErr)
}

func clickHouseLegacyHTTPException(raw []byte) string {
	text := sanitizeClickHouseErrorMessage(errors.New(strings.TrimSpace(string(raw))))
	if text == "" {
		return ""
	}
	lower := strings.ToLower(text)
	if strings.Contains(lower, "db::exception") ||
		(strings.Contains(lower, "code:") && strings.Contains(lower, "exception")) {
		return text
	}
	return ""
}

func cloneURLValues(source url.Values) url.Values {
	result := make(url.Values, len(source))
	for key, values := range source {
		result[key] = append([]string(nil), values...)
	}
	return result
}

type clickHouseLegacyHTTPCollector struct {
	columns []string
	rows    []map[string]interface{}
}

func (c *clickHouseLegacyHTTPCollector) SetColumns(columns []string) error {
	c.columns = append([]string(nil), columns...)
	return nil
}

func (c *clickHouseLegacyHTTPCollector) ConsumeRow(row map[string]interface{}) error {
	c.rows = append(c.rows, row)
	return nil
}

// clickHouseLegacyHTTPBudgetCollector 在达到每结果集行数上限后停止消费，
// 让流式解码循环提前退出并释放响应体。
type clickHouseLegacyHTTPBudgetCollector struct {
	collector *clickHouseLegacyHTTPCollector
	budget    *RowBudget
	consumed  int
}

func (c *clickHouseLegacyHTTPBudgetCollector) SetColumns(columns []string) error {
	return c.collector.SetColumns(columns)
}

func (c *clickHouseLegacyHTTPBudgetCollector) ConsumeRow(row map[string]interface{}) error {
	maxRows := c.budget.MaxRowsPerResult()
	if maxRows > 0 && c.consumed >= maxRows {
		c.budget.MarkTruncated()
		return errRowBudgetExhausted
	}
	c.consumed++
	return c.collector.ConsumeRow(row)
}
