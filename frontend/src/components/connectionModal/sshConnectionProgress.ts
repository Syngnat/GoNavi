export type SSHConnectionProgressStatus =
  | "pending"
  | "running"
  | "success"
  | "error";

export type SSHConnectionProgressStepID =
  | "transport"
  | "host-key"
  | "authentication"
  | "tunnel"
  | "database";

export type SSHConnectionProgressStep = {
  id: SSHConnectionProgressStepID;
  status: SSHConnectionProgressStatus;
};

export type SSHConnectionProgressEvent = {
  runId?: string;
  stage?: string;
  status?: string;
};

export type SSHConnectionProgressLog = {
  stage: string;
  status: SSHConnectionProgressStatus;
  detail?: string;
};

export type SSHConnectionProgress = {
  runId: string;
  host: string;
  port: number;
  status: SSHConnectionProgressStatus;
  steps: SSHConnectionProgressStep[];
  logs: SSHConnectionProgressLog[];
};

const STEP_IDS: SSHConnectionProgressStepID[] = [
  "transport",
  "host-key",
  "authentication",
  "tunnel",
  "database",
];

const STAGE_TO_STEP: Record<string, SSHConnectionProgressStepID | undefined> = {
  tcp_connecting: "transport",
  tcp_connected: "transport",
  known_hosts_default: "host-key",
  host_key_verifying: "host-key",
  host_key_verified: "host-key",
  authenticating: "authentication",
  authenticated: "authentication",
  ssh_session_reused: "authentication",
  tunnel_creating: "tunnel",
  tunnel_ready: "tunnel",
  database_connecting: "database",
  database_connected: "database",
};

const normalizeStatus = (status: unknown): SSHConnectionProgressStatus => {
  switch (String(status || "").trim().toLowerCase()) {
    case "success":
      return "success";
    case "error":
      return "error";
    case "running":
      return "running";
    default:
      return "running";
  }
};

const appendLog = (
  logs: SSHConnectionProgressLog[],
  entry: SSHConnectionProgressLog,
): SSHConnectionProgressLog[] => {
  const previous = logs[logs.length - 1];
  if (previous?.stage === entry.stage && previous.status === entry.status) {
    const detail = entry.detail || previous.detail;
    if (previous.detail === detail) {
      return logs;
    }
    return [...logs.slice(0, -1), { ...entry, ...(detail ? { detail } : {}) }];
  }
  return [...logs, entry].slice(-64);
};

const setStepStatus = (
  steps: SSHConnectionProgressStep[],
  target: SSHConnectionProgressStepID,
  status: SSHConnectionProgressStatus,
): SSHConnectionProgressStep[] =>
  steps.map((step) =>
    step.id === target ? { ...step, status } : step,
  );

const markPriorStepsSuccessful = (
  steps: SSHConnectionProgressStep[],
  target: SSHConnectionProgressStepID,
): SSHConnectionProgressStep[] => {
  const targetIndex = STEP_IDS.indexOf(target);
  return steps.map((step) => {
    const index = STEP_IDS.indexOf(step.id);
    if (index >= 0 && index < targetIndex && step.status !== "error") {
      return { ...step, status: "success" as const };
    }
    return step;
  });
};

const inferFailureStep = (
  progress: SSHConnectionProgress,
  reason: unknown,
): SSHConnectionProgressStepID | undefined => {
  const message = String(reason || "").toLowerCase();
  if (
    message.includes("host key") ||
    message.includes("known_hosts") ||
    message.includes("fingerprint")
  ) {
    return "host-key";
  }
  if (
    message.includes("authenticate") ||
    message.includes("authentication") ||
    message.includes("permission denied") ||
    message.includes("private key") ||
    message.includes("passphrase")
  ) {
    return "authentication";
  }
  if (message.includes("tunnel") || message.includes("forwarder")) {
    return "tunnel";
  }
  return progress.steps.find((step) => step.status === "running")?.id;
};

export const createSSHConnectionProgress = ({
  runId,
  host,
  port,
}: {
  runId: string;
  host: string;
  port: number;
}): SSHConnectionProgress => ({
  runId,
  host: String(host || "").trim(),
  port: Number(port) || 22,
  status: "running",
  steps: STEP_IDS.map((id) => ({
    id,
    status: "pending",
  })),
  logs: [{ stage: "preparing", status: "running" }],
});

export const applySSHConnectionProgressEvent = (
  progress: SSHConnectionProgress,
  event: SSHConnectionProgressEvent,
): SSHConnectionProgress => {
  const runId = String(event?.runId || "").trim();
  if (!progress || !runId || runId !== progress.runId) {
    return progress;
  }
  const stage = String(event?.stage || "").trim();
  if (!stage) {
    return progress;
  }
  const status = normalizeStatus(event?.status);
  const target = STAGE_TO_STEP[stage];
  const steps = target
    ? setStepStatus(
        status === "success"
          ? markPriorStepsSuccessful(progress.steps, target)
          : progress.steps,
        target,
        status,
      )
    : progress.steps;
  return {
    ...progress,
    status: status === "error" ? "error" : progress.status,
    steps,
    logs: appendLog(progress.logs, { stage, status }),
  };
};

export const finishSSHConnectionProgress = (
  progress: SSHConnectionProgress,
  result: { success: boolean; reason?: unknown },
): SSHConnectionProgress => {
  if (result.success) {
    return {
      ...progress,
      status: "success",
      steps: progress.steps.map((step) => ({ ...step, status: "success" })),
      logs: appendLog(progress.logs, { stage: "completed", status: "success" }),
    };
  }

  const target = inferFailureStep(progress, result.reason);
  // A final RPC error can arrive before any live desktop event (for example
  // while a private key is read). Do not paint earlier stages green unless
  // they actually reported success.
  const detail = String(result.reason || "").trim();
  const steps = target
    ? setStepStatus(progress.steps, target, "error")
    : progress.steps;
  return {
    ...progress,
    status: "error",
    steps,
    logs: appendLog(progress.logs, {
      stage: "failed",
      status: "error",
      ...(detail ? { detail } : {}),
    }),
  };
};
