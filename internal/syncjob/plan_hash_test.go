package syncjob

import "testing"

func TestExecutionPlanHashIgnoresTaskMetadataButTracksDataSemantics(t *testing.T) {
	definition := validValidationTestDefinition()
	definition.ID = "job-1"
	definition.Revision = 4
	definition.Source.Fingerprint = "source-fingerprint"
	definition.Target.Fingerprint = "target-fingerprint"
	base, err := ExecutionPlanHash(definition)
	if err != nil {
		t.Fatalf("hash base plan: %v", err)
	}

	metadata := definition
	metadata.Name = "renamed"
	metadata.Description = "new description"
	metadata.Lifecycle = JobLifecyclePaused
	metadata.Enabled = false
	metadata.Schedule = ScheduleSpec{Kind: ScheduleCron, CronExpression: "0 1 * * *", Timezone: "UTC"}
	metadata.Revision++
	got, err := ExecutionPlanHash(metadata)
	if err != nil {
		t.Fatalf("hash metadata plan: %v", err)
	}
	if got != base {
		t.Fatal("task metadata unexpectedly invalidated the execution plan")
	}

	changed := definition
	changed.Mappings[0].TargetTable = "orders_v2"
	got, err = ExecutionPlanHash(changed)
	if err != nil {
		t.Fatalf("hash changed plan: %v", err)
	}
	if got == base {
		t.Fatal("target mapping change did not invalidate the execution plan")
	}
}

func TestApprovalScopeHashTracksTaskAndUnattendedExecutionPolicy(t *testing.T) {
	definition := validValidationTestDefinition()
	definition.ID = "job-1"
	definition.Lifecycle = JobLifecycleReady
	definition.Enabled = false
	definition.Schedule = ScheduleSpec{Kind: ScheduleManual}
	base, err := ApprovalScopeHash(definition)
	if err != nil {
		t.Fatalf("hash approval scope: %v", err)
	}

	metadata := definition
	metadata.Name = "renamed"
	metadata.Description = "new description"
	metadata.Revision = 99
	metadata.UpdatedAt = 1234
	got, err := ApprovalScopeHash(metadata)
	if err != nil {
		t.Fatalf("hash approval metadata: %v", err)
	}
	if got != base {
		t.Fatal("presentation or persistence metadata unexpectedly invalidated approval")
	}

	for name, mutate := range map[string]func(*JobDefinition){
		"task identity": func(value *JobDefinition) { value.ID = "job-2" },
		"lifecycle": func(value *JobDefinition) {
			value.Lifecycle = JobLifecycleEnabled
			value.Enabled = true
		},
		"schedule": func(value *JobDefinition) {
			value.Schedule = ScheduleSpec{Kind: ScheduleContinuous}
		},
		"concurrency": func(value *JobDefinition) { value.ConcurrencyPolicy = "queue" },
		"resume":      func(value *JobDefinition) { value.ResumePolicy = "auto" },
	} {
		t.Run(name, func(t *testing.T) {
			changed := definition
			mutate(&changed)
			got, hashErr := ApprovalScopeHash(changed)
			if hashErr != nil {
				t.Fatalf("hash changed approval scope: %v", hashErr)
			}
			if got == base {
				t.Fatalf("%s change did not invalidate approval", name)
			}
		})
	}
}
