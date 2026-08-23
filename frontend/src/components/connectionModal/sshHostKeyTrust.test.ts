import { describe, expect, it } from "vitest";

import { readSSHHostKeyTrustDetails } from "./sshHostKeyTrust";

describe("readSSHHostKeyTrustDetails", () => {
  it("accepts the public host-key identity emitted for a first connection", () => {
    expect(
      readSSHHostKeyTrustDetails({
        sshHostKeyTrust: {
          state: "unknown",
          source: "discovered",
          host: "bastion.example.com",
          port: 2222,
          address: "bastion.example.com:2222",
          keyType: "ssh-ed25519",
          fingerprint: "SHA256:example",
        },
      }),
    ).toEqual({
      state: "unknown",
      source: "discovered",
      host: "bastion.example.com",
      port: 2222,
      address: "bastion.example.com:2222",
      keyType: "ssh-ed25519",
      fingerprint: "SHA256:example",
      previousFingerprint: "",
    });
  });

  it("rejects malformed payloads instead of opening a trust dialog", () => {
    expect(readSSHHostKeyTrustDetails({ sshHostKeyTrust: { state: "unknown" } })).toBeNull();
    expect(
      readSSHHostKeyTrustDetails({
        sshHostKeyTrust: {
          state: "trusted",
          host: "bastion.example.com",
          port: 22,
          keyType: "ssh-ed25519",
          fingerprint: "SHA256:example",
        },
      }),
    ).toBeNull();
  });
});
