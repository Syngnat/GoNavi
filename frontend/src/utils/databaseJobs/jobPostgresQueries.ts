import type { DatabaseJobKind } from '../../typeDefs/databaseJobTypes';
import { isJobID, jobLiteral, postgresJobCatalogProbe, type DatabaseJobChildQueries, type DatabaseJobQueryGroup } from './jobQueryTypes';

// Catalogs are read in their installation database, not guessed from a target database or schema.
export const postgresJobListQueries = (): DatabaseJobQueryGroup[] => [
  {
    kind: 'pg-cron', probeQueries: [postgresJobCatalogProbe('cron', 'job')],
    queries: [
      'SELECT jobid::text AS job_name, jobname AS job_label, active AS enabled FROM cron.job ORDER BY jobid',
      'SELECT jobid::text AS job_name, active AS enabled FROM cron.job ORDER BY jobid',
      'SELECT jobid::text AS job_name FROM cron.job ORDER BY jobid',
    ],
  },
  {
    kind: 'pgagent', probeQueries: [postgresJobCatalogProbe('pgagent', 'pga_job')],
    queries: ['SELECT jobid::text AS job_name, jobname AS job_label, jobenabled AS enabled, jobnextrun AS next_run_at FROM pgagent.pga_job ORDER BY jobname, jobid'],
  },
];

export const postgresJobDefinitionQueries = (kind: DatabaseJobKind, id: string): string[] => {
  if (!isJobID(id)) return [];
  if (kind === 'pg-cron') {
    const fields = 'jobid AS job_id, jobid::text AS job_name, schedule AS repeat_interval, command AS action, database AS database_name, username AS owner';
    return [
      `SELECT ${fields}, jobname AS job_label, active AS enabled FROM cron.job WHERE jobid = ${id}`,
      `SELECT ${fields}, active AS enabled FROM cron.job WHERE jobid = ${id}`,
      `SELECT ${fields} FROM cron.job WHERE jobid = ${id}`,
    ];
  }
  if (kind === 'pgagent') return [
    `SELECT jobid AS job_id, jobid::text AS job_name, jobname AS job_label, jobenabled AS enabled, jobnextrun AS next_run_at, joblastrun AS last_start_date, jobcreated AS create_time, jobdesc AS comments, jobhostagent FROM pgagent.pga_job WHERE jobid = ${id}`,
  ];
  return [];
};

export const pgAgentChildQueries = (id: string): DatabaseJobChildQueries => !isJobID(id) ? {} : ({
  // Never SELECT * here: jstconnstr may contain passwords. pgAgent executes steps in name order.
  steps: [`SELECT jstid AS step_id, jstname AS step_name, jstkind AS step_type, jstenabled AS enabled, jstcode AS action, jstdbname AS database_name, jstonerror AS failure_action, jstdesc AS comments FROM pgagent.pga_jobstep WHERE jstjobid = ${id} ORDER BY jstname, jstid`],
  schedules: [`SELECT s.jscid AS schedule_id, s.jscname AS schedule_name, s.jscenabled AS enabled, s.jscstart AS start_date, s.jscend AS end_date, s.jscminutes, s.jschours, s.jscweekdays, s.jscmonthdays, s.jscmonths, e.jexdate AS exception_date, e.jextime AS exception_time FROM pgagent.pga_schedule s LEFT JOIN pgagent.pga_exception e ON e.jexscid = s.jscid WHERE s.jscjobid = ${id} ORDER BY s.jscid, e.jexid`],
});

// KDB_SCHEDULE's owner column is documented as NULL. An Oracle OWNER predicate loses every job.
// pg_extension registration is not sufficient: PG-compat databases register kdb_schedule without
// its Oracle-style views, so probe the exact relation the list query resolves instead.
// The views live in the kdb_schedule schema and search_path does not include it (verified on
// KingbaseES V009R001C010 and V009R003C018), so every reference must carry the schema prefix.
export const KINGBASE_SCHEDULER_SCHEMA = 'kdb_schedule';
export const kingbaseSchedulerRelation = (name: string): string => `${KINGBASE_SCHEDULER_SCHEMA}.${name}`;

export const kingbaseJobListQueries = (): DatabaseJobQueryGroup[] => [{
  kind: 'kingbase-scheduler',
  queries: [`SELECT job_name, enabled, state, next_run_date AS next_run_at FROM ${kingbaseSchedulerRelation('all_scheduler_jobs')} ORDER BY job_name`],
  probeQueries: [`SELECT to_regclass(${jobLiteral(kingbaseSchedulerRelation('all_scheduler_jobs'))}) IS NOT NULL OR to_regclass(${jobLiteral('all_scheduler_jobs')}) IS NOT NULL AS available`],
}];

export const kingbaseJobDefinitionQueries = (name: string): string[] => [
  `SELECT job_name, job_type, job_action AS action, program_name, schedule_name, start_date, repeat_interval, end_date, enabled, state, next_run_date AS next_run_at, comments FROM ${kingbaseSchedulerRelation('all_scheduler_jobs')} WHERE job_name = ${jobLiteral(name)}`,
];
