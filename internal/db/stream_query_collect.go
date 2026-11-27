package db

import (
	"context"
	"errors"
	"fmt"
)

var errStreamQueryBudgetExhausted = errors.New("stream query row budget exhausted")

// CollectStreamQueryWithBudget executes streamer.StreamQueryContext and gathers
// streamed rows under the active RowBudget. When a row or total-byte budget is
// reached, it cancels the derived stream context so supporting backends stop
// early and returns the collected prefix without error unless the parent
// context itself was canceled.
func CollectStreamQueryWithBudget(
	ctx context.Context,
	streamer StreamQueryExecer,
	query string,
	budget *RowBudget,
) ([]map[string]interface{}, []string, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return nil, nil, err
	}
	if streamer == nil {
		return nil, nil, fmt.Errorf("stream query executor required")
	}
	if budget == nil {
		budget = RowBudgetFromContext(ctx)
	}

	streamCtx, cancelStream := context.WithCancel(ctx)
	defer cancelStream()

	collector := &budgetedStreamQueryCollector{
		budget:       budget,
		cancelStream: cancelStream,
		rows:         make([]map[string]interface{}, 0, initialResultRowCapacity),
	}
	err := streamer.StreamQueryContext(streamCtx, query, collector)
	if err != nil {
		if collector.budgetExhausted && ctx.Err() == nil {
			return collector.rows, collector.nonNilColumns(), nil
		}
		return nil, nil, err
	}
	return collector.rows, collector.nonNilColumns(), nil
}

type budgetedStreamQueryCollector struct {
	budget          *RowBudget
	cancelStream    context.CancelFunc
	columns         []string
	rows            []map[string]interface{}
	budgetExhausted bool
}

var (
	_ QueryStreamConsumer      = (*budgetedStreamQueryCollector)(nil)
	_ QueryStreamValueConsumer = (*budgetedStreamQueryCollector)(nil)
)

func (c *budgetedStreamQueryCollector) SetColumns(columns []string) error {
	c.columns = append([]string(nil), columns...)
	return nil
}

func (c *budgetedStreamQueryCollector) ConsumeRow(row map[string]interface{}) error {
	if !c.budget.CanMaterializeRow(len(c.rows)) {
		c.stopForBudget()
		return errStreamQueryBudgetExhausted
	}
	entry := make(map[string]interface{}, len(row))
	for key, value := range row {
		entry[key] = value
	}
	return c.appendEntry(entry)
}

func (c *budgetedStreamQueryCollector) ConsumeRowValues(values []interface{}) error {
	if !c.budget.CanMaterializeRow(len(c.rows)) {
		c.stopForBudget()
		return errStreamQueryBudgetExhausted
	}
	entry := make(map[string]interface{}, len(c.columns))
	for index, column := range c.columns {
		if index < len(values) {
			entry[column] = values[index]
		} else {
			entry[column] = nil
		}
	}
	return c.appendEntry(entry)
}

func (c *budgetedStreamQueryCollector) appendEntry(entry map[string]interface{}) error {
	entry, fieldTruncated := boundQueryRowFields(entry, c.budget.MaxFieldBytes())
	if fieldTruncated {
		c.budget.MarkFieldTruncated()
	}
	if !c.budget.ConsumeRow(estimateQueryRowBytes(entry)) {
		c.stopForBudget()
		return errStreamQueryBudgetExhausted
	}
	c.rows = append(c.rows, entry)
	return nil
}

func (c *budgetedStreamQueryCollector) stopForBudget() {
	c.budgetExhausted = true
	if c.cancelStream != nil {
		c.cancelStream()
	}
}

func (c *budgetedStreamQueryCollector) nonNilColumns() []string {
	if c.columns == nil {
		return []string{}
	}
	return c.columns
}
