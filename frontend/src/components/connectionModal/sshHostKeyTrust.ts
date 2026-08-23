export type SSHHostKeyTrustDetails = {
  state: "unknown" | "changed";
  source: string;
  host: string;
  port: number;
  address: string;
  keyType: string;
  fingerprint: string;
  previousFingerprint: string;
};

const asNonEmptyString = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

/**
 * Reads the public, non-secret identity returned by the backend when an SSH
 * server is unknown or presents a changed host key. Invalid payloads stay on
 * the ordinary connection-failure path instead of opening a misleading trust
 * dialog.
 */
export const readSSHHostKeyTrustDetails = (
  data: unknown,
): SSHHostKeyTrustDetails | null => {
  if (!data || typeof data !== "object") return null;
  const raw = (data as Record<string, unknown>).sshHostKeyTrust;
  if (!raw || typeof raw !== "object") return null;
  const status = raw as Record<string, unknown>;
  const state = asNonEmptyString(status.state);
  const host = asNonEmptyString(status.host);
  const keyType = asNonEmptyString(status.keyType);
  const fingerprint = asNonEmptyString(status.fingerprint);
  const port = Number(status.port);
  if (
    (state !== "unknown" && state !== "changed") ||
    host === "" ||
    keyType === "" ||
    fingerprint === "" ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    return null;
  }
  return {
    state,
    source: asNonEmptyString(status.source),
    host,
    port,
    address: asNonEmptyString(status.address) || `${host}:${port}`,
    keyType,
    fingerprint,
    previousFingerprint: asNonEmptyString(status.previousFingerprint),
  };
};
