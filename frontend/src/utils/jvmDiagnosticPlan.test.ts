import { describe, expect, it } from "vitest";
import fs from "node:fs";

import {
  parseJVMDiagnosticPlan,
  resolveJVMDiagnosticPlanTargetTabId,
} from "./jvmDiagnosticPlan";

describe("jvmDiagnosticPlan", () => {
  it("parses arthas-style diagnostic plan payload", () => {
    const plan = parseJVMDiagnosticPlan(`{
      "intent": "trace_slow_method",
      "transport": "agent-bridge",
      "command": "trace com.foo.OrderService submitOrder '#cost > 100'",
      "riskLevel": "medium",
      "reason": "定位慢调用"
    }`);

    expect(plan?.command).toContain("trace com.foo.OrderService");
    expect(plan?.riskLevel).toBe("medium");
  });

  it("parses fenced json blocks mixed with analysis text", () => {
    const plan = parseJVMDiagnosticPlan(
      [
        "建议先观察再做下一步：",
        "```json",
        '{"intent":"dump_threads","transport":"arthas-tunnel","command":"thread -n 5","riskLevel":"low","reason":"观察阻塞线程","expectedSignals":["Top N busy threads"]}',
        "```",
      ].join("\n"),
    );

    expect(plan).toEqual({
      intent: "dump_threads",
      transport: "arthas-tunnel",
      command: "thread -n 5",
      riskLevel: "low",
      reason: "观察阻塞线程",
      expectedSignals: ["Top N busy threads"],
    });
  });

  it("returns null for malformed diagnostic payload", () => {
    expect(parseJVMDiagnosticPlan('{"command":1}')).toBeNull();
  });

  it("localizes the fallback reason when the AI plan omits reason", () => {
    const plan = parseJVMDiagnosticPlan(
      '{"intent":"generic_diagnostic","command":"thread -n 5"}',
      (key, params) => {
        expect(key).toBe("jvm_diagnostic.ai_plan.default_reason");
        return `AI diagnostic plan: ${params?.intent}`;
      },
    );

    expect(plan?.reason).toBe("AI diagnostic plan: generic_diagnostic");
  });
});

describe("resolveJVMDiagnosticPlanTargetTabId", () => {
  it("prefers the original diagnostic tab when context still matches", () => {
    expect(
      resolveJVMDiagnosticPlanTargetTabId(
        [
          {
            id: "tab-diagnostic",
            title: "诊断控制台",
            type: "jvm-diagnostic",
            connectionId: "conn-orders",
          },
        ],
        [
          {
            id: "conn-orders",
            config: {
              type: "jvm",
              host: "orders.internal",
              port: 9010,
              user: "",
              jvm: {
                diagnostic: {
                  transport: "agent-bridge",
                },
              },
            },
          },
        ],
        {
          tabId: "tab-diagnostic",
          connectionId: "conn-orders",
          transport: "agent-bridge",
        },
      ),
    ).toBe("tab-diagnostic");
  });

  it("rejects fallback tabs whose connection transport does not match", () => {
    expect(
      resolveJVMDiagnosticPlanTargetTabId(
        [
          {
            id: "tab-diagnostic",
            title: "诊断控制台",
            type: "jvm-diagnostic",
            connectionId: "conn-orders",
          },
        ],
        [
          {
            id: "conn-orders",
            config: {
              type: "jvm",
              host: "orders.internal",
              port: 9010,
              user: "",
              jvm: {
                diagnostic: {
                  transport: "arthas-tunnel",
                },
              },
            },
          },
        ],
        {
          tabId: "tab-missing",
          connectionId: "conn-orders",
          transport: "agent-bridge",
        },
      ),
    ).toBe("");
  });
});
