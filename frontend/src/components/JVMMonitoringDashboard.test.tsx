import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { I18nProvider } from "../i18n/provider";
import JVMMonitoringDashboard from "./JVMMonitoringDashboard";

vi.mock("../store", () => ({
  useStore: (selector: (state: any) => any) =>
    selector({
      theme: "light",
      connections: [
        {
          id: "conn-1",
          name: "orders-jvm",
          config: {
            host: "orders.internal",
            port: 9010,
            jvm: {
              preferredMode: "jmx",
              allowedModes: ["jmx"],
            },
          },
        },
      ],
    }),
}));

const renderDashboard = () =>
  renderToStaticMarkup(
    <I18nProvider
      preference="en-US"
      systemLanguages={["en-US"]}
      onPreferenceChange={() => undefined}
    >
      <JVMMonitoringDashboard
        tab={{
          id: "tab-monitor-1",
          title: "持续监控",
          type: "jvm-monitoring",
          connectionId: "conn-1",
          providerMode: "jmx",
        }}
      />
    </I18nProvider>,
  );

describe("JVMMonitoringDashboard", () => {
  it("shows start action and empty-state guidance before monitoring starts", () => {
    const markup = renderDashboard();

    expect(markup).toContain("Continuous JVM monitoring");
    expect(markup).toContain("Stopped");
    expect(markup).toContain("Refresh");
    expect(markup).toContain("Start monitoring");
    expect(markup).toContain("Continuous monitoring has not started yet");
    expect(markup).toContain(
      "After you click &quot;Start monitoring&quot;, GoNavi keeps sampling results for this connection in the current session; switching tabs does not stop sampling.",
    );
    expect(markup).toContain("Heap memory");
    expect(markup).toContain("No heap memory samples yet.");
    expect(markup).not.toContain("堆内存");
    expect(markup).not.toContain("暂无堆内存采样数据");
    expect(markup).not.toContain("暂无 Heap 采样数据");
    expect(markup).not.toContain("当前 provider 未提供 Heap 指标");
  });

  it("renders a dedicated vertical scroll shell for tall monitoring content", () => {
    const markup = renderDashboard();

    expect(markup).toContain('data-jvm-monitoring-dashboard-scroll-shell="true"');
    expect(markup).toContain("height:100%");
    expect(markup).toContain("overflow-y:auto");
  });

  it("stacks monitoring charts before detail panels so charts keep full content width", () => {
    const markup = renderDashboard();

    expect(markup).toContain('data-jvm-monitoring-content-stack="true"');
    expect(markup).toContain("gap:24px");
    expect(markup).not.toContain("minmax(min(100%, 320px), 1fr)");
  });
});
