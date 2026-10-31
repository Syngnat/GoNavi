import type { JobSnapshot, JobTarget } from './jobManagementTypes';
import { guid, mysqlText, numericID, pgText, required, sqlText } from './jobManagementSQL';
import { kingbaseSchedulerRelation } from './jobPostgresQueries';

const KINGBASE_SCHEDULER_HISTORY_VIEW = kingbaseSchedulerRelation('all_scheduler_job_run_details');

export const jobHistorySQL = (target: JobTarget, snapshot: JobSnapshot): string => {
  const { kind, name, owner } = target;
  if (kind === 'oracle-scheduler' || kind === 'oceanbase-oracle') {
    const view = kind === 'oracle-scheduler' ? 'ALL_SCHEDULER_JOB_RUN_DETAILS' : 'SYS.DBA_SCHEDULER_JOB_RUN_DETAILS';
    return `SELECT * FROM (SELECT LOG_ID, LOG_DATE, OWNER, JOB_NAME, STATUS, ERROR#, REQ_START_DATE, ACTUAL_START_DATE, RUN_DURATION, ADDITIONAL_INFO FROM ${view} WHERE OWNER = ${sqlText(owner)} AND JOB_NAME = ${sqlText(name)} ORDER BY LOG_ID DESC) WHERE ROWNUM <= 200`;
  }
  if (kind === 'kingbase-scheduler') return `SELECT * FROM (SELECT * FROM ${KINGBASE_SCHEDULER_HISTORY_VIEW} WHERE JOB_NAME = ${pgText(name)} ORDER BY LOG_ID DESC) history LIMIT 200`;
  if (kind === 'dm-agent') return `SELECT * FROM (SELECT j.EXEC_ID, j.NAME, j.START_TIME, j.END_TIME, j.ERRCODE, j.ERRINFO, s.STEPNAME, s.START_TIME AS step_start_time, s.END_TIME AS step_end_time, s.ERRCODE AS step_error_code, s.ERRINFO AS step_error_info, s.RETRY_ATTEMPTS FROM SYSJOB.SYSJOBHISTORIES2 j LEFT JOIN SYSJOB.SYSSTEPHISTORIES2 s ON s.EXEC_ID = j.EXEC_ID AND s.JOBID = j.JOBID WHERE j.JOBID = ${numericID(required(snapshot.job, 'job_id'))} ORDER BY j.START_TIME DESC, s.START_TIME DESC) WHERE ROWNUM <= 200`;
  if (kind === 'sqlserver-agent') return `SELECT TOP (200) instance_id, step_id, step_name, sql_message_id, sql_severity, message, run_status, run_date, run_time, run_duration, retries_attempted FROM msdb.dbo.sysjobhistory WHERE job_id = ${guid(name)} ORDER BY instance_id DESC`;
  if (kind === 'pg-cron') return `SELECT runid, jobid, job_pid, database, username, status, return_message, start_time, end_time FROM cron.job_run_details WHERE jobid = ${numericID(name)} ORDER BY runid DESC LIMIT 200`;
  if (kind === 'pgagent') return `SELECT j.jlgid, j.jlgstatus, j.jlgstart, j.jlgduration, s.jslid, s.jsljstid, s.jslstatus, s.jslresult, s.jslstart, s.jslduration, s.jsloutput FROM pgagent.pga_joblog j LEFT JOIN pgagent.pga_jobsteplog s ON s.jsljlgid = j.jlgid WHERE j.jlgjobid = ${numericID(name)} ORDER BY j.jlgid DESC, s.jslid DESC LIMIT 200`;
  if (kind === 'doris-job') return `SELECT * FROM tasks('type'='insert') WHERE JobId = ${numericID(name)} ORDER BY CreateTime DESC LIMIT 200`;
  if (kind === 'starrocks-task') return `SELECT * FROM information_schema.task_runs WHERE TASK_NAME = ${mysqlText(name)} AND \`DATABASE\` = ${mysqlText(target.database)} ORDER BY CREATE_TIME DESC LIMIT 200`;
  return '';
};
