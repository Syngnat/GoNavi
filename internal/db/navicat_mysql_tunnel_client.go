package db

import (
	"context"
	"database/sql/driver"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"GoNavi-Wails/internal/connection"
)

func (c *navicatMySQLTunnelClient) ping(ctx context.Context) error {
	body, err := c.post(ctx, "C", nil)
	if err != nil {
		return err
	}
	parser := &navicatMySQLTunnelParser{body: body}
	if _, err := parser.parseCommonHeader(); err != nil {
		return err
	}
	for index := 0; index < 3; index++ {
		if _, err := parser.parseBlock(); err != nil {
			return fmt.Errorf("Navicat HTTP 隧道连接信息响应不完整：%w", err)
		}
	}
	return nil
}

func (c *navicatMySQLTunnelClient) query(ctx context.Context, query string) (*navicatMySQLTunnelResult, error) {
	results, err := c.queryBatch(ctx, []string{query})
	if err != nil {
		return nil, err
	}
	if len(results) != 1 {
		return nil, fmt.Errorf("Navicat HTTP 隧道返回结果数异常：收到 %d，预期 1", len(results))
	}
	return results[0], nil
}

func (c *navicatMySQLTunnelClient) queryBatch(ctx context.Context, queries []string) ([]*navicatMySQLTunnelResult, error) {
	filtered := make([]string, 0, len(queries))
	for _, query := range queries {
		if strings.TrimSpace(query) != "" {
			filtered = append(filtered, query)
		}
	}
	if len(filtered) == 0 {
		return nil, errors.New("Navicat HTTP 隧道查询内容不能为空")
	}
	body, err := c.post(ctx, "Q", filtered)
	if err != nil {
		return nil, err
	}
	parser := &navicatMySQLTunnelParser{body: body}
	if _, err := parser.parseCommonHeader(); err != nil {
		return nil, err
	}
	results := make([]*navicatMySQLTunnelResult, 0, len(filtered))
	for index := range filtered {
		result, resultErr := parser.parseResult()
		if resultErr != nil {
			return results, fmt.Errorf("Navicat HTTP 隧道第 %d/%d 条查询失败：%w", index+1, len(filtered), resultErr)
		}
		results = append(results, result)
		marker, markerErr := parser.readByte()
		if markerErr != nil {
			return results, fmt.Errorf("Navicat HTTP 隧道第 %d/%d 条结果缺少结束标记：%w", index+1, len(filtered), markerErr)
		}
		expectedMarker := byte(1)
		if index == len(filtered)-1 {
			expectedMarker = 0
		}
		if marker != expectedMarker {
			return results, fmt.Errorf("Navicat HTTP 隧道第 %d/%d 条结果分隔标记异常：收到 0x%02x，预期 0x%02x", index+1, len(filtered), marker, expectedMarker)
		}
	}
	if parser.offset != len(parser.body) {
		return results, fmt.Errorf("Navicat HTTP 隧道响应包含 %d 个未解析字节", len(parser.body)-parser.offset)
	}
	return results, nil
}

func navicatMySQLTunnelResultSets(results []*navicatMySQLTunnelResult, budget *RowBudget) []connection.ResultSetData {
	if results == nil {
		return nil
	}
	converted := make([]connection.ResultSetData, 0, len(results))
	for resultIndex, result := range results {
		if result == nil {
			continue
		}
		if len(result.fields) == 0 {
			converted = append(converted, connection.ResultSetData{
				Rows:           []map[string]interface{}{{"affectedRows": result.affectedRows}},
				Columns:        []string{"affectedRows"},
				StatementIndex: resultIndex + 1,
			})
			continue
		}
		columns := make([]string, len(result.fields))
		for index := range result.fields {
			columns[index] = result.fields[index].name
		}
		columns = ensureUniqueQueryColumnNames(columns)
		maxRows := budget.MaxRowsPerResult()
		rowCount := len(result.rows)
		truncated := maxRows > 0 && rowCount > maxRows
		if truncated {
			rowCount = maxRows
			budget.MarkTruncated()
		}
		rows := make([]map[string]interface{}, 0, rowCount)
		for rowIndex := 0; rowIndex < rowCount; rowIndex++ {
			row := result.rows[rowIndex]
			entry := make(map[string]interface{}, len(columns))
			for columnIndex, column := range columns {
				var value driver.Value
				if columnIndex < len(row) {
					value = row[columnIndex]
				}
				// 该隧道只连接 MySQL，Oracle 文本大对象分支不会命中，保留原有预览上限。
				entry[column] = normalizeInteractiveQueryValue(
					value,
					result.fields[columnIndex].databaseTy,
					"mysql",
					interactiveOracleLargeObjectPreviewBytes,
				)
			}
			rows = append(rows, entry)
		}
		converted = append(converted, connection.ResultSetData{
			Rows:           rows,
			Columns:        columns,
			Truncated:      truncated,
			StatementIndex: resultIndex + 1,
		})
		if truncated {
			break
		}
	}
	return converted
}

func (c *navicatMySQLTunnelClient) post(ctx context.Context, action string, queries []string) ([]byte, error) {
	form := url.Values{}
	form.Set("actn", action)
	form.Set("host", c.host)
	form.Set("port", strconv.Itoa(c.port))
	form.Set("login", c.login)
	form.Set("password", c.password)
	form.Set("db", c.database)
	if len(queries) > 0 {
		if c.base64SQL {
			form.Set("encodeBase64", "1")
		}
		for _, query := range queries {
			if c.base64SQL {
				query = base64.StdEncoding.EncodeToString([]byte(query))
			}
			form.Add("q[]", query)
		}
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.endpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return nil, fmt.Errorf("创建 Navicat HTTP 隧道请求失败：%w", err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept-Encoding", "identity")
	if c.webUser != "" || c.webPass != "" {
		req.SetBasicAuth(c.webUser, c.webPass)
	}

	response, err := c.httpClient.Do(req)
	if err != nil {
		// http.Client.Do and a custom RoundTripper can each wrap the failure in
		// url.Error. Unwrap the complete chain because every layer's Error text
		// includes the endpoint, whose query string may contain access tokens.
		for {
			requestErr, ok := err.(*url.Error)
			if !ok || requestErr.Err == nil {
				break
			}
			err = requestErr.Err
		}
		return nil, fmt.Errorf("请求 Navicat HTTP 隧道失败：%w", err)
	}
	defer response.Body.Close()
	body, readErr := io.ReadAll(io.LimitReader(response.Body, maxNavicatMySQLTunnelResponseBytes+1))
	if readErr != nil {
		return nil, fmt.Errorf("读取 Navicat HTTP 隧道响应失败：%w", readErr)
	}
	if len(body) > maxNavicatMySQLTunnelResponseBytes {
		return nil, fmt.Errorf("Navicat HTTP 隧道响应超过 %d MiB 限制", maxNavicatMySQLTunnelResponseBytes>>20)
	}
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return nil, fmt.Errorf("Navicat HTTP 隧道返回 HTTP %d：%s", response.StatusCode, navicatMySQLTunnelResponseSnippet(body))
	}
	return body, nil
}

func navicatMySQLTunnelResponseSnippet(body []byte) string {
	const maxSnippetBytes = 200
	if len(body) > maxSnippetBytes {
		body = body[:maxSnippetBytes]
	}
	text := strings.Join(strings.Fields(string(body)), " ")
	if text == "" {
		return "空响应"
	}
	return text
}
