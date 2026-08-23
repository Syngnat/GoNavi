package app

import (
	"encoding/json"

	"GoNavi-Wails/internal/syncjob"
)

func publicDataSyncJobDefinition(definition syncjob.JobDefinition) syncjob.JobDefinition {
	definition.Approval = nil
	definition.Source.Fingerprint = ""
	definition.Target.Fingerprint = ""
	return definition
}

func publicDataSyncJobPreflight(result DataSyncJobPreflightResult) DataSyncJobPreflightResult {
	result.Definition = publicDataSyncJobDefinition(result.Definition)
	result.SourceFingerprint = ""
	result.TargetFingerprint = ""
	return result
}

func publicDataSyncRun(run syncjob.RunRecord) syncjob.RunRecord {
	run.SourceFingerprint = ""
	run.TargetFingerprint = ""
	if len(run.DefinitionSnapshot) == 0 {
		return run
	}
	var definition syncjob.JobDefinition
	if err := json.Unmarshal(run.DefinitionSnapshot, &definition); err != nil {
		// Never return an opaque snapshot we could not prove safe.
		run.DefinitionSnapshot = nil
		return run
	}
	encoded, err := json.Marshal(publicDataSyncJobDefinition(definition))
	if err != nil {
		run.DefinitionSnapshot = nil
		return run
	}
	run.DefinitionSnapshot = encoded
	return run
}

func publicDataSyncRunEvent(event syncjob.RunEvent) syncjob.RunEvent {
	if len(event.Payload) == 0 {
		return event
	}
	switch event.Type {
	case syncjob.RunEventCheckpoint:
		var checkpoint syncjob.Checkpoint
		if err := json.Unmarshal(event.Payload, &checkpoint); err != nil {
			event.Payload = nil
			return event
		}
		checkpoint.SchemaHash = ""
		event.Payload, _ = json.Marshal(checkpoint)
	case syncjob.RunEventErrorRow:
		var payload map[string]interface{}
		if err := json.Unmarshal(event.Payload, &payload); err != nil {
			event.Payload = nil
			return event
		}
		delete(payload, "sourceKey")
		delete(payload, "payload")
		delete(payload, "sourceFingerprint")
		delete(payload, "targetFingerprint")
		delete(payload, "definitionHash")
		delete(payload, "schemaHash")
		event.Payload, _ = json.Marshal(payload)
	}
	return event
}

func publicDataSyncErrorRow(row syncjob.ErrorRow) syncjob.ErrorRow {
	row.SourceKey = nil
	row.Payload = nil
	return row
}
