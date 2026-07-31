import { describe, expect, it } from "vitest";

import {
  formatJVMDiagnosticChunkText,
  formatJVMDiagnosticChunksForDisplay,
  formatJVMDiagnosticCommandTypeLabel,
  formatJVMDiagnosticEventLabel,
  formatJVMDiagnosticPhaseLabel,
  formatJVMDiagnosticRiskLabel,
  formatJVMDiagnosticSourceLabel,
  formatJVMDiagnosticTransportLabel,
  groupJVMDiagnosticPresets,
  redactJVMDiagnosticOutput,
  resolveJVMDiagnosticRiskColor,
} from "./jvmDiagnosticPresentation";

describe("jvmDiagnosticPresentation", () => {

  it("uses translator values for diagnostic presentation labels and preset descriptions", () => {
    const translate = (key: string) =>
      ({
        "jvm_diagnostic.presentation.category.observe": "Observation commands",
        "jvm_diagnostic.presentation.category.trace": "Trace commands",
        "jvm_diagnostic.presentation.category.mutating": "High-risk commands",
        "jvm_diagnostic.presentation.phase.running": "Running",
        "jvm_diagnostic.presentation.phase.completed": "Completed",
        "jvm_diagnostic.presentation.event.done": "Execution finished",
        "jvm_diagnostic.presentation.risk.high": "High risk",
        "jvm_diagnostic.presentation.command_type.trace": "Trace",
        "jvm_diagnostic.presentation.source.ai_plan": "AI plan",
        "jvm_diagnostic.presentation.fallback.unknown": "Unknown",
        "jvm_diagnostic.presentation.chunk.empty_event": "Empty event",
        "jvm_diagnostic.completion.preset.thread-top.documentation":
          "Inspect the busiest threads.",
      })[key] || key;

    const groups = groupJVMDiagnosticPresets(undefined, translate);
    expect(formatJVMDiagnosticPhaseLabel("completed", translate)).toBe("Completed");
    expect(formatJVMDiagnosticEventLabel("done", translate)).toBe("Execution finished");
    expect(formatJVMDiagnosticRiskLabel("high", translate)).toBe("High risk");
    expect(formatJVMDiagnosticCommandTypeLabel("trace", translate)).toBe("Trace");
    expect(formatJVMDiagnosticSourceLabel("ai-plan", translate)).toBe("AI plan");
    expect(formatJVMDiagnosticPhaseLabel(undefined, translate)).toBe("Unknown");
    expect(formatJVMDiagnosticChunkText({ sessionId: "sess-1" }, translate)).toBe(
      "Empty event",
    );
  });

  it("formats chunk text with localized phase prefix when content exists", () => {
    expect(
      formatJVMDiagnosticChunkText({
        sessionId: "sess-1",
        phase: "running",
        content: "thread -n 5",
      }),
    ).toBe("Running: thread -n 5");
  });

  it("redacts sensitive values in diagnostic output chunks", () => {
    const text = formatJVMDiagnosticChunkText({
      sessionId: "sess-1",
      phase: "running",
      content:
        "password=secret-token\napiKey: api-key-secret\naccessToken = bearer-secret\nPRIVATE_KEY=-----BEGIN PRIVATE KEY-----raw-key",
    });

    expect(text).toContain("password=********");
    expect(text).toContain("apiKey: ********");
    expect(text).toContain("accessToken = ********");
    expect(text).toContain("PRIVATE_KEY=********");
    expect(text).not.toContain("secret-token");
    expect(text).not.toContain("api-key-secret");
    expect(text).not.toContain("bearer-secret");
    expect(text).not.toContain("raw-key");
  });

  it("redacts JSON, environment, separator and partial PEM sensitive output", () => {
    const text = redactJVMDiagnosticOutput([
      '{"password":"json-secret","api_key":"api-json-secret","accessToken":"access-json-secret"}',
      "DB_PASSWORD=hunter2",
      "SPRING_DATASOURCE_PASSWORD=spring-secret",
      "AWS_SECRET_ACCESS_KEY=aws-secret",
      "api-key: kebab-secret",
      "api key = spaced-secret",
      "private.key: dot-secret",
      "refresh_token=refresh-secret",
      "secret=foo;bar",
      "PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\nraw-key-line",
    ].join("\n"));

    expect(text).toContain('"password":"********"');
    expect(text).toContain('"api_key":"********"');
    expect(text).toContain('"accessToken":"********"');
    expect(text).toContain("DB_PASSWORD=********");
    expect(text).toContain("SPRING_DATASOURCE_PASSWORD=********");
    expect(text).toContain("AWS_SECRET_ACCESS_KEY=********");
    expect(text).toContain("api-key: ********");
    expect(text).toContain("api key = ********");
    expect(text).toContain("private.key: ********");
    expect(text).toContain("refresh_token=********");
    expect(text).toContain("secret=********");
    expect(text).toContain("PRIVATE_KEY=********");
    expect(text).not.toContain("json-secret");
    expect(text).not.toContain("api-json-secret");
    expect(text).not.toContain("access-json-secret");
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("spring-secret");
    expect(text).not.toContain("aws-secret");
    expect(text).not.toContain("kebab-secret");
    expect(text).not.toContain("spaced-secret");
    expect(text).not.toContain("dot-secret");
    expect(text).not.toContain("refresh-secret");
    expect(text).not.toContain("foo;bar");
    expect(text).not.toContain("raw-key-line");
  });

  it("redacts PEM continuation across diagnostic chunks", () => {
    const texts = formatJVMDiagnosticChunksForDisplay([
      {
        sessionId: "sess-1",
        phase: "running",
        content: "PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\nabc123",
      },
      {
        sessionId: "sess-1",
        phase: "running",
        content: "def456\n-----END PRIVATE KEY-----",
      },
      {
        sessionId: "sess-1",
        phase: "running",
        content: "thread_name=main",
      },
    ]);

    expect(texts.join("\n")).not.toContain("abc123");
    expect(texts.join("\n")).not.toContain("def456");
    expect(texts.join("\n")).not.toContain("PRIVATE KEY");
    expect(texts[2]).toContain("thread_name=main");
  });

  it("redacts PEM begin marker split across diagnostic chunks", () => {
    const texts = formatJVMDiagnosticChunksForDisplay([
      {
        sessionId: "sess-1",
        phase: "running",
        content: "PRIVATE_KEY=-----BEGIN PRIV",
      },
      {
        sessionId: "sess-1",
        phase: "running",
        content: "ATE KEY-----\nabc123\n-----END PRIVATE KEY-----",
      },
      {
        sessionId: "sess-1",
        phase: "running",
        content: "thread_name=main",
      },
    ]);

    expect(texts.join("\n")).not.toContain("BEGIN PRIV");
    expect(texts.join("\n")).not.toContain("ATE KEY");
    expect(texts.join("\n")).not.toContain("abc123");
    expect(texts[2]).toContain("thread_name=main");
  });

  it("redacts algorithm-prefixed PEM begin marker split across chunks", () => {
    const texts = formatJVMDiagnosticChunksForDisplay([
      {
        sessionId: "sess-1",
        phase: "running",
        content: "-----BEGIN RSA PRIV",
      },
      {
        sessionId: "sess-1",
        phase: "running",
        content: "ATE KEY-----\nabc123\n-----END RSA PRIVATE KEY-----",
      },
      {
        sessionId: "sess-1",
        phase: "running",
        content: "thread_name=main",
      },
    ]);

    expect(texts.join("\n")).not.toContain("RSA PRIV");
    expect(texts.join("\n")).not.toContain("ATE KEY");
    expect(texts.join("\n")).not.toContain("abc123");
    expect(texts[2]).toContain("thread_name=main");
  });

  it("redacts algorithm-prefixed PEM markers split after the algorithm and inside key labels", () => {
    const cases = [
      ["-----BEGIN RSA", " PRIVATE KEY-----\nabc123\n-----END RSA PRIVATE KEY-----"],
      ["-----BEGIN RSA PRIVATE K", "EY-----\nabc123\n-----END RSA PRIVATE KEY-----"],
      ["-----BEGIN OPENSSH", " PRIVATE KEY-----\nabc123\n-----END OPENSSH PRIVATE KEY-----"],
      ["-----BEGIN EC PRIVATE KE", "Y-----\nabc123\n-----END EC PRIVATE KEY-----"],
    ];

    for (const [firstChunk, secondChunk] of cases) {
      const texts = formatJVMDiagnosticChunksForDisplay([
        {
          sessionId: "sess-1",
          phase: "running",
          content: firstChunk,
        },
        {
          sessionId: "sess-1",
          phase: "running",
          content: secondChunk,
        },
      ]);

      expect(texts.join("\n")).not.toContain("PRIVATE K");
      expect(texts.join("\n")).not.toContain("EY-----");
      expect(texts.join("\n")).not.toContain("abc123");
    }
  });

  it("redacts JSON scalar values and URL query parameters", () => {
    const text = redactJVMDiagnosticOutput(
      '{"password":123456,"token":true,"credential":null}\nhttps://svc.local/callback?access_token=url-secret&x=1&api_key=query-secret',
    );

    expect(text).toContain('"password":********');
    expect(text).toContain('"token":********');
    expect(text).toContain('"credential":********');
    expect(text).toContain("access_token=********");
    expect(text).toContain("api_key=********");
    expect(text).not.toContain("123456");
    expect(text).not.toContain("true");
    expect(text).not.toContain("url-secret");
    expect(text).not.toContain("query-secret");
  });

  it("redacts authorization values across text, JSON and query parameters", () => {
    const text = redactJVMDiagnosticOutput(
      'Authorization: Bearer header-secret\n{"authorization":"Bearer json-secret"}\nhttps://svc.local/callback?authorization=Bearer%20query-secret',
    );

    expect(text).toContain("Authorization: ********");
    expect(text).toContain('"authorization":"********"');
    expect(text).toContain("authorization=********");
    expect(text).not.toContain("header-secret");
    expect(text).not.toContain("json-secret");
    expect(text).not.toContain("query-secret");
  });

  it("keeps non-sensitive diagnostic output unchanged", () => {
    expect(
      redactJVMDiagnosticOutput(
        "thread_name=main\nmethod: com.foo.OrderService.submit\ncost=42ms",
      ),
    ).toBe("thread_name=main\nmethod: com.foo.OrderService.submit\ncost=42ms");
  });

  it("localizes diagnostic status, transport, risk and source labels", () => {
    expect(formatJVMDiagnosticPhaseLabel("completed")).toBe("Completed");
    expect(formatJVMDiagnosticTransportLabel("arthas-tunnel")).toBe("Arthas Tunnel");
    expect(formatJVMDiagnosticRiskLabel("high")).toBe("High risk");
    expect(formatJVMDiagnosticCommandTypeLabel("trace")).toBe("Trace");
    expect(formatJVMDiagnosticSourceLabel("ai-plan")).toBe("AI plan");
  });

  it("maps risk levels to tag colors", () => {
    expect(resolveJVMDiagnosticRiskColor("low")).toBe("green");
    expect(resolveJVMDiagnosticRiskColor("medium")).toBe("gold");
    expect(resolveJVMDiagnosticRiskColor("high")).toBe("red");
  });
});
