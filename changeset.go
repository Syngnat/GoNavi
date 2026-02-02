package main

type UpdateRow struct {
	Keys   map[string]interface{} `json:"keys"`
	Values map[string]interface{} `json:"values"`
}

type ChangeSet struct {
	Inserts []map[string]interface{} `json:"inserts"`
	Updates []UpdateRow              `json:"updates"`
	Deletes []map[string]interface{} `json:"deletes"`
}
