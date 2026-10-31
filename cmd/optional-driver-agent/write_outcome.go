package main

import "GoNavi-Wails/internal/db"

// failWithWriteOutcome preserves the no-replay marker across the JSON boundary.
// A live host context does not prove that a lost server acknowledgement rejected
// a write; pinned SQL-file sessions need the same contract as ApplyChanges.
func failWithWriteOutcome(response agentResponse, err error) agentResponse {
	if err == nil {
		return response
	}
	response = fail(response, err.Error())
	response.OutcomeUnknown = db.IsWriteOutcomeUnknown(err)
	return response
}
