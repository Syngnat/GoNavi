import type { DatabaseJobKind, DatabaseJobRow } from '../../typeDefs/databaseJobTypes';
import { readDatabaseJobText } from './jobMetadata';
import { jobLiteral } from './jobQueryTypes';
import { kingbaseSchedulerRelation } from './jobPostgresQueries';

type JobReference = { kind: 'program' | 'schedule'; queries: string[] };

export const additionalJobReferences = (kind: DatabaseJobKind, job: DatabaseJobRow): JobReference[] => {
  const program = readDatabaseJobText(job, 'program_name');
  const schedule = readDatabaseJobText(job, 'schedule_name');
  const result: JobReference[] = [];
  if (kind === 'kingbase-scheduler') {
    if (program) result.push({ kind: 'program', queries: [
      `SELECT program_name, program_type AS job_type, program_action AS action, enabled, comments FROM ${kingbaseSchedulerRelation('dba_scheduler_programs')} WHERE program_name = ${jobLiteral(program)}`,
      `SELECT program_name, program_action AS action FROM ${kingbaseSchedulerRelation('dba_scheduler_programs')} WHERE program_name = ${jobLiteral(program)}`,
    ] });
    if (schedule) result.push({ kind: 'schedule', queries: [
      `SELECT schedule_name, start_date, repeat_interval, comments FROM ${kingbaseSchedulerRelation('dba_scheduler_schedules')} WHERE schedule_name = ${jobLiteral(schedule)}`,
      `SELECT schedule_name, repeat_interval FROM ${kingbaseSchedulerRelation('dba_scheduler_schedules')} WHERE schedule_name = ${jobLiteral(schedule)}`,
    ] });
  }
  if (kind === 'oceanbase-oracle' && program && !readDatabaseJobText(job, 'action')) {
    const owner = readDatabaseJobText(job, 'program_owner') || readDatabaseJobText(job, 'schema_name');
    if (owner) result.push({ kind: 'program', queries: [
      `SELECT OWNER AS schema_name, PROGRAM_NAME AS program_name, PROGRAM_TYPE AS job_type, PROGRAM_ACTION AS action, NUMBER_OF_ARGUMENTS AS number_of_arguments FROM SYS.DBA_SCHEDULER_PROGRAM WHERE OWNER = ${jobLiteral(owner)} AND PROGRAM_NAME = ${jobLiteral(program)}`,
    ] });
  }
  return result;
};
