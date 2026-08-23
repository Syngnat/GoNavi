package syncjob

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
)

// ExecutionPlanHash identifies the data-affecting portion of a definition.
// Task labels, lifecycle, scheduling and revisions deliberately do not move a
// durable cursor; endpoints, mappings, write policy and incremental scope do.
func ExecutionPlanHash(input JobDefinition) (string, error) {
	definition := NormalizeDefinition(input)
	definition.ID = ""
	definition.Name = ""
	definition.Description = ""
	definition.Lifecycle = ""
	definition.Enabled = false
	definition.Source.ConnectionName = ""
	definition.Target.ConnectionName = ""
	definition.Schedule = ScheduleSpec{}
	definition.Approval = nil
	definition.ConcurrencyPolicy = ""
	definition.ResumePolicy = ""
	definition.Revision = 0
	definition.CreatedAt = 0
	definition.UpdatedAt = 0
	definition.NextRunAt = 0
	definition.LastScheduledAt = 0
	definition.ArchivedAt = 0
	return hashJobDefinition(definition)
}

// ApprovalScopeHash identifies the exact operation a user approved. Unlike
// ExecutionPlanHash it deliberately retains task identity, lifecycle,
// scheduling, concurrency and resume policy: approving a manual run must not
// authorize turning the same data plan into an unattended continuous job.
// Only presentation fields, persistence metadata and the approval itself are
// excluded.
func ApprovalScopeHash(input JobDefinition) (string, error) {
	definition := NormalizeDefinition(input)
	definition.Name = ""
	definition.Description = ""
	definition.Source.ConnectionName = ""
	definition.Target.ConnectionName = ""
	definition.Approval = nil
	definition.Revision = 0
	definition.CreatedAt = 0
	definition.UpdatedAt = 0
	definition.NextRunAt = 0
	definition.LastScheduledAt = 0
	definition.ArchivedAt = 0
	return hashJobDefinition(definition)
}

func hashJobDefinition(definition JobDefinition) (string, error) {
	payload, err := json.Marshal(definition)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(payload)
	return "sha256:" + hex.EncodeToString(sum[:]), nil
}
