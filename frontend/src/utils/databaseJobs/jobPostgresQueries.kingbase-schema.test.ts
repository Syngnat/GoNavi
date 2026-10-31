import { describe, expect, it } from 'vitest';
import {
  KINGBASE_SCHEDULER_SCHEMA,
  kingbaseJobDefinitionQueries,
  kingbaseJobListQueries,
  kingbaseSchedulerRelation,
} from './jobPostgresQueries';
import { jobHistorySQL } from './jobHistoryQueries';
import { additionalJobReferences } from './jobReferenceQueries';
import type { JobTarget } from './jobManagementTypes';

// KingbaseES 把 kdb_schedule 的 Oracle 兼容视图建在扩展自己的 schema 下，
// 而 search_path 是 "$user", public，不带前缀的 all_scheduler_jobs 解析不到。
describe('kingbase scheduler relations', () => {
  it('qualifies every scheduler view with the kdb_schedule schema', () => {
    expect(KINGBASE_SCHEDULER_SCHEMA).toBe('kdb_schedule');
    expect(kingbaseSchedulerRelation('all_scheduler_jobs')).toBe('kdb_schedule.all_scheduler_jobs');

    const [group] = kingbaseJobListQueries();
    expect(group.queries[0]).toContain('FROM kdb_schedule.all_scheduler_jobs');
    expect(group.queries[0]).not.toMatch(/FROM\s+all_scheduler_jobs/);

    expect(kingbaseJobDefinitionQueries('nightly')[0]).toContain('FROM kdb_schedule.all_scheduler_jobs');
  });

  it('keeps the probe able to resolve a view exposed through search_path', () => {
    const [group] = kingbaseJobListQueries();
    expect(group.probeQueries?.[0]).toContain("to_regclass('kdb_schedule.all_scheduler_jobs')");
    expect(group.probeQueries?.[0]).toContain("to_regclass('all_scheduler_jobs')");
  });

  it('qualifies the run-detail and reference views', () => {
    const target: JobTarget = {
      dialect: 'kingbase',
      kind: 'kingbase-scheduler',
      database: 'kingbase',
      owner: '',
      name: 'nightly',
    };

    const history = jobHistorySQL(target, { job: { program_name: 'p', schedule_name: 's' } } as never);
    expect(history).toContain('kdb_schedule.all_scheduler_job_run_details');

    const references = additionalJobReferences('kingbase-scheduler', { program_name: 'p', schedule_name: 's' } as never);
    const sql = references.flatMap((reference) => reference.queries).join('\n');
    expect(sql).toContain('kdb_schedule.dba_scheduler_programs');
    expect(sql).toContain('kdb_schedule.dba_scheduler_schedules');
  });
});
