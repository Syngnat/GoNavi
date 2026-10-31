package main

import (
	"fmt"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
)

// Hive sends names and types via two callbacks, but consumers must receive one
// atomic metadata frame. Keep the legacy writer unchanged for other drivers.
type hiveAgentStreamConsumer struct {
	target *agentStreamResponseWriter
	names  []string
	set    bool
	sent   bool
}

func hiveAgentStreamSink(target *agentStreamResponseWriter) db.QueryStreamConsumer {
	if agentDriverType == "hive" {
		return &hiveAgentStreamConsumer{target: target}
	}
	return target
}
func (c *hiveAgentStreamConsumer) SetColumns(columns []string) error {
	if c.set || c.sent {
		return fmt.Errorf("Hive query metadata was provided more than once")
	}
	c.set = true
	c.names = append([]string(nil), columns...)
	return nil
}
func (c *hiveAgentStreamConsumer) SetColumnDefinitions(columns []connection.ColumnDefinition) error {
	if !c.set || c.sent || len(columns) != len(c.names) {
		return fmt.Errorf("invalid Hive typed stream metadata order")
	}
	c.target.columns = append([]string(nil), c.names...)
	c.sent = true
	return c.target.writer.write(agentResponse{ID: c.target.requestID, Success: true, ChunkType: agentChunkColumns, Fields: c.names, Data: columns})
}
func (c *hiveAgentStreamConsumer) ensureColumns() error {
	if c.sent {
		return nil
	}
	if !c.set {
		return fmt.Errorf("Hive rows arrived before query metadata")
	}
	c.sent = true
	return c.target.SetColumns(c.names)
}
func (c *hiveAgentStreamConsumer) ConsumeRow(row map[string]interface{}) error {
	if err := c.ensureColumns(); err != nil {
		return err
	}
	return c.target.ConsumeRow(row)
}
func (c *hiveAgentStreamConsumer) ConsumeRowValues(values []interface{}) error {
	if err := c.ensureColumns(); err != nil {
		return err
	}
	return c.target.ConsumeRowValues(values)
}
