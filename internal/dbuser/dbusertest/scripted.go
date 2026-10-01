// Package dbusertest 提供 dbuser 各 Provider 单测共用的脚本化执行器，
// 以「查询片段 → 结果」的方式模拟 agent 转发后的行数据，不连接真实数据库。
package dbusertest

import (
	"context"
	"errors"
	"strings"
	"sync"

	"GoNavi-Wails/internal/dbuser"
)

// ErrNotScripted 表示查询没有匹配到任何脚本。
var ErrNotScripted = errors.New("dbusertest: query not scripted")

// Response 是一条脚本：查询包含 Match 时返回 Rows 或 Err。
type Response struct {
	Match string
	Rows  []map[string]any
	Err   error
}

// Executor 按脚本顺序匹配查询，记录所有执行过的语句。
type Executor struct {
	mu        sync.Mutex
	responses []Response
	Queries   []string
	Execs     []string
	ExecErr   map[string]error
}

var _ dbuser.Executor = (*Executor)(nil)

// NewExecutor 构造脚本化执行器。
func NewExecutor(responses ...Response) *Executor {
	return &Executor{responses: responses, ExecErr: map[string]error{}}
}

// Query 实现 dbuser.Executor。
func (e *Executor) Query(_ context.Context, database, statement string) ([]map[string]any, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.Queries = append(e.Queries, prefix(database)+statement)
	for _, response := range e.responses {
		if strings.Contains(statement, response.Match) {
			return response.Rows, response.Err
		}
	}
	return nil, ErrNotScripted
}

// Exec 实现 dbuser.Executor。
func (e *Executor) Exec(_ context.Context, database, statement string) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.Execs = append(e.Execs, prefix(database)+statement)
	for match, err := range e.ExecErr {
		if strings.Contains(statement, match) {
			return err
		}
	}
	return nil
}

func prefix(database string) string {
	if database == "" {
		return ""
	}
	return "[" + database + "] "
}

// Row 以键值对构造一行。
func Row(pairs ...any) map[string]any {
	row := make(map[string]any, len(pairs)/2)
	for index := 0; index+1 < len(pairs); index += 2 {
		key, _ := pairs[index].(string)
		row[key] = pairs[index+1]
	}
	return row
}

// Displays 返回计划中所有语句的展示文本。
func Displays(plan dbuser.Plan) []string {
	out := make([]string, 0, len(plan.Statements))
	for _, statement := range plan.Statements {
		out = append(out, statement.Display)
	}
	return out
}

// Execs 返回计划中所有语句的执行文本。
func Execs(plan dbuser.Plan) []string {
	out := make([]string, 0, len(plan.Statements))
	for _, statement := range plan.Statements {
		out = append(out, statement.Exec)
	}
	return out
}
